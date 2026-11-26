"""Encrypted Colab account pool, balance polling, and rollover scheduling."""

from __future__ import annotations

import json
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status

from app.api.events import EventBus
from app.colab.gateway import ColabGateway, CredentialsInvalidError
from app.config import Settings
from app.db import Database
from app.security.crypto import SecretBox


def _validate_adc_payload(adc_json: dict[str, Any]) -> None:
    if adc_json.get("type") != "authorized_user":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ADC JSON must have type='authorized_user'",
        )
    for field in ("client_id", "client_secret", "refresh_token"):
        val = adc_json.get(field)
        if not isinstance(val, str) or not val.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"ADC JSON missing non-empty '{field}'",
            )


def _sanitize_account_row(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "label": str(row["label"]),
        "email": str(row["email"]),
        "priority": int(row["priority"]),
        "min_balance_cu": float(row["min_balance_cu"]),
        "unsupported_gpus": json.loads(row["unsupported_gpus"]),
        "last_balance_cu": row["last_balance_cu"],
        "last_rate_hr": row["last_rate_hr"],
        "last_assignments": row["last_assignments"],
        "enabled": bool(row["enabled"]),
        "last_checked_at": row["last_checked_at"],
        "created_at": str(row["created_at"]),
    }


class AccountPool:
    """Manages encrypted ADC accounts, isolated homes, and rollover selection."""

    def __init__(
        self,
        *,
        db: Database,
        crypto: SecretBox,
        gateway: ColabGateway,
        settings: Settings,
        events: EventBus,
    ) -> None:
        self.db = db
        self.crypto = crypto
        self.gateway = gateway
        self.settings = settings
        self.events = events

    async def add_account(
        self,
        *,
        label: str,
        adc_json: dict[str, Any],
        priority: int = 100,
        min_balance_cu: float = 5.0,
    ) -> dict[str, Any]:
        _validate_adc_payload(adc_json)
        try:
            email, ccu = await self.gateway.verify_adc_credentials(adc_json)
        except CredentialsInvalidError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc

        account_id = str(uuid.uuid4())
        home_dir = self.settings.accounts_dir / account_id / "home"
        self.gateway.prepare_account_home(home_dir, adc_json)

        cred_encrypted = self.crypto.encrypt_json(adc_json)
        now = datetime.now(UTC).isoformat()

        await self.db.execute(
            """
            INSERT INTO colab_accounts (
                id, label, email, cred_encrypted, home_dir,
                priority, min_balance_cu, unsupported_gpus,
                last_balance_cu, last_rate_hr, last_assignments,
                enabled, last_checked_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 1, ?, ?)
            """,
            (
                account_id,
                label.strip(),
                email,
                cred_encrypted,
                str(home_dir),
                priority,
                min_balance_cu,
                ccu.balance_cu,
                ccu.rate_hr,
                ccu.assignments_count,
                now,
                now,
            ),
        )
        account = await self.get_account(account_id)
        await self.events.publish("pool.updated", {"reason": "account_added"})
        return account

    async def list_accounts(self) -> list[dict[str, Any]]:
        rows = await self.db.fetchall(
            "SELECT * FROM colab_accounts ORDER BY priority ASC, created_at ASC"
        )
        return [_sanitize_account_row(r) for r in rows]

    async def get_account(self, account_id: str) -> dict[str, Any]:
        row = await self.db.fetchone(
            "SELECT * FROM colab_accounts WHERE id = ?", (account_id,)
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Colab account not found",
            )
        return _sanitize_account_row(row)

    async def get_decrypted_adc(self, account_id: str) -> tuple[dict[str, Any], Path]:
        row = await self.db.fetchone(
            "SELECT cred_encrypted, home_dir FROM colab_accounts WHERE id = ?",
            (account_id,),
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Colab account not found",
            )
        adc = self.crypto.decrypt_json(str(row["cred_encrypted"]))
        return adc, Path(str(row["home_dir"]))

    async def update_account(
        self,
        account_id: str,
        *,
        label: str | None = None,
        priority: int | None = None,
        min_balance_cu: float | None = None,
        enabled: bool | None = None,
        reset_unsupported_gpus: bool = False,
    ) -> dict[str, Any]:
        current = await self.get_account(account_id)
        new_label = label.strip() if label is not None else current["label"]
        new_priority = priority if priority is not None else current["priority"]
        new_min = min_balance_cu if min_balance_cu is not None else current["min_balance_cu"]
        new_enabled = (
            (1 if enabled else 0)
            if enabled is not None
            else (1 if current["enabled"] else 0)
        )
        new_unsupported = (
            "[]" if reset_unsupported_gpus else json.dumps(current["unsupported_gpus"])
        )

        await self.db.execute(
            """
            UPDATE colab_accounts
            SET label = ?, priority = ?, min_balance_cu = ?, enabled = ?, unsupported_gpus = ?
            WHERE id = ?
            """,
            (new_label, new_priority, new_min, new_enabled, new_unsupported, account_id),
        )
        updated = await self.get_account(account_id)
        await self.events.publish("pool.updated", {"reason": "account_updated"})
        return updated

    async def delete_account(self, account_id: str) -> None:
        row = await self.db.fetchone(
            "SELECT id, home_dir FROM colab_accounts WHERE id = ?", (account_id,)
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Colab account not found",
            )
        active = await self.db.fetchone(
            """
            SELECT id FROM workers
            WHERE account_id = ?
              AND origin = 'managed'
              AND status IN ('assigning', 'bootstrapping', 'ready', 'stopping')
            """,
            (account_id,),
        )
        if active is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot delete account with an active managed worker",
            )

        home_dir = Path(str(row["home_dir"]))
        await self.db.execute("DELETE FROM workers WHERE account_id = ?", (account_id,))
        await self.db.execute("DELETE FROM colab_accounts WHERE id = ?", (account_id,))
        shutil.rmtree(home_dir.parent, ignore_errors=True)
        await self.events.publish("pool.updated", {"reason": "account_deleted"})

    async def mark_gpu_unsupported(self, account_id: str, gpu_type: str) -> None:
        acc = await self.get_account(account_id)
        gpus = list(acc["unsupported_gpus"])
        gpu = gpu_type.strip().upper()
        if gpu not in gpus:
            gpus.append(gpu)
            await self.db.execute(
                "UPDATE colab_accounts SET unsupported_gpus = ? WHERE id = ?",
                (json.dumps(gpus), account_id),
            )

    async def refresh_balances(self) -> list[dict[str, Any]]:
        rows = await self.db.fetchall(
            "SELECT id, cred_encrypted FROM colab_accounts WHERE enabled = 1"
        )
        now = datetime.now(UTC).isoformat()
        for row in rows:
            account_id = str(row["id"])
            try:
                adc = self.crypto.decrypt_json(str(row["cred_encrypted"]))
                ccu = await self.gateway.get_usage(adc)
                await self.db.execute(
                    """
                    UPDATE colab_accounts
                    SET last_balance_cu = ?,
                        last_rate_hr = ?,
                        last_assignments = ?,
                        last_checked_at = ?
                    WHERE id = ?
                    """,
                    (ccu.balance_cu, ccu.rate_hr, ccu.assignments_count, now, account_id),
                )
            except Exception:
                await self.db.execute(
                    "UPDATE colab_accounts SET last_checked_at = ? WHERE id = ?",
                    (now, account_id),
                )
        accounts = await self.list_accounts()
        await self.events.publish("pool.updated", {"reason": "balances_refreshed"})
        return accounts

    async def select_candidates(self, gpu_type: str = "L4") -> list[dict[str, Any]]:
        """Rollover selection: ordered by priority ASC, balance DESC, above min_balance_cu."""
        gpu = gpu_type.strip().upper()
        rows = await self.db.fetchall(
            """
            SELECT * FROM colab_accounts
            WHERE enabled = 1
              AND (last_balance_cu IS NULL OR last_balance_cu >= min_balance_cu)
            ORDER BY priority ASC, COALESCE(last_balance_cu, 0.0) DESC, created_at ASC
            """
        )
        candidates: list[dict[str, Any]] = []
        for r in rows:
            acc = _sanitize_account_row(r)
            if gpu not in acc["unsupported_gpus"]:
                candidates.append(acc)
        return candidates

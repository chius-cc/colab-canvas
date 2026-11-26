"""Runtime reconciler: tracks managed workers and exposes external notebooks read-only."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from app.api.events import EventBus
from app.colab.account_pool import AccountPool
from app.colab.gateway import ColabGateway, RemoteAssignment
from app.db import Database


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    except ValueError:
        return None


class Reconciler:
    """Synchronizes DB worker state with live Colab backend assignments.

    Invariant #3: ONLY workers with `origin='managed'` may ever be unassigned.
    Unknown remote sessions are recorded as `origin='external'` for visibility only.
    """

    def __init__(
        self,
        *,
        db: Database,
        account_pool: AccountPool,
        gateway: ColabGateway,
        events: EventBus,
        idle_timeout_seconds: int = 900,
    ) -> None:
        self.db = db
        self.account_pool = account_pool
        self.gateway = gateway
        self.events = events
        self.idle_timeout_seconds = idle_timeout_seconds

    async def reconcile_once(
        self,
        *,
        active_managed_endpoints: set[str] | None = None,
        cleanup_unowned_managed: bool = False,
    ) -> dict[str, int]:
        live_owned = active_managed_endpoints or set()
        now = datetime.now(UTC)
        now_iso = now.isoformat()

        remote_by_account: dict[str, list[RemoteAssignment]] = {}
        remote_endpoints: set[str] = set()
        accounts = await self.account_pool.list_accounts()

        for acc in accounts:
            if not acc["enabled"]:
                continue
            acc_id = acc["id"]
            try:
                adc, _ = await self.account_pool.get_decrypted_adc(acc_id)
                assignments = await self.gateway.list_assignments(adc)
                remote_by_account[acc_id] = assignments
                for item in assignments:
                    remote_endpoints.add(item.endpoint)
            except Exception:
                # Skip account if transient API failure occurs so we don't mark live workers stopped
                remote_by_account.pop(acc_id, None)

        # 1. Mark DB workers whose endpoint disappeared on queried accounts as stopped
        db_active = await self.db.fetchall(
            """
            SELECT * FROM workers
            WHERE status IN ('assigning', 'bootstrapping', 'ready', 'stopping')
            """
        )
        tracked_endpoints: set[str] = set()
        stopped_count = 0
        orphan_cleaned = 0

        for w in db_active:
            endpoint = str(w["endpoint"])
            acc_id = str(w["account_id"])
            origin = str(w["origin"])
            tracked_endpoints.add(endpoint)

            if acc_id in remote_by_account and endpoint not in remote_endpoints:
                await self.db.execute(
                    "UPDATE workers SET status = 'stopped', stopped_at = ? WHERE id = ?",
                    (now_iso, w["id"]),
                )
                stopped_count += 1
                continue

            # Only touch origin='managed' workers not currently supervised in memory
            if origin == "managed" and endpoint not in live_owned:
                ref_dt = (
                    _parse_iso(w["last_heartbeat_at"])
                    or _parse_iso(w["last_activity_at"])
                    or _parse_iso(w["started_at"])
                )
                stale_seconds = (
                    (now - ref_dt).total_seconds()
                    if ref_dt
                    else self.idle_timeout_seconds + 1
                )
                if cleanup_unowned_managed or stale_seconds >= self.idle_timeout_seconds:
                    try:
                        adc, _ = await self.account_pool.get_decrypted_adc(acc_id)
                        await self.gateway.unassign(adc, endpoint)
                        await self.db.execute(
                            "UPDATE workers SET status = 'stopped', stopped_at = ? WHERE id = ?",
                            (now_iso, w["id"]),
                        )
                        orphan_cleaned += 1
                    except Exception:
                        pass

        # 2. Record any unknown remote assignments as origin='external' (NEVER unassign!)
        external_discovered = 0
        for acc_id, assignments in remote_by_account.items():
            for item in assignments:
                if item.endpoint in tracked_endpoints:
                    continue
                existing = await self.db.fetchone(
                    "SELECT id FROM workers WHERE endpoint = ?", (item.endpoint,)
                )
                if existing is not None:
                    await self.db.execute(
                        """
                        UPDATE workers
                        SET origin = 'external',
                            status = 'ready',
                            stopped_at = NULL,
                            last_activity_at = ?
                        WHERE id = ?
                        """,
                        (now_iso, existing["id"]),
                    )
                else:
                    await self.db.execute(
                        """
                        INSERT INTO workers (
                            id, account_id, endpoint, session_name, origin,
                            gpu_type, status, comfy_port, watchdog_port, cached_files,
                            started_at, last_heartbeat_at, last_activity_at, stopped_at
                        ) VALUES (
                            ?, ?, ?, ?, 'external',
                            ?, 'ready', NULL, NULL, '[]',
                            ?, NULL, ?, NULL
                        )
                        """,
                        (
                            str(uuid.uuid4()),
                            acc_id,
                            item.endpoint,
                            f"external-{item.endpoint[-6:]}",
                            item.accelerator,
                            now_iso,
                            now_iso,
                        ),
                    )
                external_discovered += 1

        # 3. Fail jobs left in booting/running without an active managed worker
        failed_stale_jobs = 0
        if cleanup_unowned_managed or not live_owned:
            stale_jobs = await self.db.fetchall(
                """
                SELECT j.id FROM jobs j
                LEFT JOIN workers w ON w.id = j.worker_id
                WHERE j.status IN ('booting', 'running')
                  AND (w.id IS NULL OR w.status NOT IN ('assigning', 'bootstrapping', 'ready'))
                """
            )
            for sj in stale_jobs:
                await self.db.execute(
                    """
                    UPDATE jobs
                    SET status = 'failed', error_msg = ?, finished_at = ?
                    WHERE id = ?
                    """,
                    ("Worker stopped before job completion", now_iso, sj["id"]),
                )
                failed_stale_jobs += 1

        summary: dict[str, Any] = {
            "stopped_count": stopped_count,
            "orphan_cleaned": orphan_cleaned,
            "external_discovered": external_discovered,
            "failed_stale_jobs": failed_stale_jobs,
        }
        await self.events.publish("pool.updated", {"reason": "reconciled", **summary})
        return summary

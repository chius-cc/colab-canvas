"""User provisioning, invite codes, and quota enforcement."""

from __future__ import annotations

import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status

from app.auth.passwords import hash_password, verify_password
from app.config import Settings
from app.db import Database

ALLOWED_GPU_CHOICES: tuple[str, ...] = ("L4", "A100", "G4")


@dataclass(frozen=True)
class UserRecord:
    id: str
    email: str
    username: str
    role: str
    daily_quota: int
    max_queued: int
    allowed_gpus: tuple[str, ...]
    created_at: str
    has_password: bool = True

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def row_to_user(row) -> UserRecord:
    gpus = tuple(json.loads(row["allowed_gpus"]))
    return UserRecord(
        id=row["id"],
        email=row["email"],
        username=row["username"],
        role=row["role"],
        daily_quota=int(row["daily_quota"]),
        max_queued=int(row["max_queued"]),
        allowed_gpus=gpus,
        created_at=row["created_at"],
        has_password=bool(row["password_hash"]),
    )


def validate_allowed_gpus(gpus: list[str]) -> list[str]:
    """Validate GPU allowlist; T4 is forbidden per architecture Invariant #8."""
    cleaned: list[str] = []
    for raw in gpus:
        gpu = raw.strip().upper()
        if gpu == "T4":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="T4 GPU is disabled (no native BF16 support for Anima)",
            )
        if gpu not in ALLOWED_GPU_CHOICES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported GPU '{gpu}'. Allowed: {', '.join(ALLOWED_GPU_CHOICES)}",
            )
        if gpu not in cleaned:
            cleaned.append(gpu)
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one GPU must be allowed",
        )
    return cleaned


async def count_users(db: Database) -> int:
    row = await db.fetchone("SELECT COUNT(*) AS cnt FROM users")
    return int(row["cnt"]) if row else 0


async def get_user_by_id(db: Database, user_id: str) -> UserRecord | None:
    row = await db.fetchone("SELECT * FROM users WHERE id = ?", (user_id,))
    return row_to_user(row) if row else None


async def ensure_initial_admin(db: Database, settings: Settings) -> UserRecord | None:
    email = settings.initial_admin_email.strip().lower()
    password = settings.initial_admin_password
    if not email or not password:
        return None

    existing = await db.fetchone("SELECT * FROM users WHERE email = ?", (email,))
    if existing is not None:
        return row_to_user(existing)

    if await count_users(db) > 0:
        return None

    user_id = str(uuid.uuid4())
    now = utc_now_iso()
    username = settings.initial_admin_username.strip() or email.split("@", 1)[0]
    pw_hash = hash_password(password)
    await db.execute(
        """
        INSERT INTO users (
            id, email, username, password_hash, role,
            daily_quota, max_queued, allowed_gpus, created_at
        )
        VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?)
        """,
        (
            user_id,
            email,
            username,
            pw_hash,
            0,  # 0 = unlimited for initial admin by default
            max(settings.default_max_queued, 4),
            json.dumps(list(ALLOWED_GPU_CHOICES)),
            now,
        ),
    )
    user = await get_user_by_id(db, user_id)
    assert user is not None
    return user


async def setup_first_admin(
    db: Database,
    settings: Settings,
    *,
    email: str,
    username: str,
    password: str,
) -> UserRecord:
    clean_email = email.strip().lower()
    clean_username = username.strip()
    pw_hash = hash_password(password)
    user_id = str(uuid.uuid4())
    now = utc_now_iso()

    async with db.transaction() as conn:
        cur = await conn.execute("SELECT COUNT(*) AS cnt FROM users")
        row = await cur.fetchone()
        if row and int(row["cnt"]) > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Initial admin already configured",
            )
        await conn.execute(
            """
            INSERT INTO users (
                id, email, username, password_hash, role,
                daily_quota, max_queued, allowed_gpus, created_at
            )
            VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?)
            """,
            (
                user_id,
                clean_email,
                clean_username,
                pw_hash,
                0,
                max(settings.default_max_queued, 4),
                json.dumps(list(ALLOWED_GPU_CHOICES)),
                now,
            ),
        )
    user = await get_user_by_id(db, user_id)
    assert user is not None
    return user


async def authenticate_local(db: Database, identifier: str, password: str) -> UserRecord | None:
    ident = identifier.strip()
    row = await db.fetchone(
        "SELECT * FROM users WHERE lower(email) = lower(?) OR username = ?",
        (ident, ident),
    )
    if row is None or not row["password_hash"]:
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    return row_to_user(row)


async def change_local_password(
    db: Database,
    *,
    user_id: str,
    current_password: str,
    new_password: str,
) -> None:
    row = await db.fetchone("SELECT password_hash FROM users WHERE id = ?", (user_id,))
    if row is None or not row["password_hash"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password change is unavailable for SSO-only accounts",
        )
    if not verify_password(current_password, str(row["password_hash"])):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )
    await db.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (hash_password(new_password), user_id),
    )


async def register_with_invite(
    db: Database,
    settings: Settings,
    *,
    invite_code: str,
    email: str,
    username: str,
    password: str,
) -> UserRecord:
    clean_code = invite_code.strip()
    clean_email = email.strip().lower()
    clean_username = username.strip()
    pw_hash = hash_password(password)
    user_id = str(uuid.uuid4())
    now = utc_now_iso()

    async with db.transaction() as conn:
        cur = await conn.execute(
            """
            UPDATE invite_codes
            SET used_count = used_count + 1
            WHERE code = ?
              AND disabled = 0
              AND used_count < max_uses
              AND (expires_at IS NULL OR expires_at > ?)
            """,
            (clean_code, now),
        )
        if cur.rowcount != 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid, expired, or exhausted invite code",
            )

        dup = await (
            await conn.execute(
                "SELECT id FROM users WHERE lower(email) = ? OR username = ?",
                (clean_email, clean_username),
            )
        ).fetchone()
        if dup is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email or username already exists",
            )

        await conn.execute(
            """
            INSERT INTO users (
                id, email, username, password_hash, role,
                daily_quota, max_queued, allowed_gpus, created_at
            )
            VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)
            """,
            (
                user_id,
                clean_email,
                clean_username,
                pw_hash,
                settings.default_daily_quota,
                settings.default_max_queued,
                json.dumps(["L4"]),
                now,
            ),
        )

    user = await get_user_by_id(db, user_id)
    assert user is not None
    return user


async def provision_or_get_cf_user(
    db: Database, settings: Settings, email: str
) -> UserRecord:
    clean_email = email.strip().lower()
    existing = await db.fetchone("SELECT * FROM users WHERE lower(email) = ?", (clean_email,))
    if existing is not None:
        return row_to_user(existing)

    async with db.transaction() as conn:
        again = await (
            await conn.execute("SELECT * FROM users WHERE lower(email) = ?", (clean_email,))
        ).fetchone()
        if again is not None:
            return row_to_user(again)

        cnt_row = await (await conn.execute("SELECT COUNT(*) AS cnt FROM users")).fetchone()
        is_first = (cnt_row is not None and int(cnt_row["cnt"]) == 0)
        is_designated_admin = (
            bool(settings.initial_admin_email.strip())
            and clean_email == settings.initial_admin_email.strip().lower()
        )
        role = "admin" if (is_first or is_designated_admin) else "member"

        base_username = clean_email.split("@", 1)[0]
        username = base_username
        dup = await (
            await conn.execute("SELECT id FROM users WHERE username = ?", (username,))
        ).fetchone()
        if dup is not None:
            username = f"{base_username}-{secrets.token_hex(3)}"

        user_id = str(uuid.uuid4())
        max_q = (
            max(settings.default_max_queued, 4)
            if role == "admin"
            else settings.default_max_queued
        )
        await conn.execute(
            """
            INSERT INTO users (
                id, email, username, password_hash, role,
                daily_quota, max_queued, allowed_gpus, created_at
            )
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                clean_email,
                username,
                role,
                0 if role == "admin" else settings.default_daily_quota,
                max_q,
                json.dumps(list(ALLOWED_GPU_CHOICES) if role == "admin" else ["L4"]),
                utc_now_iso(),
            ),
        )

    user = await get_user_by_id(db, user_id)
    assert user is not None
    return user


async def create_invite_code(
    db: Database,
    *,
    created_by: str,
    max_uses: int = 1,
    expires_in_hours: int | None = None,
) -> dict:
    code = f"cc-{secrets.token_urlsafe(8)}"
    now = datetime.now(UTC)
    expires_at = (
        (now + timedelta(hours=expires_in_hours)).isoformat()
        if expires_in_hours is not None
        else None
    )
    await db.execute(
        """
        INSERT INTO invite_codes (
            code, created_by, max_uses, used_count, expires_at, disabled, created_at
        )
        VALUES (?, ?, ?, 0, ?, 0, ?)
        """,
        (code, created_by, max_uses, expires_at, now.isoformat()),
    )
    row = await db.fetchone("SELECT * FROM invite_codes WHERE code = ?", (code,))
    assert row is not None
    return dict(row)


class QuotaService:
    """Enforces per-user batch, queue depth, daily quota, and GPU restrictions."""

    @staticmethod
    async def get_daily_usage(db: Database, user_id: str) -> int:
        day_start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        row = await db.fetchone(
            "SELECT COUNT(*) AS cnt FROM images WHERE user_id = ? AND created_at >= ?",
            (user_id, day_start),
        )
        return int(row["cnt"]) if row else 0

    @staticmethod
    async def get_active_queued_count(db: Database, user_id: str) -> int:
        row = await db.fetchone(
            """
            SELECT COUNT(*) AS cnt
            FROM jobs
            WHERE user_id = ? AND status IN ('queued', 'booting', 'running')
            """,
            (user_id,),
        )
        return int(row["cnt"]) if row else 0

    @classmethod
    async def check_can_submit(
        cls,
        db: Database,
        settings: Settings,
        user: UserRecord,
        *,
        batch_size: int,
        gpu_type: str = "L4",
    ) -> None:
        gpu = gpu_type.strip().upper()
        if gpu == "T4":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="T4 GPU is forbidden (no native BF16 support for Anima)",
            )
        if gpu not in user.allowed_gpus:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"User is not allowed to request GPU '{gpu}'",
            )
        if batch_size < 1 or batch_size > settings.max_batch_size:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"batch_size must be between 1 and {settings.max_batch_size}",
            )

        queued = await cls.get_active_queued_count(db, user.id)
        if queued >= user.max_queued:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Active job queue limit reached ({queued}/{user.max_queued})",
            )

        if user.daily_quota > 0:
            used_today = await cls.get_daily_usage(db, user.id)
            if used_today + batch_size > user.daily_quota:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"Daily image quota exceeded ({used_today}/{user.daily_quota})",
                )

"""Admin endpoints: invite codes and user quota/GPU management."""

from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth.deps import get_db, require_admin
from app.auth.service import (
    UserRecord,
    create_invite_code,
    get_user_by_id,
    row_to_user,
    validate_allowed_gpus,
)
from app.db import Database

router = APIRouter(prefix="/api/admin", tags=["admin"])


class CreateInviteRequest(BaseModel):
    max_uses: int = Field(default=1, ge=1, le=100)
    expires_in_hours: int | None = Field(default=None, ge=1, le=24 * 365)


class PatchUserRequest(BaseModel):
    role: Literal["admin", "member"] | None = None
    daily_quota: int | None = Field(default=None, ge=0, le=10000)
    max_queued: int | None = Field(default=None, ge=1, le=20)
    allowed_gpus: list[str] | None = None


@router.get("/invites")
async def list_invites(
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict:
    rows = await db.fetchall("SELECT * FROM invite_codes ORDER BY created_at DESC")
    return {"invites": [dict(r) for r in rows]}


@router.post("/invites", status_code=status.HTTP_201_CREATED)
async def create_invite(
    body: CreateInviteRequest,
    admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict:
    invite = await create_invite_code(
        db,
        created_by=admin.id,
        max_uses=body.max_uses,
        expires_in_hours=body.expires_in_hours,
    )
    return {"invite": invite}


@router.delete("/invites/{code}")
async def revoke_invite(
    code: str,
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict:
    cur = await db.execute("UPDATE invite_codes SET disabled = 1 WHERE code = ?", (code,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite code not found")
    return {"ok": True}


@router.get("/users")
async def list_users(
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict:
    rows = await db.fetchall("SELECT * FROM users ORDER BY created_at ASC")
    users = [row_to_user(r) for r in rows]
    return {
        "users": [
            {
                "id": u.id,
                "email": u.email,
                "username": u.username,
                "role": u.role,
                "daily_quota": u.daily_quota,
                "max_queued": u.max_queued,
                "allowed_gpus": list(u.allowed_gpus),
                "created_at": u.created_at,
            }
            for u in users
        ]
    }


@router.patch("/users/{user_id}")
async def patch_user(
    user_id: str,
    body: PatchUserRequest,
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict:
    target = await get_user_by_id(db, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    new_role = body.role if body.role is not None else target.role
    new_quota = body.daily_quota if body.daily_quota is not None else target.daily_quota
    new_max_queued = body.max_queued if body.max_queued is not None else target.max_queued
    new_gpus = (
        validate_allowed_gpus(body.allowed_gpus)
        if body.allowed_gpus is not None
        else list(target.allowed_gpus)
    )

    await db.execute(
        """
        UPDATE users
        SET role = ?, daily_quota = ?, max_queued = ?, allowed_gpus = ?
        WHERE id = ?
        """,
        (new_role, new_quota, new_max_queued, json.dumps(new_gpus), user_id),
    )
    updated = await get_user_by_id(db, user_id)
    assert updated is not None
    return {
        "user": {
            "id": updated.id,
            "email": updated.email,
            "username": updated.username,
            "role": updated.role,
            "daily_quota": updated.daily_quota,
            "max_queued": updated.max_queued,
            "allowed_gpus": list(updated.allowed_gpus),
            "created_at": updated.created_at,
        }
    }

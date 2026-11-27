"""Authentication endpoints: status, setup, login, invite registration, logout."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.auth.deps import get_current_user, get_db, get_settings
from app.auth.service import (
    QuotaService,
    UserRecord,
    authenticate_local,
    change_local_password,
    count_users,
    register_with_invite,
    setup_first_admin,
)
from app.auth.tokens import (
    clear_session_cookie,
    create_session_token,
    set_session_cookie,
)
from app.config import Settings
from app.db import Database

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SetupRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    username: str = Field(..., min_length=2, max_length=64)
    password: str = Field(..., min_length=8, max_length=128)


class LoginRequest(BaseModel):
    identifier: str = Field(..., min_length=1, max_length=254)
    password: str = Field(..., min_length=1, max_length=128)


class RegisterRequest(BaseModel):
    invite_code: str = Field(..., min_length=4, max_length=64)
    email: str = Field(..., min_length=3, max_length=254)
    username: str = Field(..., min_length=2, max_length=64)
    password: str = Field(..., min_length=8, max_length=128)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=8, max_length=128)


def _serialize_user(user: UserRecord, *, used_today: int, active_queued: int) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "role": user.role,
        "daily_quota": user.daily_quota,
        "used_today": used_today,
        "max_queued": user.max_queued,
        "active_queued": active_queued,
        "allowed_gpus": list(user.allowed_gpus),
        "has_password": user.has_password,
        "created_at": user.created_at,
    }


@router.get("/status")
async def auth_status(
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    total_users = await count_users(db)
    return {
        "auth_mode": settings.auth_mode,
        "needs_setup": total_users == 0 and settings.auth_mode != "cloudflare",
    }


@router.get("/me")
async def get_me(
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    used_today = await QuotaService.get_daily_usage(db, user.id)
    active_queued = await QuotaService.get_active_queued_count(db, user.id)
    return {
        "auth_mode": settings.auth_mode,
        "user": _serialize_user(user, used_today=used_today, active_queued=active_queued),
    }


@router.post("/setup")
async def setup_admin(
    body: SetupRequest,
    response: Response,
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    if settings.auth_mode == "cloudflare":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Local setup is disabled in cloudflare auth mode",
        )
    user = await setup_first_admin(
        db,
        settings,
        email=body.email,
        username=body.username,
        password=body.password,
    )
    token = create_session_token(
        user_id=user.id,
        role=user.role,
        secret_key=settings.canvas_secret_key,
        ttl_seconds=settings.session_ttl_seconds,
    )
    set_session_cookie(
        response,
        token=token,
        ttl_seconds=settings.session_ttl_seconds,
        secure=settings.cookie_secure,
    )
    return {"user": _serialize_user(user, used_today=0, active_queued=0)}


@router.post("/login")
async def login(
    body: LoginRequest,
    response: Response,
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    if settings.auth_mode == "cloudflare":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Local login is disabled in cloudflare auth mode",
        )
    user = await authenticate_local(db, body.identifier, body.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    token = create_session_token(
        user_id=user.id,
        role=user.role,
        secret_key=settings.canvas_secret_key,
        ttl_seconds=settings.session_ttl_seconds,
    )
    set_session_cookie(
        response,
        token=token,
        ttl_seconds=settings.session_ttl_seconds,
        secure=settings.cookie_secure,
    )
    used_today = await QuotaService.get_daily_usage(db, user.id)
    active_queued = await QuotaService.get_active_queued_count(db, user.id)
    return {"user": _serialize_user(user, used_today=used_today, active_queued=active_queued)}


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    response: Response,
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    if settings.auth_mode == "cloudflare":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invite registration is disabled in cloudflare auth mode",
        )
    user = await register_with_invite(
        db,
        settings,
        invite_code=body.invite_code,
        email=body.email,
        username=body.username,
        password=body.password,
    )
    token = create_session_token(
        user_id=user.id,
        role=user.role,
        secret_key=settings.canvas_secret_key,
        ttl_seconds=settings.session_ttl_seconds,
    )
    set_session_cookie(
        response,
        token=token,
        ttl_seconds=settings.session_ttl_seconds,
        secure=settings.cookie_secure,
    )
    return {"user": _serialize_user(user, used_today=0, active_queued=0)}


@router.post("/logout")
async def logout(
    response: Response,
    settings: Settings = Depends(get_settings),
) -> dict:
    clear_session_cookie(response, secure=settings.cookie_secure)
    return {"ok": True}


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict[str, bool]:
    await change_local_password(
        db,
        user_id=user.id,
        current_password=body.current_password,
        new_password=body.new_password,
    )
    return {"ok": True}

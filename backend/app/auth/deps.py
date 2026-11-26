"""FastAPI authentication dependencies."""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status

from app.auth.cf_access import CloudflareAccessVerifier, CloudflareAuthError
from app.auth.service import UserRecord, get_user_by_id, provision_or_get_cf_user
from app.auth.tokens import SESSION_COOKIE_NAME, decode_session_token
from app.config import Settings
from app.db import Database


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Database:
    return request.app.state.db


async def get_current_user(
    request: Request,
    settings: Settings = Depends(get_settings),
    db: Database = Depends(get_db),
) -> UserRecord:
    cf_token = (
        request.headers.get("Cf-Access-Jwt-Assertion")
        or request.cookies.get("CF_Authorization")
    )

    if cf_token and settings.auth_mode in ("cloudflare", "hybrid"):
        verifier: CloudflareAccessVerifier | None = getattr(
            request.app.state, "cf_verifier", None
        )
        if verifier is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Cloudflare Access JWT received but verifier is not configured",
            )
        try:
            email = verifier.verify_token(cf_token)
        except CloudflareAuthError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=str(exc),
            ) from exc
        return await provision_or_get_cf_user(db, settings, email)

    if settings.auth_mode == "cloudflare":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Cloudflare Access JWT",
        )

    session_cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if not session_cookie:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    claims = decode_session_token(session_cookie, settings.canvas_secret_key)
    if claims is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
        )
    user = await get_user_by_id(db, claims.user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    return user


async def require_admin(user: UserRecord = Depends(get_current_user)) -> UserRecord:
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )
    return user

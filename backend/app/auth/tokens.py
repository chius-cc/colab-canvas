"""Local HS256 session JWT and HttpOnly cookie helpers."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Response

SESSION_COOKIE_NAME = "cc_session"


@dataclass(frozen=True)
class SessionClaims:
    user_id: str
    role: str


def _derive_signing_key(secret_key: str) -> bytes:
    return hashlib.sha256(f"colab-canvas:session:v1:{secret_key}".encode()).digest()


def create_session_token(
    *,
    user_id: str,
    role: str,
    secret_key: str,
    ttl_seconds: int = 7 * 86400,
) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "role": role,
        "iat": now,
        "exp": now + timedelta(seconds=ttl_seconds),
    }
    return jwt.encode(payload, _derive_signing_key(secret_key), algorithm="HS256")


def decode_session_token(token: str, secret_key: str) -> SessionClaims | None:
    try:
        payload = jwt.decode(
            token,
            _derive_signing_key(secret_key),
            algorithms=["HS256"],
            options={"require": ["sub", "role", "exp"]},
        )
        return SessionClaims(user_id=str(payload["sub"]), role=str(payload["role"]))
    except jwt.PyJWTError:
        return None


def set_session_cookie(
    response: Response,
    *,
    token: str,
    ttl_seconds: int,
    secure: bool,
) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


def clear_session_cookie(response: Response, *, secure: bool) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )

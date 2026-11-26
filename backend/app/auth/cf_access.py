"""Cloudflare Access JWT verification against team JWKS."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import jwt
from jwt import PyJWKClient


class CloudflareAuthError(Exception):
    """Raised when a Cloudflare Access assertion fails verification."""


class CloudflareAccessVerifier:
    """Verifies Cf-Access-Jwt-Assertion RS256 tokens."""

    def __init__(
        self,
        team_domain: str,
        audience: str,
        signing_key_getter: Callable[[str], Any] | None = None,
    ) -> None:
        normalized = team_domain.strip().removeprefix("https://").removeprefix("http://").rstrip("/")
        if not normalized or not audience.strip():
            raise ValueError("CF Access team_domain and audience must both be configured")
        self.issuer = f"https://{normalized}"
        self.audience = audience.strip()
        if signing_key_getter is not None:
            self._get_key = signing_key_getter
        else:
            jwks_client = PyJWKClient(f"{self.issuer}/cdn-cgi/access/certs", cache_keys=True)
            self._get_key = lambda tok: jwks_client.get_signing_key_from_jwt(tok).key

    def verify_token(self, token: str) -> str:
        """Validate the JWT signature, audience, issuer, and return verified email."""
        try:
            signing_key = self._get_key(token)
            payload = jwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                audience=self.audience,
                issuer=self.issuer,
                options={"require": ["exp", "email"]},
            )
        except Exception as exc:
            raise CloudflareAuthError("Invalid Cloudflare Access token") from exc

        email = str(payload.get("email", "")).strip().lower()
        if not email or "@" not in email:
            raise CloudflareAuthError("Cloudflare Access token missing valid email claim")
        return email

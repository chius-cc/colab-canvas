"""Fernet encryption for stored credentials and private file writing."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken


class CryptoError(Exception):
    """Raised when decryption fails due to tampering or wrong key."""


class SecretBox:
    """Deterministic Fernet wrapper keyed by CANVAS_SECRET_KEY."""

    def __init__(self, secret_key: str) -> None:
        if len(secret_key) < 32:
            raise ValueError("CANVAS_SECRET_KEY must be at least 32 characters")
        digest = hashlib.sha256(f"colab-canvas:fernet:v1:{secret_key}".encode()).digest()
        fernet_key = base64.urlsafe_b64encode(digest)
        self._fernet = Fernet(fernet_key)

    def encrypt_text(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt_text(self, ciphertext: str) -> str:
        try:
            return self._fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except InvalidToken as exc:
            raise CryptoError("Failed to decrypt secret payload") from exc

    def encrypt_json(self, obj: dict[str, Any]) -> str:
        return self.encrypt_text(json.dumps(obj, separators=(",", ":")))

    def decrypt_json(self, ciphertext: str) -> dict[str, Any]:
        return json.loads(self.decrypt_text(ciphertext))


def write_private_file(path: Path, content: str) -> None:
    """Write sensitive content to `path` with strict 0o600 permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
    finally:
        os.chmod(path, 0o600)

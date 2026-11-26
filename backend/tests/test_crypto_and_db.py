"""Tests for Fernet SecretBox, private file permissions, and SQLite schema/migrations."""

from __future__ import annotations

import stat

import pytest

from app.db import Database
from app.security.crypto import CryptoError, SecretBox, write_private_file


def test_secret_box_roundtrip_and_wrong_key() -> None:
    box1 = SecretBox("alpha-secret-key-at-least-32-characters-long")
    box2 = SecretBox("bravo-secret-key-at-least-32-characters-long")

    token = box1.encrypt_json({"refresh_token": "r123", "email": "u@example.com"})
    assert "r123" not in token
    assert box1.decrypt_json(token) == {"refresh_token": "r123", "email": "u@example.com"}

    with pytest.raises(CryptoError):
        box2.decrypt_text(token)

    with pytest.raises(ValueError):
        SecretBox("too-short")


def test_write_private_file_permissions(tmp_path) -> None:
    secret_file = tmp_path / "private" / "adc.json"
    write_private_file(secret_file, '{"secret":"ok"}')
    mode = stat.S_IMODE(secret_file.stat().st_mode)
    assert mode == 0o600
    assert secret_file.read_text(encoding="utf-8") == '{"secret":"ok"}'


async def test_database_wal_migrations_and_tables(tmp_path) -> None:
    db = Database(tmp_path / "canvas.db")
    await db.connect()
    try:
        journal = await db.fetchone("PRAGMA journal_mode;")
        assert journal is not None and journal[0].lower() == "wal"

        fk = await db.fetchone("PRAGMA foreign_keys;")
        assert fk is not None and int(fk[0]) == 1

        rows = await db.fetchall(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
        tables = {r["name"] for r in rows}
        expected = {
            "schema_migrations",
            "users",
            "invite_codes",
            "colab_accounts",
            "workers",
            "jobs",
            "images",
            "loras",
            "app_settings",
        }
        assert expected.issubset(tables)

        # Running migrations again should be a clean no-op
        await db.run_migrations()
    finally:
        await db.close()

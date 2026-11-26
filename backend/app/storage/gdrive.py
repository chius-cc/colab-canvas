"""Google Drive API v3 StorageAdapter (drive.file scope, app-owned root folder)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

from app.db import Database
from app.security.crypto import SecretBox
from app.storage.base import (
    StorageAdapter,
    StreamResult,
    parse_range_header,
)

DRIVE_TOKEN_KEY = "gdrive_oauth_token"
DRIVE_ROOT_FOLDER_KEY = "gdrive_root_folder_id"
DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive.file"]


class DriveNotConfiguredError(RuntimeError):
    """Raised when GoogleDriveStorage is used without stored OAuth credentials."""


class GoogleDriveStorage(StorageAdapter):
    """Persists originals into a single app-owned folder via Drive API v3."""

    backend_name = "gdrive"

    def __init__(
        self,
        db: Database,
        crypto: SecretBox,
        *,
        root_folder_name: str = "colab-canvas",
        service_factory: Callable[[Credentials], Any] | None = None,
        session_factory: Callable[[Credentials], Any] | None = None,
    ) -> None:
        self.db = db
        self.crypto = crypto
        self.root_folder_name = root_folder_name
        self._service_factory = service_factory or (
            lambda c: build("drive", "v3", credentials=c, cache_discovery=False)
        )
        self._session_factory = session_factory or AuthorizedSession

    async def _load_credentials(self) -> Credentials:
        row = await self.db.fetchone(
            "SELECT value_json FROM app_settings WHERE key = ?", (DRIVE_TOKEN_KEY,)
        )
        if row is None:
            raise DriveNotConfiguredError("Google Drive OAuth token is not configured")
        encrypted_blob = json.loads(row["value_json"])["token_encrypted"]
        token_info = self.crypto.decrypt_json(encrypted_blob)
        creds = Credentials.from_authorized_user_info(token_info, DRIVE_SCOPE)
        if not creds.valid and creds.refresh_token:
            await asyncio.to_thread(creds.refresh, Request())
            await self.save_credentials(creds)
        return creds

    async def save_credentials(self, creds: Credentials) -> None:
        encrypted = self.crypto.encrypt_text(creds.to_json())
        payload = json.dumps({"token_encrypted": encrypted})
        now = datetime.now(UTC).isoformat()
        await self.db.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            """,
            (DRIVE_TOKEN_KEY, payload, now),
        )

    async def _ensure_root_folder(self, service: Any) -> str:
        row = await self.db.fetchone(
            "SELECT value_json FROM app_settings WHERE key = ?", (DRIVE_ROOT_FOLDER_KEY,)
        )
        if row is not None:
            return str(json.loads(row["value_json"])["folder_id"])

        created = await asyncio.to_thread(
            lambda: service.files()
            .create(
                body={
                    "name": self.root_folder_name,
                    "mimeType": "application/vnd.google-apps.folder",
                },
                fields="id",
            )
            .execute()
        )
        folder_id = str(created["id"])
        now = datetime.now(UTC).isoformat()
        await self.db.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            """,
            (DRIVE_ROOT_FOLDER_KEY, json.dumps({"folder_id": folder_id}), now),
        )
        return folder_id

    async def put_original(
        self, key: str, src_path: Path, content_type: str = "image/png"
    ) -> str:
        creds = await self._load_credentials()
        service = self._service_factory(creds)
        folder_id = await self._ensure_root_folder(service)
        filename = Path(key).name

        def _upload() -> str:
            media = MediaFileUpload(str(src_path), mimetype=content_type, resumable=True)
            resp = (
                service.files()
                .create(
                    body={"name": filename, "parents": [folder_id]},
                    media_body=media,
                    fields="id",
                )
                .execute()
            )
            return str(resp["id"])

        return await asyncio.to_thread(_upload)

    async def get_stream(
        self, storage_key: str, range_header: str | None = None
    ) -> StreamResult:
        creds = await self._load_credentials()
        service = self._service_factory(creds)
        meta = await asyncio.to_thread(
            lambda: service.files().get(fileId=storage_key, fields="id,size,mimeType").execute()
        )
        total_size = int(meta["size"])
        mime_type = str(meta.get("mimeType") or "image/png")
        byte_range = parse_range_header(range_header, total_size)

        headers: dict[str, str] = {}
        if byte_range is not None:
            headers["Range"] = f"bytes={byte_range.start}-{byte_range.end}"

        authed = self._session_factory(creds)
        url = f"https://www.googleapis.com/drive/v3/files/{storage_key}?alt=media"
        resp = await asyncio.to_thread(
            lambda: authed.get(url, headers=headers, stream=True, timeout=60)
        )
        if resp.status_code not in (200, 206):
            resp.close()
            raise RuntimeError(f"Drive download failed with status {resp.status_code}")

        async def _iter_drive() -> AsyncIterator[bytes]:
            try:
                for chunk in resp.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        yield chunk
            finally:
                resp.close()

        return StreamResult(
            chunks=_iter_drive(),
            total_size=total_size,
            byte_range=byte_range,
            content_type=mime_type,
        )

    async def delete(self, storage_key: str) -> None:
        creds = await self._load_credentials()
        service = self._service_factory(creds)

        def _del() -> None:
            try:
                service.files().delete(fileId=storage_key).execute()
            except HttpError as exc:
                if getattr(exc, "status_code", None) != 404:
                    raise

        await asyncio.to_thread(_del)

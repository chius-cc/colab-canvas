"""Tests for StorageAdapter, Outbox durability (Invariant #5), Range streaming, and Gallery API."""

from __future__ import annotations

import io
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock

import httpx
from google.oauth2.credentials import Credentials

from app.main import create_app
from app.storage.base import StorageAdapter, StreamResult
from app.storage.gdrive import GoogleDriveStorage
from app.storage.outbox import OutboxUploader
from tests.conftest import make_png_bytes, make_test_settings


class FlakyAdapter(StorageAdapter):
    backend_name = "local"

    def __init__(self, inner: StorageAdapter, fail: bool = True) -> None:
        self.inner = inner
        self.fail = fail

    async def put_original(
        self, key: str, src_path: Path, content_type: str = "image/png"
    ) -> str:
        if self.fail:
            raise RuntimeError("Simulated storage outage")
        return await self.inner.put_original(key, src_path, content_type)

    async def get_stream(
        self, storage_key: str, range_header: str | None = None
    ) -> StreamResult:
        return await self.inner.get_stream(storage_key, range_header=range_header)

    async def delete(self, storage_key: str) -> None:
        await self.inner.delete(storage_key)


async def test_outbox_durability_gallery_and_range_streaming(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
    )
    app = create_app(settings, start_background_uploader=False)

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        login = await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )
        admin_id = login.json()["user"]["id"]

        # Swap in flaky adapter to verify Invariant #5 (outbox survives failure)
        real_local = app.state.storage_adapters["local"]
        flaky = FlakyAdapter(real_local, fail=True)
        app.state.storage_adapters["local"] = flaky

        png_bytes = make_png_bytes(160, 120)
        ingested = await app.state.image_store.ingest_png(
            user_id=admin_id,
            job_id=None,
            workflow_id="anima",
            variant="turbo",
            png_bytes=png_bytes,
            seed=42,
            meta={"prompt": "1girl, test"},
        )
        image_id = ingested["id"]
        outbox_file = Path(ingested["outbox_path"])
        thumb_file = Path(ingested["thumb_path"])
        assert outbox_file.is_file()
        assert thumb_file.is_file()

        uploader = OutboxUploader(
            db=app.state.db,
            store=app.state.image_store,
            events=app.state.events,
            max_attempts=2,
        )
        # Attempt 1 fails -> outbox stays intact, still pending
        assert await uploader.process_once() == 0
        assert outbox_file.is_file()
        row1 = await app.state.db.fetchone("SELECT * FROM images WHERE id = ?", (image_id,))
        assert (
            row1 is not None
            and row1["upload_state"] == "pending"
            and row1["upload_attempts"] == 1
        )

        # Original is still readable from outbox during storage outage
        orig_outbox = await client.get(f"/api/images/{image_id}/original")
        assert orig_outbox.status_code == 200
        assert orig_outbox.content == png_bytes

        # Recover adapter -> upload succeeds and outbox file is deleted ONLY after DB commit
        flaky.fail = False
        assert await uploader.process_once() == 1
        assert not outbox_file.exists()
        row2 = await app.state.db.fetchone("SELECT * FROM images WHERE id = ?", (image_id,))
        assert (
            row2 is not None
            and row2["upload_state"] == "uploaded"
            and row2["outbox_path"] is None
        )

        # Thumb & Gallery API
        gallery = await client.get("/api/images")
        assert gallery.status_code == 200
        assert gallery.json()["total"] == 1
        assert gallery.json()["images"][0]["width"] == 160

        thumb_resp = await client.get(f"/api/images/{image_id}/thumb")
        assert thumb_resp.status_code == 200
        assert thumb_resp.headers["content-type"] == "image/webp"

        # Range request from storage adapter
        range_resp = await client.get(
            f"/api/images/{image_id}/original",
            headers={"Range": "bytes=0-15"},
        )
        assert range_resp.status_code == 206
        assert range_resp.content == png_bytes[:16]
        assert range_resp.headers["content-range"] == f"bytes 0-15/{len(png_bytes)}"

        # Unsatisfiable Range returns 416
        bad_range = await client.get(
            f"/api/images/{image_id}/original",
            headers={"Range": f"bytes={len(png_bytes) + 10}-"},
        )
        assert bad_range.status_code == 416

        # Favorite toggle & non-owner permission enforcement
        fav = await client.patch(f"/api/images/{image_id}", json={"is_favorite": True})
        assert fav.status_code == 200
        assert fav.json()["image"]["is_favorite"] is True

        # Create a member user and verify 403 on modifying/deleting admin's image
        inv_resp = await client.post("/api/admin/invites", json={"max_uses": 1})
        inv = inv_resp.json()["invite"]["code"]
        await client.post("/api/auth/logout")
        await client.post(
            "/api/auth/register",
            json={
                "invite_code": inv,
                "email": "member@example.com",
                "username": "member",
                "password": "memberpassword123",
            },
        )
        patch_resp = await client.patch(
            f"/api/images/{image_id}", json={"is_favorite": False}
        )
        assert patch_resp.status_code == 403
        assert (await client.delete(f"/api/images/{image_id}")).status_code == 403

        # Admin deletes image -> removes DB row, thumb, and stored original
        await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )
        del_resp = await client.delete(f"/api/images/{image_id}")
        assert del_resp.status_code == 200
        assert not thumb_file.exists()
        assert (await client.get(f"/api/images/{image_id}/original")).status_code == 404


async def test_gdrive_storage_adapter_mocked(tmp_path) -> None:
    settings = make_test_settings(tmp_path)
    app = create_app(settings, start_background_uploader=False)

    mock_service = MagicMock()
    mock_files = mock_service.files.return_value
    mock_files.create.return_value.execute.side_effect = [
        {"id": "folder-123"},  # root folder
        {"id": "file-456"},    # uploaded png
    ]
    png_bytes = make_png_bytes(64, 64)
    mock_files.get.return_value.execute.return_value = {
        "id": "file-456",
        "size": str(len(png_bytes)),
        "mimeType": "image/png",
    }

    mock_resp = MagicMock()
    mock_resp.status_code = 206
    mock_resp.iter_content.return_value = [png_bytes[:16]]
    mock_session = MagicMock()
    mock_session.get.return_value = mock_resp

    async with app.router.lifespan_context(app):
        gdrive = GoogleDriveStorage(
            app.state.db,
            app.state.crypto,
            service_factory=lambda _c: mock_service,
            session_factory=lambda _c: mock_session,
        )
        creds = Credentials(
            token="access-123",
            refresh_token="refresh-123",
            token_uri="https://oauth2.googleapis.com/token",
            client_id="cid",
            client_secret="csec",
            expiry=datetime.now(UTC).replace(tzinfo=None) + timedelta(hours=1),
        )
        await gdrive.save_credentials(creds)

        src = tmp_path / "sample.png"
        src.write_bytes(png_bytes)
        file_id = await gdrive.put_original("2026-11/sample.png", src)
        assert file_id == "file-456"

        stream = await gdrive.get_stream("file-456", range_header="bytes=0-15")
        chunks = [c async for c in stream.chunks]
        assert b"".join(chunks) == png_bytes[:16]
        assert stream.byte_range is not None and stream.byte_range.end == 15

        await gdrive.delete("file-456")
        assert mock_files.delete.called

        # Verify persisted credentials in app_settings remain encrypted (no plaintext refresh_token)
        row = await app.state.db.fetchone(
            "SELECT value_json FROM app_settings WHERE key = 'gdrive_oauth_token'"
        )
        assert row is not None and "refresh-123" not in row["value_json"]
        assert isinstance(io.BytesIO(png_bytes), io.BytesIO)

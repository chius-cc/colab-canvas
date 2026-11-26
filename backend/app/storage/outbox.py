"""Outbox-backed image ingestion, reliable background upload, and original streaming."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.api.events import EventBus
from app.config import Settings
from app.db import Database
from app.storage.base import StorageAdapter, StreamResult, iter_file_chunks, parse_range_header
from app.storage.thumbnails import generate_webp_thumbnail


class ImageStoreService:
    """Handles two-tier image ingestion (WebP thumb + outbox PNG) and retrieval."""

    def __init__(
        self,
        *,
        db: Database,
        settings: Settings,
        adapters: dict[str, StorageAdapter],
        default_backend: str,
        events: EventBus,
    ) -> None:
        self.db = db
        self.settings = settings
        self.adapters = adapters
        self.default_backend = default_backend
        self.events = events
        self.wake_event = asyncio.Event()

    async def ingest_png(
        self,
        *,
        user_id: str,
        job_id: str | None,
        workflow_id: str,
        variant: str,
        png_bytes: bytes,
        seed: int,
        meta: dict[str, Any],
        is_favorite: bool = False,
    ) -> dict[str, Any]:
        image_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()

        outbox_path = self.settings.outbox_dir / f"{image_id}.png"
        tmp_outbox = self.settings.outbox_dir / f".{image_id}.{uuid.uuid4().hex}.tmp"
        outbox_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            tmp_outbox.write_bytes(png_bytes)
            os.replace(tmp_outbox, outbox_path)
        except Exception:
            tmp_outbox.unlink(missing_ok=True)
            raise

        thumb_path = self.settings.thumbs_dir / f"{image_id}.webp"
        width, height = await asyncio.to_thread(
            generate_webp_thumbnail, outbox_path, thumb_path
        )

        await self.db.execute(
            """
            INSERT INTO images (
                id, job_id, user_id, workflow_id, variant,
                thumb_path, outbox_path, upload_state, upload_attempts, upload_error,
                storage_backend, storage_key, width, height, seed, meta_json,
                is_favorite, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
            """,
            (
                image_id,
                job_id,
                user_id,
                workflow_id,
                variant,
                str(thumb_path),
                str(outbox_path),
                self.default_backend,
                width,
                height,
                seed,
                json.dumps(meta),
                1 if is_favorite else 0,
                now,
            ),
        )

        self.wake_event.set()
        await self.events.publish(
            "image.created",
            {
                "image_id": image_id,
                "job_id": job_id,
                "workflow_id": workflow_id,
                "variant": variant,
                "width": width,
                "height": height,
                "upload_state": "pending",
            },
            user_id=user_id,
        )

        row = await self.db.fetchone("SELECT * FROM images WHERE id = ?", (image_id,))
        assert row is not None
        return dict(row)

    async def open_original_stream(
        self, image_row: dict[str, Any], range_header: str | None = None
    ) -> StreamResult:
        outbox_raw = image_row.get("outbox_path")
        if outbox_raw:
            outbox_file = Path(outbox_raw)
            if outbox_file.is_file():
                total_size = outbox_file.stat().st_size
                byte_range = parse_range_header(range_header, total_size)
                return StreamResult(
                    chunks=iter_file_chunks(outbox_file, byte_range=byte_range),
                    total_size=total_size,
                    byte_range=byte_range,
                    content_type="image/png",
                )

        storage_key = image_row.get("storage_key")
        backend_name = str(image_row.get("storage_backend") or self.default_backend)
        if not storage_key or backend_name not in self.adapters:
            raise FileNotFoundError("Original image is unavailable in storage and outbox")

        return await self.adapters[backend_name].get_stream(
            str(storage_key), range_header=range_header
        )

    async def delete_image(self, image_row: dict[str, Any]) -> None:
        image_id = str(image_row["id"])
        thumb_raw = image_row.get("thumb_path")
        outbox_raw = image_row.get("outbox_path")
        storage_key = image_row.get("storage_key")
        backend_name = str(image_row.get("storage_backend") or self.default_backend)

        if storage_key and backend_name in self.adapters:
            await self.adapters[backend_name].delete(str(storage_key))

        if outbox_raw:
            Path(outbox_raw).unlink(missing_ok=True)
        if thumb_raw:
            Path(thumb_raw).unlink(missing_ok=True)

        await self.db.execute("DELETE FROM images WHERE id = ?", (image_id,))


class OutboxUploader:
    """Uploads pending outbox PNGs to the active StorageAdapter before deleting local copies."""

    def __init__(
        self,
        *,
        db: Database,
        store: ImageStoreService,
        events: EventBus,
        poll_seconds: float = 5.0,
        max_attempts: int = 5,
    ) -> None:
        self.db = db
        self.store = store
        self.events = events
        self.poll_seconds = poll_seconds
        self.max_attempts = max_attempts
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._stop_event.clear()
            self._task = asyncio.create_task(self._run_loop(), name="outbox-uploader")

    async def stop(self) -> None:
        self._stop_event.set()
        self.store.wake_event.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def process_once(self) -> int:
        rows = await self.db.fetchall(
            """
            SELECT * FROM images
            WHERE upload_state = 'pending' AND upload_attempts < ?
            ORDER BY created_at ASC
            LIMIT 20
            """,
            (self.max_attempts,),
        )
        uploaded_count = 0
        for row in rows:
            image_id = str(row["id"])
            user_id = str(row["user_id"])
            outbox_raw = row["outbox_path"]
            backend_name = str(row["storage_backend"] or self.store.default_backend)
            adapter = self.store.adapters.get(backend_name)

            if not outbox_raw or not Path(outbox_raw).is_file() or adapter is None:
                await self.db.execute(
                    """
                    UPDATE images
                    SET upload_state = 'failed',
                        upload_attempts = upload_attempts + 1,
                        upload_error = ?
                    WHERE id = ?
                    """,
                    ("Missing outbox file or unknown storage adapter", image_id),
                )
                continue

            outbox_file = Path(outbox_raw)
            ym = str(row["created_at"])[:7]
            object_key = f"{ym}/{image_id}.png"
            try:
                storage_key = await adapter.put_original(object_key, outbox_file)
                async with self.db.transaction() as conn:
                    await conn.execute(
                        """
                        UPDATE images
                        SET upload_state = 'uploaded',
                            storage_key = ?,
                            storage_backend = ?,
                            outbox_path = NULL,
                            upload_error = NULL
                        WHERE id = ?
                        """,
                        (storage_key, adapter.backend_name, image_id),
                    )
                # Invariant #5: unlink outbox ONLY after storage put + SQLite commit succeed
                outbox_file.unlink(missing_ok=True)
                uploaded_count += 1
                await self.events.publish(
                    "image.uploaded",
                    {
                        "image_id": image_id,
                        "storage_backend": adapter.backend_name,
                    },
                    user_id=user_id,
                )
            except Exception as exc:
                attempts = int(row["upload_attempts"]) + 1
                new_state = "failed" if attempts >= self.max_attempts else "pending"
                err_msg = f"{type(exc).__name__}: {exc}"[:500]
                await self.db.execute(
                    """
                    UPDATE images
                    SET upload_state = ?,
                        upload_attempts = ?,
                        upload_error = ?
                    WHERE id = ?
                    """,
                    (new_state, attempts, err_msg, image_id),
                )
                if new_state == "failed":
                    await self.events.publish(
                        "image.upload_failed",
                        {"image_id": image_id, "error": err_msg},
                        user_id=user_id,
                    )
        return uploaded_count

    async def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.process_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            self.store.wake_event.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    self.store.wake_event.wait(), timeout=self.poll_seconds
                )


def copy_outbox_safe(src: Path, dst: Path) -> None:
    """Helper used if external callers stage PNG files into outbox."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)

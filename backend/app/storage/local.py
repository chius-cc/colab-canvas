"""Local filesystem StorageAdapter implementation."""

from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

from app.storage.base import (
    StorageAdapter,
    StreamResult,
    iter_file_chunks,
    parse_range_header,
)


class LocalStorage(StorageAdapter):
    """Stores original images under `root_dir` with atomic writes."""

    backend_name = "local"

    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir.resolve()
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def _resolve_key(self, key: str) -> Path:
        clean = key.lstrip("/")
        target = (self.root_dir / clean).resolve()
        try:
            target.relative_to(self.root_dir)
        except ValueError as exc:
            raise ValueError(f"Invalid storage key path: {key}") from exc
        return target

    async def put_original(
        self, key: str, src_path: Path, content_type: str = "image/png"
    ) -> str:
        del content_type
        dest = self._resolve_key(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
        try:
            shutil.copyfile(src_path, tmp)
            os.replace(tmp, dest)
        except Exception:
            if tmp.exists():
                tmp.unlink(missing_ok=True)
            raise
        return key

    async def get_stream(
        self, storage_key: str, range_header: str | None = None
    ) -> StreamResult:
        target = self._resolve_key(storage_key)
        if not target.is_file():
            raise FileNotFoundError(f"Original image not found: {storage_key}")
        total_size = target.stat().st_size
        byte_range = parse_range_header(range_header, total_size)
        return StreamResult(
            chunks=iter_file_chunks(target, byte_range=byte_range),
            total_size=total_size,
            byte_range=byte_range,
            content_type="image/png",
        )

    async def delete(self, storage_key: str) -> None:
        target = self._resolve_key(storage_key)
        target.unlink(missing_ok=True)

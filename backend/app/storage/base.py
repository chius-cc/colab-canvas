"""Storage adapter interface and HTTP Range parsing."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ByteRange:
    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start + 1


class RangeNotSatisfiableError(Exception):
    """Raised when an HTTP Range header cannot be satisfied."""

    def __init__(self, total_size: int) -> None:
        super().__init__(f"Requested range not satisfiable for size {total_size}")
        self.total_size = total_size


@dataclass
class StreamResult:
    chunks: AsyncIterator[bytes]
    total_size: int
    byte_range: ByteRange | None = None
    content_type: str = "image/png"

    @property
    def content_length(self) -> int:
        if self.byte_range is not None:
            return self.byte_range.length
        return self.total_size


def parse_range_header(range_header: str | None, total_size: int) -> ByteRange | None:
    """Parse single-range HTTP `Range: bytes=...` header."""
    if not range_header:
        return None
    header = range_header.strip()
    if not header.startswith("bytes="):
        raise RangeNotSatisfiableError(total_size)
    spec = header.removeprefix("bytes=").strip()
    if "," in spec or "-" not in spec or total_size <= 0:
        raise RangeNotSatisfiableError(total_size)

    start_str, end_str = spec.split("-", 1)
    try:
        if start_str == "":
            # Suffix range: bytes=-N
            suffix = int(end_str)
            if suffix <= 0:
                raise RangeNotSatisfiableError(total_size)
            start = max(0, total_size - suffix)
            end = total_size - 1
        else:
            start = int(start_str)
            end = total_size - 1 if end_str == "" else min(int(end_str), total_size - 1)
    except ValueError as exc:
        raise RangeNotSatisfiableError(total_size) from exc

    if start < 0 or start >= total_size or end < start:
        raise RangeNotSatisfiableError(total_size)
    return ByteRange(start=start, end=end)


async def iter_file_chunks(
    path: Path,
    byte_range: ByteRange | None = None,
    chunk_size: int = 64 * 1024,
) -> AsyncIterator[bytes]:
    """Yield chunks from a local file without loading it all into memory."""
    with path.open("rb") as fh:
        remaining: int | None = None
        if byte_range is not None:
            fh.seek(byte_range.start)
            remaining = byte_range.length
        while True:
            to_read = chunk_size if remaining is None else min(chunk_size, remaining)
            if to_read <= 0:
                break
            data = fh.read(to_read)
            if not data:
                break
            if remaining is not None:
                remaining -= len(data)
            yield data


class StorageAdapter(ABC):
    """Abstract storage interface for original full-resolution images."""

    backend_name: str

    @abstractmethod
    async def put_original(
        self, key: str, src_path: Path, content_type: str = "image/png"
    ) -> str:
        """Persist original file and return backend-specific storage_key."""

    @abstractmethod
    async def get_stream(
        self, storage_key: str, range_header: str | None = None
    ) -> StreamResult:
        """Return an async stream (supporting HTTP Range) for `storage_key`."""

    @abstractmethod
    async def delete(self, storage_key: str) -> None:
        """Delete stored object by `storage_key` (idempotent if missing)."""

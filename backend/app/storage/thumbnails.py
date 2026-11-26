"""WebP thumbnail generation for fast gallery loading."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from PIL import Image


def generate_webp_thumbnail(
    src_png: Path,
    dst_webp: Path,
    *,
    max_dim: int = 512,
    quality: int = 82,
) -> tuple[int, int]:
    """Create WebP thumbnail at `dst_webp` and return original `(width, height)`."""
    dst_webp.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst_webp.with_name(f".{dst_webp.name}.{uuid.uuid4().hex}.tmp.webp")

    with Image.open(src_png) as img:
        orig_size = img.size
        thumb = img.copy()
        if thumb.mode not in ("RGB", "RGBA"):
            thumb = thumb.convert("RGBA" if "A" in thumb.getbands() else "RGB")
        thumb.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        try:
            thumb.save(tmp, format="WEBP", quality=quality, method=4)
            os.replace(tmp, dst_webp)
        except Exception:
            if tmp.exists():
                tmp.unlink(missing_ok=True)
            raise

    return orig_size

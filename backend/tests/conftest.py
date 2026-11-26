"""Shared pytest fixtures for colab-canvas M1 tests."""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

from app.config import Settings

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TEST_SECRET = "unit-test-secret-key-at-least-32-bytes-long"


def make_test_settings(tmp_path: Path, **overrides) -> Settings:
    defaults = {
        "canvas_secret_key": TEST_SECRET,
        "canvas_data_dir": tmp_path / "data",
        "workflows_dir": REPO_ROOT / "workflows",
        "scripts_dir": REPO_ROOT / "scripts",
        "frontend_dist_dir": tmp_path / "nonexistent-frontend-dist",
        "sse_heartbeat_seconds": 0.2,
        "outbox_poll_seconds": 0.5,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def make_png_bytes(
    width: int = 128,
    height: int = 96,
    color: tuple[int, int, int] = (120, 160, 210),
) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=color).save(buf, format="PNG")
    return buf.getvalue()

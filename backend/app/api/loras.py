"""LoRA registry endpoints (admin-only registration, authenticated listing)."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth.deps import get_current_user, get_db, require_admin
from app.auth.service import UserRecord
from app.db import Database

router = APIRouter(prefix="/api/loras", tags=["loras"])

SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.safetensors$")
ALLOWED_HOSTS = {
    "hf": ("huggingface.co", "hf.co"),
    "civitai": ("civitai.com", "cdn.civitai.com"),
}


class CreateLoraRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    source_type: Literal["hf", "civitai"]
    source_url: str = Field(..., min_length=10, max_length=512)
    filename: str = Field(..., min_length=13, max_length=133)
    sha256: str | None = Field(default=None, min_length=64, max_length=64)
    size_bytes: int | None = Field(default=None, ge=1)
    default_weight: float = Field(default=0.8, ge=-2.0, le=2.0)
    trigger_words: str = Field(default="", max_length=500)


def _validate_lora_inputs(body: CreateLoraRequest) -> tuple[str, str]:
    filename = body.filename.strip()
    if (
        "/" in filename
        or "\\" in filename
        or ".." in filename
        or not SAFE_FILENAME_RE.fullmatch(filename)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="filename must be a safe bare '<name>.safetensors' identifier",
        )

    parsed = urlparse(body.source_url.strip())
    host = (parsed.hostname or "").lower()
    allowed = ALLOWED_HOSTS[body.source_type]
    if parsed.scheme != "https" or not any(
        host == h or host.endswith(f".{h}") for h in allowed
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"source_url must use https and an allowed {body.source_type} domain",
        )
    return filename, body.source_url.strip()


@router.get("")
async def list_loras(
    _user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict:
    rows = await db.fetchall("SELECT * FROM loras ORDER BY created_at DESC")
    return {"loras": [dict(r) for r in rows]}


@router.post("", status_code=status.HTTP_201_CREATED)
async def register_lora(
    body: CreateLoraRequest,
    admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict:
    filename, source_url = _validate_lora_inputs(body)
    existing = await db.fetchone("SELECT id FROM loras WHERE filename = ?", (filename,))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"LoRA filename '{filename}' is already registered",
        )

    lora_id = str(uuid.uuid4())
    now = datetime.now(UTC).isoformat()
    await db.execute(
        """
        INSERT INTO loras (
            id, name, source_type, source_url, filename, sha256,
            size_bytes, default_weight, trigger_words, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            lora_id,
            body.name.strip(),
            body.source_type,
            source_url,
            filename,
            body.sha256.lower() if body.sha256 else None,
            body.size_bytes,
            body.default_weight,
            body.trigger_words.strip(),
            admin.id,
            now,
        ),
    )
    row = await db.fetchone("SELECT * FROM loras WHERE id = ?", (lora_id,))
    assert row is not None
    return {"lora": dict(row)}


@router.delete("/{lora_id}")
async def delete_lora(
    lora_id: str,
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict:
    cur = await db.execute("DELETE FROM loras WHERE id = ?", (lora_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="LoRA not found")
    return {"ok": True}

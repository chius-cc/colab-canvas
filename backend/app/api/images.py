"""Gallery image listing, thumbnails, Range original streaming, favorite & delete."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.auth.deps import get_current_user, get_db
from app.auth.service import UserRecord
from app.db import Database
from app.storage.base import RangeNotSatisfiableError
from app.storage.outbox import ImageStoreService

router = APIRouter(prefix="/api/images", tags=["images"])


class PatchImageRequest(BaseModel):
    is_favorite: bool


def _format_image_row(row: Any) -> dict[str, Any]:
    image_id = str(row["id"])
    return {
        "id": image_id,
        "job_id": row["job_id"],
        "user_id": row["user_id"],
        "username": row["username"],
        "workflow_id": row["workflow_id"],
        "variant": row["variant"],
        "thumb_url": f"/api/images/{image_id}/thumb",
        "original_url": f"/api/images/{image_id}/original",
        "upload_state": row["upload_state"],
        "upload_attempts": row["upload_attempts"],
        "upload_error": row["upload_error"],
        "storage_backend": row["storage_backend"],
        "width": row["width"],
        "height": row["height"],
        "seed": row["seed"],
        "meta": json.loads(row["meta_json"]),
        "is_favorite": bool(row["is_favorite"]),
        "created_at": row["created_at"],
    }


async def _get_image_or_404(db: Database, image_id: str) -> dict[str, Any]:
    row = await db.fetchone(
        """
        SELECT i.*, u.username AS username
        FROM images i
        JOIN users u ON u.id = i.user_id
        WHERE i.id = ?
        """,
        (image_id,),
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")
    return dict(row)


@router.get("")
async def list_images(
    limit: int = Query(default=40, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    mine: bool = False,
    variant: str | None = None,
    favorite: bool = False,
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict:
    clauses: list[str] = []
    params: list[Any] = []
    if mine:
        clauses.append("i.user_id = ?")
        params.append(user.id)
    if variant:
        clauses.append("i.variant = ?")
        params.append(variant.strip())
    if favorite:
        clauses.append("i.is_favorite = 1")

    where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    count_row = await db.fetchone(f"SELECT COUNT(*) AS cnt FROM images i {where_sql}", params)
    total = int(count_row["cnt"]) if count_row else 0

    rows = await db.fetchall(
        f"""
        SELECT i.*, u.username AS username
        FROM images i
        JOIN users u ON u.id = i.user_id
        {where_sql}
        ORDER BY i.created_at DESC
        LIMIT ? OFFSET ?
        """,
        [*params, limit, offset],
    )
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "images": [_format_image_row(r) for r in rows],
    }


@router.get("/{image_id}/thumb")
async def get_thumbnail(
    image_id: str,
    _user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> FileResponse:
    row = await _get_image_or_404(db, image_id)
    thumb = Path(str(row["thumb_path"]))
    if not thumb.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Thumbnail missing")
    return FileResponse(
        thumb,
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/{image_id}/original")
async def get_original(
    image_id: str,
    request: Request,
    range_header: str | None = Header(default=None, alias="Range"),
    _user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> Response:
    row = await _get_image_or_404(db, image_id)
    store: ImageStoreService = request.app.state.image_store

    try:
        stream = await store.open_original_stream(row, range_header=range_header)
    except RangeNotSatisfiableError as exc:
        return Response(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{exc.total_size}"},
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    headers = {
        "Content-Length": str(stream.content_length),
        "Accept-Ranges": "bytes",
        "Content-Disposition": f'inline; filename="{image_id}.png"',
    }
    status_code = status.HTTP_200_OK
    if stream.byte_range is not None:
        status_code = status.HTTP_206_PARTIAL_CONTENT
        headers["Content-Range"] = (
            f"bytes {stream.byte_range.start}-{stream.byte_range.end}/{stream.total_size}"
        )

    return StreamingResponse(
        stream.chunks,
        status_code=status_code,
        media_type=stream.content_type,
        headers=headers,
    )


@router.patch("/{image_id}")
async def patch_image(
    image_id: str,
    body: PatchImageRequest,
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict:
    row = await _get_image_or_404(db, image_id)
    if row["user_id"] != user.id and not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the image owner or an admin can modify this image",
        )
    await db.execute(
        "UPDATE images SET is_favorite = ? WHERE id = ?",
        (1 if body.is_favorite else 0, image_id),
    )
    updated = await _get_image_or_404(db, image_id)
    return {"image": _format_image_row(updated)}


@router.delete("/{image_id}")
async def delete_image(
    image_id: str,
    request: Request,
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict:
    row = await _get_image_or_404(db, image_id)
    if row["user_id"] != user.id and not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the image owner or an admin can delete this image",
        )
    store: ImageStoreService = request.app.state.image_store
    await store.delete_image(row)
    return {"ok": True}

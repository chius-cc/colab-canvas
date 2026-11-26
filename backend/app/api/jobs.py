"""Async job submission, listing, and cancellation endpoints."""

from __future__ import annotations

import json
import random
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.api.events import EventBus
from app.auth.deps import get_current_user, get_db, get_settings
from app.auth.service import QuotaService, UserRecord
from app.config import Settings
from app.db import Database
from app.worker.manager import WorkerManager
from app.workflows.registry import LoraSelection, WorkflowRegistry

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


class LoraInput(BaseModel):
    id: str
    strength: float = Field(default=0.8, ge=-2.0, le=2.0)


class CreateJobRequest(BaseModel):
    workflow_id: str = "anima"
    variant: str = "turbo"
    prompt: str = Field(..., min_length=1, max_length=4000)
    negative_prompt: str | None = Field(default=None, max_length=4000)
    width: int = 1024
    height: int = 1024
    batch_size: int = 1
    steps: int | None = None
    cfg: float | None = None
    sampler_name: str | None = None
    scheduler: str | None = None
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)
    lora_ids: list[LoraInput] = Field(default_factory=list)
    gpu_type: str = "L4"


def _format_job_row(row: Any, image_ids: list[str]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "user_id": str(row["user_id"]),
        "username": row["username"],
        "worker_id": row["worker_id"],
        "workflow_id": str(row["workflow_id"]),
        "variant": str(row["variant"]),
        "params": json.loads(str(row["params_json"])),
        "status": str(row["status"]),
        "comfy_prompt_id": row["comfy_prompt_id"],
        "progress": float(row["progress"]),
        "error_msg": row["error_msg"],
        "image_ids": image_ids,
        "created_at": str(row["created_at"]),
        "finished_at": row["finished_at"],
    }


async def _fetch_job_with_images(db: Database, job_id: str) -> dict[str, Any]:
    row = await db.fetchone(
        """
        SELECT j.*, u.username AS username
        FROM jobs j
        JOIN users u ON u.id = j.user_id
        WHERE j.id = ?
        """,
        (job_id,),
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    img_rows = await db.fetchall(
        "SELECT id FROM images WHERE job_id = ? ORDER BY created_at ASC", (job_id,)
    )
    return _format_job_row(row, [str(r["id"]) for r in img_rows])


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def submit_job(
    body: CreateJobRequest,
    request: Request,
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    workflows: WorkflowRegistry = request.app.state.workflows
    worker_manager: WorkerManager = request.app.state.worker_manager
    events: EventBus = request.app.state.events

    lora_selections: list[LoraSelection] = []
    stored_loras: list[dict[str, Any]] = []
    for item in body.lora_ids:
        lrow = await db.fetchone("SELECT * FROM loras WHERE id = ?", (item.id,))
        if lrow is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown LoRA id '{item.id}'",
            )
        lora_selections.append(
            LoraSelection(filename=str(lrow["filename"]), strength=item.strength)
        )
        stored_loras.append(
            {
                "id": str(lrow["id"]),
                "name": str(lrow["name"]),
                "filename": str(lrow["filename"]),
                "strength": item.strength,
            }
        )

    resolved_seed = (
        body.seed if body.seed is not None else random.randint(1, 2**31 - 1)
    )

    # Dry-run graph render validates workflow, variant (incl. admin_only), bounds & LoRAs
    workflows.render_prompt_graph(
        workflow_id=body.workflow_id,
        variant=body.variant,
        is_admin=user.is_admin,
        prompt=body.prompt,
        negative_prompt=body.negative_prompt,
        width=body.width,
        height=body.height,
        batch_size=body.batch_size,
        steps=body.steps,
        cfg=body.cfg,
        sampler_name=body.sampler_name,
        scheduler=body.scheduler,
        seed=resolved_seed,
        loras=lora_selections,
    )

    gpu_type = body.gpu_type.strip().upper()
    await QuotaService.check_can_submit(
        db,
        settings,
        user,
        batch_size=body.batch_size,
        gpu_type=gpu_type,
    )

    job_id = str(uuid.uuid4())
    now_iso = datetime.now(UTC).isoformat()
    params_payload = {
        "prompt": body.prompt,
        "negative_prompt": body.negative_prompt,
        "width": body.width,
        "height": body.height,
        "batch_size": body.batch_size,
        "steps": body.steps,
        "cfg": body.cfg,
        "sampler_name": body.sampler_name,
        "scheduler": body.scheduler,
        "seed": resolved_seed,
        "loras": stored_loras,
        "gpu_type": gpu_type,
        "is_admin": user.is_admin,
    }

    await db.execute(
        """
        INSERT INTO jobs (
            id, user_id, worker_id, workflow_id, variant,
            params_json, status, comfy_prompt_id, progress, error_msg, created_at, finished_at
        ) VALUES (?, ?, NULL, ?, ?, ?, 'queued', NULL, 0.0, NULL, ?, NULL)
        """,
        (job_id, user.id, body.workflow_id, body.variant, json.dumps(params_payload), now_iso),
    )

    worker_manager.notify_new_job()
    await events.publish(
        "job.updated",
        {"job_id": job_id, "status": "queued", "progress": 0.0},
        user_id=user.id,
    )
    job = await _fetch_job_with_images(db, job_id)
    return {"job": job}


@router.get("")
async def list_jobs(
    mine: bool = False,
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=40, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []
    if mine:
        clauses.append("j.user_id = ?")
        params.append(user.id)
    if status_filter:
        clauses.append("j.status = ?")
        params.append(status_filter.strip())

    where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = await db.fetchall(
        f"""
        SELECT j.*, u.username AS username
        FROM jobs j
        JOIN users u ON u.id = j.user_id
        {where_sql}
        ORDER BY j.created_at DESC
        LIMIT ? OFFSET ?
        """,
        [*params, limit, offset],
    )
    jobs: list[dict[str, Any]] = []
    for row in rows:
        img_rows = await db.fetchall(
            "SELECT id FROM images WHERE job_id = ? ORDER BY created_at ASC",
            (row["id"],),
        )
        jobs.append(_format_job_row(row, [str(r["id"]) for r in img_rows]))
    return {"jobs": jobs}


@router.get("/{job_id}")
async def get_job(
    job_id: str,
    _user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    return {"job": await _fetch_job_with_images(db, job_id)}


@router.post("/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    request: Request,
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    row = await db.fetchone("SELECT * FROM jobs WHERE id = ?", (job_id,))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if row["user_id"] != user.id and not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the job owner or an admin can cancel this job",
        )

    now_iso = datetime.now(UTC).isoformat()
    cur = await db.execute(
        """
        UPDATE jobs
        SET status = 'cancelled', finished_at = ?
        WHERE id = ? AND status = 'queued'
        """,
        (now_iso, job_id),
    )
    if cur.rowcount != 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only queued jobs can be cancelled",
        )

    events: EventBus = request.app.state.events
    await events.publish(
        "job.updated",
        {"job_id": job_id, "status": "cancelled"},
        user_id=str(row["user_id"]),
    )
    return {"job": await _fetch_job_with_images(db, job_id)}

"""Colab account pool and worker monitoring/control endpoints."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field

from app.auth.deps import get_db, require_admin
from app.auth.service import UserRecord
from app.colab.account_pool import AccountPool
from app.colab.reconcile import Reconciler
from app.db import Database
from app.worker.manager import WorkerManager

router = APIRouter(prefix="/api/pool", tags=["pool"])


class AddAccountRequest(BaseModel):
    label: str = Field(..., min_length=1, max_length=100)
    adc_json: dict[str, Any]
    priority: int = Field(default=100, ge=1, le=1000)
    min_balance_cu: float = Field(default=5.0, ge=0.0, le=10000.0)


class PatchAccountRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=100)
    priority: int | None = Field(default=None, ge=1, le=1000)
    min_balance_cu: float | None = Field(default=None, ge=0.0, le=10000.0)
    enabled: bool | None = None
    reset_unsupported_gpus: bool = False


def _format_worker_row(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "account_id": str(row["account_id"]),
        "account_label": row["account_label"],
        "endpoint": str(row["endpoint"]),
        "session_name": str(row["session_name"]),
        "origin": str(row["origin"]),
        "gpu_type": str(row["gpu_type"]),
        "status": str(row["status"]),
        "comfy_port": row["comfy_port"],
        "watchdog_port": row["watchdog_port"],
        "cached_files": json.loads(str(row["cached_files"])),
        "started_at": str(row["started_at"]),
        "last_heartbeat_at": row["last_heartbeat_at"],
        "last_activity_at": row["last_activity_at"],
        "stopped_at": row["stopped_at"],
    }


@router.get("/accounts")
async def list_accounts(
    request: Request,
    _admin: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    pool: AccountPool = request.app.state.account_pool
    return {"accounts": await pool.list_accounts()}


@router.post("/accounts", status_code=status.HTTP_201_CREATED)
async def add_account(
    body: AddAccountRequest,
    request: Request,
    _admin: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    pool: AccountPool = request.app.state.account_pool
    account = await pool.add_account(
        label=body.label,
        adc_json=body.adc_json,
        priority=body.priority,
        min_balance_cu=body.min_balance_cu,
    )
    return {"account": account}


@router.patch("/accounts/{account_id}")
async def patch_account(
    account_id: str,
    body: PatchAccountRequest,
    request: Request,
    _admin: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    pool: AccountPool = request.app.state.account_pool
    account = await pool.update_account(
        account_id,
        label=body.label,
        priority=body.priority,
        min_balance_cu=body.min_balance_cu,
        enabled=body.enabled,
        reset_unsupported_gpus=body.reset_unsupported_gpus,
    )
    return {"account": account}


@router.delete("/accounts/{account_id}")
async def delete_account(
    account_id: str,
    request: Request,
    _admin: UserRecord = Depends(require_admin),
) -> dict[str, bool]:
    pool: AccountPool = request.app.state.account_pool
    await pool.delete_account(account_id)
    return {"ok": True}


@router.post("/accounts/refresh")
async def refresh_accounts(
    request: Request,
    _admin: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    pool: AccountPool = request.app.state.account_pool
    reconciler: Reconciler = request.app.state.reconciler
    worker_manager: WorkerManager = request.app.state.worker_manager

    accounts = await pool.refresh_balances()
    reconcile_summary = await reconciler.reconcile_once(
        active_managed_endpoints=worker_manager.active_managed_endpoints,
        cleanup_unowned_managed=False,
    )
    return {"accounts": accounts, "reconcile": reconcile_summary}


@router.get("/workers")
async def list_workers(
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    rows = await db.fetchall(
        """
        SELECT w.*, a.label AS account_label
        FROM workers w
        JOIN colab_accounts a ON a.id = w.account_id
        ORDER BY w.started_at DESC
        LIMIT 30
        """
    )
    return {"workers": [_format_worker_row(r) for r in rows]}


@router.post("/workers/{worker_id}/stop")
async def stop_worker(
    worker_id: str,
    request: Request,
    _admin: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    worker_manager: WorkerManager = request.app.state.worker_manager
    worker = await worker_manager.emergency_stop_worker(worker_id)
    row = await request.app.state.db.fetchone(
        """
        SELECT w.*, a.label AS account_label
        FROM workers w
        JOIN colab_accounts a ON a.id = w.account_id
        WHERE w.id = ?
        """,
        (worker["id"],),
    )
    assert row is not None
    return {"worker": _format_worker_row(row)}

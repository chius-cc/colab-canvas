"""Workflow registry endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.auth.deps import get_current_user
from app.auth.service import UserRecord
from app.workflows.registry import WorkflowRegistry

router = APIRouter(prefix="/api/workflows", tags=["workflows"])


@router.get("")
async def list_workflows(
    request: Request,
    user: UserRecord = Depends(get_current_user),
) -> dict:
    registry: WorkflowRegistry = request.app.state.workflows
    return {"workflows": registry.list_for_user(is_admin=user.is_admin)}

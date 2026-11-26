"""AI Creative Copilot routes (`/api/assistant/*`)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.assistant.service import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_TEMPERATURE,
    ChatMessage,
    build_system_prompt,
    decrypt_api_key,
    get_assistant_config,
    probe_models,
    save_assistant_config,
    serialize_admin_config,
    serialize_public_status,
    stream_chat_completion,
)
from app.auth.deps import get_current_user, get_db, require_admin
from app.auth.service import UserRecord
from app.db import Database
from app.security.crypto import CryptoError, SecretBox
from app.workflows.registry import WorkflowRegistry

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class UpdateAssistantConfigRequest(BaseModel):
    enabled: bool = False
    base_url: str = Field(default="", max_length=512)
    api_key: str | None = Field(default=None, max_length=512)
    clear_api_key: bool = False
    model: str = Field(default="", max_length=256)
    system_prompt: str | None = Field(default="", max_length=4000)
    temperature: float | None = Field(default=DEFAULT_TEMPERATURE, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=DEFAULT_MAX_TOKENS, ge=64, le=8192)


class ProbeModelsRequest(BaseModel):
    base_url: str | None = Field(default=None, max_length=512)
    api_key: str | None = Field(default=None, max_length=512)
    clear_api_key: bool = False


class AssistantChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list, max_length=50)
    locale: Literal["zh", "en"] = "zh"
    mode: Literal["chat", "polish", "variations", "diagnose"] = "chat"
    studio_context: dict[str, Any] | None = None


@router.get("/status")
async def get_status(
    _user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    config = await get_assistant_config(db)
    return serialize_public_status(config)


@router.get("/config")
async def get_config(
    request: Request,
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    crypto: SecretBox = request.app.state.crypto
    config = await get_assistant_config(db)
    return {"config": serialize_admin_config(config, crypto)}


@router.put("/config")
async def put_config(
    body: UpdateAssistantConfigRequest,
    request: Request,
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    crypto: SecretBox = request.app.state.crypto
    saved = await save_assistant_config(
        db,
        crypto,
        enabled=body.enabled,
        base_url=body.base_url,
        api_key=body.api_key,
        clear_api_key=body.clear_api_key,
        model=body.model,
        system_prompt=body.system_prompt or "",
        temperature=DEFAULT_TEMPERATURE if body.temperature is None else body.temperature,
        max_tokens=DEFAULT_MAX_TOKENS if body.max_tokens is None else body.max_tokens,
    )
    return {"config": serialize_admin_config(saved, crypto)}


@router.post("/models")
async def list_upstream_models(
    request: Request,
    body: ProbeModelsRequest | None = None,
    _admin: UserRecord = Depends(require_admin),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    crypto: SecretBox = request.app.state.crypto
    req = body or ProbeModelsRequest()
    return await probe_models(
        db,
        crypto,
        base_url=req.base_url,
        api_key=req.api_key,
        clear_api_key=req.clear_api_key,
    )


@router.post("/chat")
async def assistant_chat(
    body: AssistantChatRequest,
    request: Request,
    user: UserRecord = Depends(get_current_user),
    db: Database = Depends(get_db),
) -> StreamingResponse:
    config = await get_assistant_config(db)
    if not config.enabled or not config.base_url or not config.model:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI assistant is disabled or not yet configured",
        )

    messages = [
        ChatMessage(role=m.role, content=m.content.strip())
        for m in body.messages
        if m.content.strip()
    ]
    if not messages:
        if body.mode == "chat":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="At least one non-empty message is required",
            )
        fallback_prompt = {
            "polish": "Please polish my current Studio prompt and settings.",
            "variations": "Please create 3 distinct creative variations from my Studio context.",
            "diagnose": "Please diagnose my current Studio settings and suggest improvements.",
        }[body.mode]
        messages = [ChatMessage(role="user", content=fallback_prompt)]

    crypto: SecretBox = request.app.state.crypto
    try:
        api_key = decrypt_api_key(crypto, config)
    except CryptoError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stored assistant API key cannot be decrypted; reconfigure in admin settings",
        ) from exc

    workflows: WorkflowRegistry = request.app.state.workflows
    system_prompt = await build_system_prompt(
        db=db,
        workflows=workflows,
        user=user,
        config=config,
        locale=body.locale,
        mode=body.mode,
        studio_context=body.studio_context,
    )

    return StreamingResponse(
        stream_chat_completion(
            request=request,
            config=config,
            api_key=api_key,
            system_prompt=system_prompt,
            messages=messages,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

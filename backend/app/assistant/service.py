"""OpenAI-compatible AI Creative Copilot service, config storage, and SSE proxy."""

from __future__ import annotations

import json
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, Request, status
from pydantic import BaseModel, Field

from app.auth.service import ALLOWED_GPU_CHOICES, UserRecord
from app.db import Database
from app.security.crypto import CryptoError, SecretBox
from app.workflows.registry import WorkflowRegistry

ASSISTANT_CONFIG_KEY = "assistant_config"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 1024
MAX_HISTORY_MESSAGES = 24
MAX_STUDIO_CONTEXT_CHARS = 4000

_BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-+/=]+", re.IGNORECASE)


@dataclass(frozen=True)
class AssistantConfigRecord:
    enabled: bool
    base_url: str
    api_key_encrypted: str
    model: str
    system_prompt: str
    temperature: float
    max_tokens: int
    updated_at: str | None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=16000)


def mask_api_key(api_key: str | None) -> str:
    """Mask an API key for safe admin UI display (never returns plaintext)."""
    if not api_key:
        return ""
    cleaned = api_key.strip()
    if not cleaned:
        return ""
    if len(cleaned) < 8:
        return "••••"
    return f"{cleaned[:3]}••••{cleaned[-4:]}"


def sanitize_secret(text: str, secret: str = "") -> str:
    """Redact API keys and Bearer tokens from upstream error strings."""
    cleaned = _BEARER_RE.sub(r"\1[REDACTED]", text)
    if secret and len(secret) >= 4:
        cleaned = cleaned.replace(secret, "[REDACTED]")
    return cleaned


def normalize_and_validate_base_url(raw_url: str, *, allow_empty: bool = False) -> str:
    """Validate an http(s) base URL and strip trailing slashes cleanly."""
    cleaned = raw_url.strip()
    if not cleaned:
        if allow_empty:
            return ""
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="base_url must start with http:// or https://",
        )
    if any(ch.isspace() for ch in cleaned):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="base_url must not contain whitespace",
        )

    parsed = urlparse(cleaned)
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="base_url must start with http:// or https://",
        )
    try:
        _ = parsed.port
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="base_url contains an invalid port",
        ) from exc

    if not parsed.hostname or not parsed.netloc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="base_url must include a valid host",
        )
    if parsed.fragment:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="base_url must not include a URL fragment",
        )

    normalized = cleaned.rstrip("/")
    return normalized


def _coerce_config(data: dict[str, Any], updated_at: str | None) -> AssistantConfigRecord:
    try:
        temp = float(data.get("temperature", DEFAULT_TEMPERATURE))
    except (TypeError, ValueError):
        temp = DEFAULT_TEMPERATURE
    temp = max(0.0, min(2.0, temp))

    try:
        max_tok = int(data.get("max_tokens", DEFAULT_MAX_TOKENS))
    except (TypeError, ValueError):
        max_tok = DEFAULT_MAX_TOKENS
    max_tok = max(64, min(8192, max_tok))

    raw_updated = data.get("updated_at")
    eff_updated = str(raw_updated) if raw_updated else updated_at

    return AssistantConfigRecord(
        enabled=bool(data.get("enabled", False)),
        base_url=str(data.get("base_url", "") or "").strip().rstrip("/"),
        api_key_encrypted=str(data.get("api_key_encrypted", "") or ""),
        model=str(data.get("model", "") or "").strip(),
        system_prompt=str(data.get("system_prompt", "") or ""),
        temperature=temp,
        max_tokens=max_tok,
        updated_at=eff_updated,
    )


async def get_assistant_config(db: Database) -> AssistantConfigRecord:
    """Load persisted assistant configuration from SQLite `app_settings`."""
    row = await db.fetchone(
        "SELECT value_json, updated_at FROM app_settings WHERE key = ?",
        (ASSISTANT_CONFIG_KEY,),
    )
    if row is None:
        return AssistantConfigRecord(
            enabled=False,
            base_url="",
            api_key_encrypted="",
            model="",
            system_prompt="",
            temperature=DEFAULT_TEMPERATURE,
            max_tokens=DEFAULT_MAX_TOKENS,
            updated_at=None,
        )
    try:
        data = json.loads(str(row["value_json"]))
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return _coerce_config(data, str(row["updated_at"]) if row["updated_at"] else None)


def decrypt_api_key(crypto: SecretBox, config: AssistantConfigRecord) -> str:
    """Decrypt stored API key if present."""
    if not config.api_key_encrypted:
        return ""
    return crypto.decrypt_text(config.api_key_encrypted)


def serialize_admin_config(
    config: AssistantConfigRecord, crypto: SecretBox
) -> dict[str, Any]:
    """Serialize assistant config for admin endpoints with masked key only."""
    has_key = bool(config.api_key_encrypted)
    masked = ""
    if has_key:
        try:
            plaintext = decrypt_api_key(crypto, config)
            masked = mask_api_key(plaintext)
            has_key = bool(plaintext.strip())
        except CryptoError:
            masked = "••••"
    return {
        "enabled": config.enabled,
        "base_url": config.base_url,
        "has_api_key": has_key,
        "api_key_masked": masked,
        "model": config.model,
        "system_prompt": config.system_prompt,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "updated_at": config.updated_at,
    }


def serialize_public_status(config: AssistantConfigRecord) -> dict[str, Any]:
    """Serialize minimal assistant availability for non-admin users."""
    configured = bool(config.base_url and config.model)
    return {
        "enabled": config.enabled,
        "configured": configured,
        "model": config.model or None,
    }


async def save_assistant_config(
    db: Database,
    crypto: SecretBox,
    *,
    enabled: bool,
    base_url: str,
    api_key: str | None,
    clear_api_key: bool,
    model: str,
    system_prompt: str,
    temperature: float,
    max_tokens: int,
) -> AssistantConfigRecord:
    """Validate, encrypt key if provided, and persist assistant config."""
    existing = await get_assistant_config(db)
    normalized_url = normalize_and_validate_base_url(
        base_url, allow_empty=(not enabled)
    )

    if clear_api_key:
        encrypted_key = ""
    elif api_key is not None and api_key.strip() != "":
        encrypted_key = crypto.encrypt_text(api_key.strip())
    else:
        encrypted_key = existing.api_key_encrypted

    now_iso = datetime.now(UTC).isoformat()
    payload = {
        "enabled": bool(enabled),
        "base_url": normalized_url,
        "api_key_encrypted": encrypted_key,
        "model": model.strip(),
        "system_prompt": system_prompt.strip(),
        "temperature": float(temperature),
        "max_tokens": int(max_tokens),
        "updated_at": now_iso,
    }
    await db.execute(
        """
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        """,
        (ASSISTANT_CONFIG_KEY, json.dumps(payload, separators=(",", ":")), now_iso),
    )
    return _coerce_config(payload, now_iso)


def _extract_model_ids(payload: Any) -> list[str]:
    """Extract unique model identifiers from OpenAI-compatible /models responses."""
    raw_items: list[Any] = []
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), list):
            raw_items = payload["data"]
        elif isinstance(payload.get("models"), list):
            raw_items = payload["models"]
    elif isinstance(payload, list):
        raw_items = payload

    seen: set[str] = set()
    models: list[str] = []
    for item in raw_items:
        model_id = ""
        if isinstance(item, str):
            model_id = item.strip()
        elif isinstance(item, dict):
            val = item.get("id") or item.get("name") or item.get("model")
            if isinstance(val, str):
                model_id = val.strip()
        if model_id and model_id not in seen:
            seen.add(model_id)
            models.append(model_id)
    return models


def _extract_upstream_error_message(raw_body: bytes, secret: str) -> str:
    """Safely extract a concise error message from an upstream response body."""
    if not raw_body:
        return ""
    text = raw_body.decode("utf-8", errors="replace").strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None

    detail = ""
    if isinstance(parsed, dict):
        err = parsed.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("code")
            if isinstance(msg, str):
                detail = msg.strip()
        elif isinstance(err, str):
            detail = err.strip()
        elif isinstance(parsed.get("message"), str):
            detail = parsed["message"].strip()
        elif isinstance(parsed.get("detail"), str):
            detail = parsed["detail"].strip()
    if not detail and not text.lstrip().startswith("<"):
        detail = text

    detail = sanitize_secret(" ".join(detail.split()), secret)
    if len(detail) > 220:
        detail = detail[:217] + "..."
    return detail


def _format_upstream_http_error(status_code: int, raw_body: bytes, secret: str) -> str:
    detail = _extract_upstream_error_message(raw_body, secret)
    if status_code == 401:
        base = "Authentication failed (HTTP 401): check your API key."
    elif status_code == 403:
        base = "Access denied by upstream endpoint (HTTP 403)."
    elif status_code == 404:
        base = "Upstream endpoint or model not found (HTTP 404): check Base URL and Model."
    elif status_code == 429:
        base = "Upstream rate limit exceeded (HTTP 429): please retry shortly."
    else:
        base = f"Upstream request failed (HTTP {status_code})."
    return f"{base} {detail}".strip() if detail and status_code not in (401, 403) else base


async def probe_models(
    db: Database,
    crypto: SecretBox,
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    clear_api_key: bool = False,
) -> dict[str, Any]:
    """Probe `GET {base_url}/models` using supplied overrides or stored config."""
    saved = await get_assistant_config(db)
    raw_url = base_url.strip() if base_url is not None and base_url.strip() else saved.base_url
    try:
        target_base = normalize_and_validate_base_url(raw_url, allow_empty=False)
    except HTTPException as exc:
        return {"ok": False, "status_code": None, "error": str(exc.detail)}

    effective_key = ""
    if not clear_api_key:
        if api_key is not None and api_key.strip():
            effective_key = api_key.strip()
        elif saved.api_key_encrypted:
            try:
                effective_key = decrypt_api_key(crypto, saved)
            except CryptoError:
                return {
                    "ok": False,
                    "status_code": None,
                    "error": "Saved API key cannot be decrypted; re-enter your API key.",
                }

    models_url = f"{target_base}/models"
    headers: dict[str, str] = {"Accept": "application/json"}
    if effective_key:
        headers["Authorization"] = f"Bearer {effective_key}"

    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(models_url, headers=headers)
    except httpx.TimeoutException:
        return {
            "ok": False,
            "status_code": None,
            "error": "Connection timed out while fetching /models.",
        }
    except httpx.RequestError as exc:
        return {
            "ok": False,
            "status_code": None,
            "error": sanitize_secret(
                f"Connection failed ({type(exc).__name__}).", effective_key
            ),
        }

    latency_ms = max(0, int((time.monotonic() - started) * 1000))
    if resp.status_code >= 400:
        return {
            "ok": False,
            "status_code": resp.status_code,
            "error": _format_upstream_http_error(
                resp.status_code, resp.content, effective_key
            ),
        }

    try:
        payload = resp.json()
    except ValueError:
        return {
            "ok": False,
            "status_code": resp.status_code,
            "error": "Endpoint returned invalid JSON for /models.",
        }

    models = _extract_model_ids(payload)
    return {
        "ok": True,
        "latency_ms": latency_ms,
        "models": models,
    }


def _describe_visible_workflows(workflows: WorkflowRegistry, *, is_admin: bool) -> str:
    items = workflows.list_for_user(is_admin=is_admin)
    if not items:
        return "No workflows currently loaded."

    lines: list[str] = []
    for wf in items:
        bounds = wf.get("bounds") or {}
        presets = wf.get("resolution_presets") or []
        preset_str = ", ".join(
            f"{p['label']} ({p['width']}x{p['height']})" for p in presets
        )
        default_gpu = str(wf.get("default_gpu") or "L4").upper()
        if default_gpu not in ALLOWED_GPU_CHOICES:
            default_gpu = "L4"

        lines.append(
            f"- Workflow `{wf['id']}` ({wf['name']}): {wf.get('description', '')} | "
            f"default_variant=`{wf.get('default_variant')}` | default_gpu={default_gpu} | "
            f"supports_loras={wf.get('supports_loras')} (max {wf.get('max_loras', 0)})"
        )
        if wf.get("prompt_hint"):
            lines.append(f"  Prompting note: {wf['prompt_hint']}")
        if preset_str:
            lines.append(f"  Resolution presets: {preset_str}")
        if bounds:
            lines.append(
                "  Bounds: "
                f"width/height {bounds.get('min_dimension')}-{bounds.get('max_dimension')} "
                f"(step {bounds.get('dimension_step')}), "
                f"steps {bounds.get('min_steps')}-{bounds.get('max_steps')}, "
                f"cfg {bounds.get('min_cfg')}-{bounds.get('max_cfg')}, "
                f"samplers={', '.join(bounds.get('allowed_samplers', []))}, "
                f"schedulers={', '.join(bounds.get('allowed_schedulers', []))}"
            )
        variants = wf.get("variants") or {}
        if variants:
            lines.append("  Available variants:")
            for v_id, v_info in variants.items():
                defaults = v_info.get("defaults") or {}
                lines.append(
                    f"    * `{v_id}` ({v_info.get('label', v_id)}): "
                    f"{v_info.get('description', '')} — defaults: "
                    f"steps={defaults.get('steps')}, cfg={defaults.get('cfg')}, "
                    f"sampler={defaults.get('sampler_name')}, "
                    f"scheduler={defaults.get('scheduler')}"
                )
    return "\n".join(lines)


async def _describe_registered_loras(db: Database) -> str:
    rows = await db.fetchall(
        "SELECT id, name, default_weight, trigger_words FROM loras ORDER BY created_at DESC"
    )
    if not rows:
        return "No LoRAs are currently registered (`loras` should be `[]`)."
    lines: list[str] = []
    for row in rows:
        triggers = str(row["trigger_words"] or "").strip()
        trigger_note = f'trigger_words="{triggers}"' if triggers else "trigger_words=(none)"
        lines.append(
            f'- id="{row["id"]}" | name="{row["name"]}" | '
            f'default_weight={float(row["default_weight"]):.2f} | {trigger_note}'
        )
    return "\n".join(lines)


def _format_mode_directive(
    mode: Literal["chat", "polish", "variations", "diagnose"],
    studio_context: dict[str, Any] | None,
) -> str:
    mode_instructions = {
        "chat": (
            "Mode: `chat` — Answer concisely as a creative art director & Colab Canvas guide. "
            "Whenever you propose concrete generation parameters, include fenced `canvas-recipe` "
            "JSON block(s)."
        ),
        "polish": (
            "Mode: `polish` — Refine the user's idea or current Studio draft into exactly 1 crisp, "
            "high-impact `canvas-recipe` block (removing any SDXL weight syntax, strengthening "
            "subject/composition/lighting tags, and matching variant step/CFG sweet spots), plus "
            "a brief 1-2 sentence explanation."
        ),
        "variations": (
            "Mode: `variations` — Generate exactly 3 distinct `canvas-recipe` blocks exploring "
            "different lighting, framing, mood, or aesthetic styles from the user's concept or "
            "current Studio draft, each with a concise title."
        ),
        "diagnose": (
            "Mode: `diagnose` — Audit the user's current Studio parameters & prompt (check "
            "variant vs steps/CFG alignment, Qwen3-0.6B/Danbooru syntax vs forbidden CLIP weights, "
            "resolution step multiples, and LoRA triggers/weights), briefly explain what to fix, "
            "and provide 1 corrected `canvas-recipe` block."
        ),
    }

    parts = [mode_instructions[mode]]
    if studio_context:
        ctx_json = json.dumps(studio_context, ensure_ascii=False, separators=(",", ":"))
        if len(ctx_json) > MAX_STUDIO_CONTEXT_CHARS:
            ctx_json = ctx_json[:MAX_STUDIO_CONTEXT_CHARS] + "...(truncated)"
        parts.append(f"Current Studio Context (JSON):\n{ctx_json}")
    return "\n".join(parts)


async def build_system_prompt(
    *,
    db: Database,
    workflows: WorkflowRegistry,
    user: UserRecord,
    config: AssistantConfigRecord,
    locale: Literal["zh", "en"],
    mode: Literal["chat", "polish", "variations", "diagnose"],
    studio_context: dict[str, Any] | None,
) -> str:
    """Build dynamic server-side system prompt grounded in live workflows, LoRAs, and role."""
    lang_directive = (
        "Respond to the user in concise Simplified Chinese (简体中文). "
        "Keep `prompt` and `negative_prompt` fields inside `canvas-recipe` JSON in English."
        if locale == "zh"
        else "Respond to the user in concise English."
    )

    user_gpus = [
        g for g in user.allowed_gpus if str(g).upper() in ALLOWED_GPU_CHOICES
    ] or ["L4"]
    workflow_section = _describe_visible_workflows(workflows, is_admin=user.is_admin)
    lora_section = await _describe_registered_loras(db)
    mode_section = _format_mode_directive(mode, studio_context)

    sections = [
        (
            "You are the AI Creative Copilot for `Colab Canvas` — a fast, concise creative art "
            "director and site guide.\n"
            f"{lang_directive}\n"
            "Keep explanations sharp and practical without filler. In `Colab Canvas`, users "
            "compose prompts in Studio (`#studio`), browse results in Gallery (`#gallery`), and "
            "manage settings or personal account preferences under Admin/Account."
        ),
        (
            "## Compute & Allowed GPUs\n"
            f"- Supported GPU tiers in Colab Canvas: {', '.join(ALLOWED_GPU_CHOICES)} "
            "(default: L4).\n"
            f"- Current user's allowed GPUs: {', '.join(user_gpus)}."
        ),
        f"## Available Workflows & Variants\n{workflow_section}",
        (
            "## Registered LoRAs\n"
            "Only reference LoRA `id` values listed below (never invent IDs):\n"
            f"{lora_section}"
        ),
        (
            "## Anima (Qwen3-0.6B) Prompting Rules\n"
            "- Anima uses a Qwen3-0.6B text encoder + Cosmos-Predict2-2B backbone: write concise "
            "English Danbooru tags combined with crisp natural-language scene, lighting, and "
            "camera descriptions.\n"
            "- Do NOT use SDXL/A1111 CLIP emphasis syntax such as `(tag:1.3)` or `((tag))`.\n"
            "- Match parameters to the chosen visible variant: e.g. `turbo` runs best at 8-12 "
            "steps with CFG 1.0; `aesthetic` runs best at ~30 steps (around CFG 4.0).\n"
            "- Keep `width` and `height` as multiples of 64 within 512-1536."
        ),
        (
            "## Recipe Output Format\n"
            "Whenever recommending concrete generation parameters, output one or more fenced "
            "`canvas-recipe` JSON code blocks using this exact schema and keys:\n"
            "```canvas-recipe\n"
            "{\n"
            '  "title": "Short descriptive title",\n'
            '  "prompt": "masterpiece, best quality, 1girl, ...",\n'
            '  "negative_prompt": "worst quality, low quality, blurry, jpeg artifacts",\n'
            '  "variant": "turbo",\n'
            '  "width": 1024,\n'
            '  "height": 1024,\n'
            '  "steps": 10,\n'
            '  "cfg": 1.0,\n'
            '  "loras": [{"id": "<registered-lora-id>", "strength": 0.8}]\n'
            "}\n"
            "```\n"
            "Use `\"loras\": []` when no LoRA is needed, and only use variants listed in "
            "Available Workflows & Variants above."
        ),
        f"## Task Mode & Context\n{mode_section}",
    ]

    if config.system_prompt.strip():
        sections.append(f"## Additional Studio Instructions\n{config.system_prompt.strip()}")

    return "\n\n".join(sections)


def _sse_event(event: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


def _extract_non_streaming_response(
    payload: Any, secret: str
) -> tuple[str | None, str, str | None]:
    """Return `(content, finish_reason, error_message)` from a non-streaming JSON body."""
    if not isinstance(payload, dict):
        return None, "stop", "Upstream returned an unexpected response shape."
    if payload.get("error"):
        err = payload["error"]
        if isinstance(err, dict):
            msg = str(err.get("message") or err.get("code") or "Upstream model error")
        else:
            msg = str(err)
        return None, "error", sanitize_secret(msg, secret)

    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None, "stop", "Upstream response contained no choices."

    choice = choices[0] if isinstance(choices[0], dict) else {}
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
    content = message.get("content")
    if content is None:
        content = delta.get("content")
    if content is None:
        content = choice.get("text")
    finish_reason = str(choice.get("finish_reason") or "stop")
    return (content if isinstance(content, str) else None), finish_reason, None


async def stream_chat_completion(
    *,
    request: Request,
    config: AssistantConfigRecord,
    api_key: str,
    system_prompt: str,
    messages: list[ChatMessage],
) -> AsyncIterator[str]:
    """Stream SSE events (`delta`, `done`, `error`) from an OpenAI-compatible chat endpoint."""
    # Flush immediately so Cloudflare + Caddy do not buffer the initial SSE response.
    yield ": connected\n\n"

    chat_url = f"{config.base_url}/chat/completions"
    trimmed_history = messages[-MAX_HISTORY_MESSAGES:]
    payload = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            *[{"role": m.role, "content": m.content} for m in trimmed_history],
        ],
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "stream": True,
    }
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    timeout = httpx.Timeout(60.0, connect=15.0)
    try:
        async with (
            httpx.AsyncClient(timeout=timeout) as client,
            client.stream("POST", chat_url, headers=headers, json=payload) as resp,
        ):
            if resp.status_code >= 400:
                raw_err = await resp.aread()
                yield _sse_event(
                    "error",
                    {
                        "message": _format_upstream_http_error(
                            resp.status_code, raw_err, api_key
                        )
                    },
                )
                return

            content_type = resp.headers.get("content-type", "").lower()
            if "application/json" in content_type and "text/event-stream" not in content_type:
                raw_json = await resp.aread()
                try:
                    parsed = json.loads(raw_json.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    yield _sse_event(
                        "error", {"message": "Upstream returned invalid JSON response."}
                    )
                    return
                content, finish_reason, err_msg = _extract_non_streaming_response(
                    parsed, api_key
                )
                if err_msg:
                    yield _sse_event("error", {"message": err_msg})
                    return
                if content:
                    yield _sse_event("delta", {"content": content})
                yield _sse_event("done", {"finish_reason": finish_reason})
                return

            last_finish_reason: str | None = None
            sent_done = False
            saw_sse_data = False
            fallback_lines: list[str] = []

            async for line in resp.aiter_lines():
                if await request.is_disconnected():
                    return
                if not line:
                    continue
                if line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    continue
                if not line.startswith("data:"):
                    if not saw_sse_data:
                        fallback_lines.append(line)
                    continue

                saw_sse_data = True
                data_str = line[5:]
                if data_str.startswith(" "):
                    data_str = data_str[1:]
                data_str = data_str.strip()
                if not data_str:
                    continue
                if data_str == "[DONE]":
                    yield _sse_event(
                        "done", {"finish_reason": last_finish_reason or "stop"}
                    )
                    sent_done = True
                    break

                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                if isinstance(chunk, dict) and chunk.get("error"):
                    err = chunk["error"]
                    err_text = (
                        str(err.get("message") or err)
                        if isinstance(err, dict)
                        else str(err)
                    )
                    yield _sse_event(
                        "error", {"message": sanitize_secret(err_text, api_key)}
                    )
                    return

                choices = chunk.get("choices") if isinstance(chunk, dict) else None
                if not isinstance(choices, list) or not choices:
                    continue

                choice = choices[0] if isinstance(choices[0], dict) else {}
                delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                msg = choice.get("message") if isinstance(choice.get("message"), dict) else {}
                token = delta.get("content")
                if token is None:
                    token = msg.get("content")
                if isinstance(token, str) and token:
                    yield _sse_event("delta", {"content": token})

                fr = choice.get("finish_reason")
                if fr is not None:
                    last_finish_reason = str(fr)

            if not saw_sse_data and fallback_lines:
                raw_fallback = "\n".join(fallback_lines).strip()
                try:
                    parsed = json.loads(raw_fallback)
                except json.JSONDecodeError:
                    yield _sse_event(
                        "error",
                        {"message": "Upstream stream returned unrecognized response."},
                    )
                    return
                content, finish_reason, err_msg = _extract_non_streaming_response(
                    parsed, api_key
                )
                if err_msg:
                    yield _sse_event("error", {"message": err_msg})
                    return
                if content:
                    yield _sse_event("delta", {"content": content})
                yield _sse_event("done", {"finish_reason": finish_reason})
                return

            if not sent_done:
                yield _sse_event(
                    "done", {"finish_reason": last_finish_reason or "stop"}
                )
    except httpx.TimeoutException:
        yield _sse_event(
            "error", {"message": "Upstream assistant request timed out."}
        )
    except httpx.RequestError as exc:
        yield _sse_event(
            "error",
            {
                "message": sanitize_secret(
                    f"Upstream connection error ({type(exc).__name__}).", api_key
                )
            },
        )
    except Exception as exc:  # pragma: no cover - defensive SSE stream guard
        yield _sse_event(
            "error",
            {
                "message": sanitize_secret(
                    f"Assistant streaming error ({type(exc).__name__}).", api_key
                )
            },
        )

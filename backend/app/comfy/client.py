"""Async ComfyUI API client (prompt submission, WS progress, /history recovery, /view)."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import websockets


class ComfyClientError(RuntimeError):
    """Base error raised by ComfyClient."""


class ComfyExecutionError(ComfyClientError):
    """Raised when ComfyUI reports an execution_error for a prompt."""


class ComfyConnectionError(ComfyClientError):
    """Raised when HTTP/WebSocket transport drops mid-operation."""


class ComfyClient:
    """Async client communicating with tunneled headless ComfyUI (:8188)."""

    def __init__(self, base_http_url: str) -> None:
        self.base_http_url = base_http_url.rstrip("/")

    async def system_stats(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{self.base_http_url}/system_stats")
                resp.raise_for_status()
                return dict(resp.json())
        except httpx.HTTPError as exc:
            raise ComfyConnectionError(f"system_stats failed: {exc}") from exc

    async def queue_status(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{self.base_http_url}/queue")
                resp.raise_for_status()
                return dict(resp.json())
        except httpx.HTTPError as exc:
            raise ComfyConnectionError(f"queue_status failed: {exc}") from exc

    async def submit_prompt(self, graph: dict[str, Any], client_id: str) -> str:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{self.base_http_url}/prompt",
                    json={"prompt": graph, "client_id": client_id},
                )
                resp.raise_for_status()
                return str(resp.json()["prompt_id"])
        except httpx.HTTPError as exc:
            raise ComfyConnectionError(f"submit_prompt failed: {exc}") from exc

    async def wait_for_completion(
        self,
        prompt_id: str,
        client_id: str,
        *,
        on_progress: Callable[[float], Awaitable[None]] | None = None,
        timeout: float = 600.0,
    ) -> None:
        ws_url = (
            self.base_http_url.replace("https://", "wss://").replace("http://", "ws://")
            + f"/ws?clientId={client_id}"
        )
        deadline = time.monotonic() + timeout
        try:
            async with websockets.connect(ws_url, open_timeout=20, close_timeout=5) as ws:
                while time.monotonic() < deadline:
                    remaining = max(0.1, min(2.0, deadline - time.monotonic()))
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    except TimeoutError:
                        continue
                    if isinstance(raw, bytes):
                        continue
                    msg = json.loads(raw)
                    mtype = msg.get("type")
                    data = msg.get("data", {})
                    if data.get("prompt_id") != prompt_id:
                        continue
                    if mtype == "progress" and on_progress is not None:
                        val = float(data.get("value", 0))
                        mx = max(1.0, float(data.get("max", 1)))
                        await on_progress(min(0.99, max(0.0, val / mx)))
                    elif mtype == "execution_error":
                        raise ComfyExecutionError(
                            str(data.get("exception_message") or json.dumps(data))
                        )
                    elif mtype == "executing" and data.get("node") is None:
                        return
                raise TimeoutError(f"ComfyUI WebSocket timed out for prompt {prompt_id}")
        except (ComfyExecutionError, TimeoutError):
            raise
        except Exception as exc:
            raise ComfyConnectionError(f"ComfyUI WebSocket disconnected: {exc}") from exc

    async def wait_history_outputs(
        self, prompt_id: str, *, timeout: float = 120.0
    ) -> list[dict[str, Any]]:
        deadline = time.monotonic() + timeout
        async with httpx.AsyncClient(timeout=15.0) as client:
            while time.monotonic() < deadline:
                try:
                    resp = await client.get(f"{self.base_http_url}/history/{prompt_id}")
                    resp.raise_for_status()
                    hist = resp.json()
                except httpx.HTTPError as exc:
                    raise ComfyConnectionError(f"history poll failed: {exc}") from exc

                entry = hist.get(prompt_id)
                if entry:
                    status_info = entry.get("status", {})
                    if status_info.get("status_str") == "error":
                        raise ComfyExecutionError(
                            f"ComfyUI reported error in history: {status_info}"
                        )
                    outputs = entry.get("outputs", {})
                    if "9" in outputs and "images" in outputs["9"]:
                        return list(outputs["9"]["images"])
                    for node_out in outputs.values():
                        if isinstance(node_out, dict) and node_out.get("images"):
                            return list(node_out["images"])
                await asyncio.sleep(1.0)
        raise TimeoutError(f"Timed out waiting for /history/{prompt_id}")

    async def fetch_image_bytes(
        self,
        filename: str,
        subfolder: str = "",
        folder_type: str = "output",
    ) -> bytes:
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.get(
                    f"{self.base_http_url}/view",
                    params={
                        "filename": filename,
                        "subfolder": subfolder,
                        "type": folder_type,
                    },
                )
                resp.raise_for_status()
                return bytes(resp.content)
        except httpx.HTTPError as exc:
            raise ComfyConnectionError(f"/view fetch failed: {exc}") from exc

    async def interrupt(self) -> None:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{self.base_http_url}/interrupt")
        except httpx.HTTPError:
            pass

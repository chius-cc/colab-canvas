"""Tests for WorkflowRegistry, LoRA registry validation, and SSE EventBus."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from app.auth.service import UserRecord
from app.main import create_app
from app.workflows.registry import LoraSelection
from tests.conftest import make_test_settings


async def test_workflow_registry_and_lora_admin_guards(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
    )
    app = create_app(
        settings,
        start_background_uploader=False,
        start_background_workers=False,
    )

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )

        # Admin sees all 3 variants including base
        admin_wfs = (await client.get("/api/workflows")).json()["workflows"]
        assert len(admin_wfs) == 1
        assert set(admin_wfs[0]["variants"].keys()) == {"turbo", "aesthetic", "base"}

        # Register valid HF LoRA
        lora_ok = await client.post(
            "/api/loras",
            json={
                "name": "Highres Aesthetic Boost",
                "source_type": "hf",
                "source_url": "https://huggingface.co/circlestone-labs/Anima-Official-LoRAs/resolve/main/anima-highres-aesthetic-boost.safetensors",
                "filename": "anima-highres-aesthetic-boost.safetensors",
                "default_weight": 0.8,
            },
        )
        assert lora_ok.status_code == 201

        # Reject duplicate filename, path traversal, and untrusted URL host
        assert (
            await client.post(
                "/api/loras",
                json={
                    "name": "Dup",
                    "source_type": "hf",
                    "source_url": "https://huggingface.co/a/b/c.safetensors",
                    "filename": "anima-highres-aesthetic-boost.safetensors",
                },
            )
        ).status_code == 409

        assert (
            await client.post(
                "/api/loras",
                json={
                    "name": "Traversal",
                    "source_type": "hf",
                    "source_url": "https://huggingface.co/a/b/c.safetensors",
                    "filename": "../evil.safetensors",
                },
            )
        ).status_code == 400

        assert (
            await client.post(
                "/api/loras",
                json={
                    "name": "BadHost",
                    "source_type": "hf",
                    "source_url": "https://evil.example.com/evil.safetensors",
                    "filename": "evil.safetensors",
                },
            )
        ).status_code == 400

        # Render ComfyUI prompt graph with chained LoRAs
        graph = app.state.workflows.render_prompt_graph(
            workflow_id="anima",
            variant="turbo",
            is_admin=False,
            prompt="1girl, sunlit train station",
            loras=[
                LoraSelection(filename="lora_a.safetensors", strength=0.7),
                LoraSelection(filename="lora_b.safetensors", strength=0.5),
            ],
            filename_prefix="job_123",
        )
        assert graph["1"]["inputs"]["unet_name"] == "anima-turbo-v1.1.safetensors"
        assert graph["100"]["inputs"]["model"] == ["1", 0]
        assert graph["101"]["inputs"]["model"] == ["100", 0]
        assert graph["7"]["inputs"]["model"] == ["101", 0]
        assert graph["9"]["inputs"]["filename_prefix"] == "job_123"

        # Non-admin blocked from rendering admin_only 'base' variant
        with pytest.raises(HTTPException) as exc_base:
            app.state.workflows.render_prompt_graph(
                workflow_id="anima",
                variant="base",
                is_admin=False,
                prompt="test",
            )
        assert exc_base.value.status_code == 403

        # Member sees only turbo + aesthetic and cannot register LoRAs
        inv_resp = await client.post("/api/admin/invites", json={"max_uses": 1})
        inv = inv_resp.json()["invite"]["code"]
        await client.post("/api/auth/logout")
        await client.post(
            "/api/auth/register",
            json={
                "invite_code": inv,
                "email": "u@example.com",
                "username": "u1",
                "password": "memberpassword123",
            },
        )
        member_wfs = (await client.get("/api/workflows")).json()["workflows"]
        assert set(member_wfs[0]["variants"].keys()) == {"turbo", "aesthetic"}
        assert (
            await client.post(
                "/api/loras",
                json={
                    "name": "Nope",
                    "source_type": "hf",
                    "source_url": "https://huggingface.co/a/b/c.safetensors",
                    "filename": "nope.safetensors",
                },
            )
        ).status_code == 403


async def test_sse_event_bus_replay_privacy_and_heartbeat(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
        sse_heartbeat_seconds=0.05,
    )
    app = create_app(
        settings,
        start_background_uploader=False,
        start_background_workers=False,
    )

    async with app.router.lifespan_context(app):
        bus = app.state.events
        u1 = UserRecord("u1", "u1@example.com", "u1", "member", 50, 2, ("L4",), "now")
        u2 = UserRecord("u2", "u2@example.com", "u2", "member", 50, 2, ("L4",), "now")

        id1 = await bus.publish("pool.status", {"state": "idle"})
        await bus.publish("image.created", {"image_id": "img-u2"}, user_id=u2.id)
        id3 = await bus.publish("image.created", {"image_id": "img-u1"}, user_id=u1.id)

        # Replay after id1 for u1 must skip id1 and skip u2's private event
        chunks: list[str] = []
        sub = bus.subscribe(u1, last_event_id=id1, heartbeat_seconds=0.05, max_events=1)
        async for chunk in sub:
            chunks.append(chunk)
        assert len(chunks) == 1
        assert f"id: {id3}" in chunks[0]
        assert "img-u1" in chunks[0]
        assert "img-u2" not in chunks[0]

        # When idle, subscribe emits `: ping` heartbeat
        hb_sub = bus.subscribe(u1, last_event_id=id3, heartbeat_seconds=0.03)
        hb_chunk = await anext(hb_sub)
        await hb_sub.aclose()
        assert hb_chunk == ": ping\n\n"

    # Also verify HTTP endpoint auth, headers, and live SSE streaming via ASGI
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        assert (await client.get("/api/events")).status_code == 401
        login = await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )
        session_cookie = login.cookies["cc_session"]
        await app.state.events.publish("pool.status", {"state": "ready"})

        started: dict = {}
        body_chunks: list[bytes] = []
        disconnected = asyncio.Event()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/events",
            "raw_path": b"/api/events",
            "query_string": b"",
            "headers": [
                (b"cookie", f"cc_session={session_cookie}".encode()),
                (b"last-event-id", b"0"),
            ],
            "client": ("127.0.0.1", 12345),
            "server": ("test", 80),
        }

        async def receive():
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            if message["type"] == "http.response.start":
                started["status"] = message["status"]
                started["headers"] = {
                    k.decode().lower(): v.decode() for k, v in message["headers"]
                }
            elif message["type"] == "http.response.body":
                chunk = message.get("body", b"")
                if chunk:
                    body_chunks.append(chunk)
                    disconnected.set()

        await asyncio.wait_for(app(scope, receive, send), timeout=5.0)
        assert started["status"] == 200
        assert started["headers"]["cache-control"] == "no-cache"
        assert started["headers"]["x-accel-buffering"] == "no"
        payload = b"".join(body_chunks).decode()
        assert "event: pool.status" in payload
        assert '"state":"ready"' in payload

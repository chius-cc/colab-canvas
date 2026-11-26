"""Tests for AI Creative Copilot backend (`/api/assistant/*`)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from app.main import create_app
from tests.conftest import make_test_settings


class _FakeStreamResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        lines: list[str] | None = None,
        body: bytes = b"",
    ) -> None:
        self.status_code = status_code
        self.headers = httpx.Headers(headers or {"content-type": "text/event-stream"})
        self._lines = lines or []
        self._body = body

    async def aread(self) -> bytes:
        return self._body

    async def aiter_lines(self) -> AsyncIterator[str]:
        for line in self._lines:
            yield line


class _FakeHttpResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        json_data: Any = None,
        text_body: str = "",
    ) -> None:
        self.status_code = status_code
        self._json_data = json_data
        self.content = (
            json.dumps(json_data).encode("utf-8")
            if json_data is not None
            else text_body.encode("utf-8")
        )

    def json(self) -> Any:
        if self._json_data is None:
            raise ValueError("not json")
        return self._json_data


def _install_fake_httpx(
    monkeypatch,
    *,
    get_handler=None,
    stream_handler=None,
    recorded_calls: list[dict[str, Any]] | None = None,
) -> None:
    calls = recorded_calls if recorded_calls is not None else []
    real_async_client = httpx.AsyncClient

    class _FakeAsyncClient:
        def __new__(cls, *args, **kwargs):
            if "transport" in kwargs:
                return real_async_client(*args, **kwargs)
            return super().__new__(cls)

        def __init__(self, *args, **kwargs) -> None:
            self.timeout = kwargs.get("timeout")

        async def __aenter__(self) -> _FakeAsyncClient:
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def get(self, url: str, headers: dict[str, str] | None = None):
            calls.append(
                {
                    "method": "GET",
                    "url": url,
                    "headers": dict(headers or {}),
                    "timeout": self.timeout,
                }
            )
            assert get_handler is not None
            return await get_handler(url, headers or {})

        @asynccontextmanager
        async def stream(
            self,
            method: str,
            url: str,
            *,
            headers: dict[str, str] | None = None,
            json: Any = None,
        ):
            calls.append(
                {
                    "method": method,
                    "url": url,
                    "headers": dict(headers or {}),
                    "json": json,
                    "timeout": self.timeout,
                }
            )
            assert stream_handler is not None
            resp = await stream_handler(method, url, headers or {}, json)
            yield resp

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)


async def _login_admin_and_create_member(client: httpx.AsyncClient) -> str:
    login_resp = await client.post(
        "/api/auth/login",
        json={"identifier": "admin@example.com", "password": "adminpassword123"},
    )
    assert login_resp.status_code == 200
    admin_cookie = login_resp.cookies["cc_session"]

    inv_resp = await client.post("/api/admin/invites", json={"max_uses": 1})
    assert inv_resp.status_code == 201
    invite_code = inv_resp.json()["invite"]["code"]

    await client.post("/api/auth/logout")
    reg_resp = await client.post(
        "/api/auth/register",
        json={
            "invite_code": invite_code,
            "email": "member@example.com",
            "username": "member1",
            "password": "memberpassword123",
        },
    )
    assert reg_resp.status_code == 201
    return admin_cookie


async def test_assistant_auth_guards_and_config_encryption_roundtrip(tmp_path) -> None:
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
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        # Unauthenticated requests are rejected across all routes
        assert (await client.get("/api/assistant/status")).status_code == 401
        assert (await client.get("/api/assistant/config")).status_code == 401
        assert (await client.put("/api/assistant/config", json={})).status_code == 401
        assert (await client.post("/api/assistant/models", json={})).status_code == 401
        assert (
            await client.post(
                "/api/assistant/chat",
                json={"messages": [{"role": "user", "content": "hi"}]},
            )
        ).status_code == 401

        admin_cookie = await _login_admin_and_create_member(client)

        # Member can read minimal status and gets 503 when disabled, but 403 on admin endpoints
        status_resp = await client.get("/api/assistant/status")
        assert status_resp.status_code == 200
        assert status_resp.json() == {"enabled": False, "configured": False, "model": None}

        assert (await client.get("/api/assistant/config")).status_code == 403
        assert (
            await client.put(
                "/api/assistant/config",
                json={
                    "enabled": True,
                    "base_url": "https://mock-llm.example.test/v1",
                    "model": "gpt-test",
                },
            )
        ).status_code == 403
        assert (await client.post("/api/assistant/models", json={})).status_code == 403
        assert (
            await client.post(
                "/api/assistant/chat",
                json={"messages": [{"role": "user", "content": "hello"}]},
            )
        ).status_code == 503

        # Switch back to admin cookie
        client.cookies.set("cc_session", admin_cookie)

        # Validation rejects invalid URLs, out-of-range temperature / max_tokens
        for bad_url in (
            "ftp://mock-llm.example.test/v1",
            "not-a-url",
            "https:///missing-host",
            "",
        ):
            bad_resp = await client.put(
                "/api/assistant/config",
                json={
                    "enabled": True,
                    "base_url": bad_url,
                    "model": "gpt-test",
                },
            )
            assert bad_resp.status_code == 400

        assert (
            await client.put(
                "/api/assistant/config",
                json={
                    "enabled": False,
                    "base_url": "https://mock-llm.example.test/v1",
                    "model": "gpt-test",
                    "temperature": 2.5,
                },
            )
        ).status_code == 422
        assert (
            await client.put(
                "/api/assistant/config",
                json={
                    "enabled": False,
                    "base_url": "https://mock-llm.example.test/v1",
                    "model": "gpt-test",
                    "max_tokens": 32,
                },
            )
        ).status_code == 422

        # Save valid config with trailing slashes and secret key
        secret_key = "sk-fake-demo-00000000OLOh"
        save_resp = await client.put(
            "/api/assistant/config",
            json={
                "enabled": True,
                "base_url": "https://mock-llm.example.test/v1///",
                "api_key": f"  {secret_key}  ",
                "model": "anima-copilot-v1",
                "system_prompt": "Be concise.",
                "temperature": 0.6,
                "max_tokens": 1536,
            },
        )
        assert save_resp.status_code == 200
        cfg = save_resp.json()["config"]
        assert cfg["enabled"] is True
        assert cfg["base_url"] == "https://mock-llm.example.test/v1"
        assert cfg["has_api_key"] is True
        assert cfg["api_key_masked"] == "sk-••••OLOh"
        assert cfg["model"] == "anima-copilot-v1"
        assert cfg["system_prompt"] == "Be concise."
        assert cfg["temperature"] == 0.6
        assert cfg["max_tokens"] == 1536
        assert cfg["updated_at"]
        assert secret_key not in json.dumps(cfg)

        # Verify SQLite persistence uses Fernet ciphertext and never stores plaintext key
        row = await app.state.db.fetchone(
            "SELECT value_json, updated_at FROM app_settings WHERE key = ?",
            ("assistant_config",),
        )
        assert row is not None
        raw_json = str(row["value_json"])
        assert secret_key not in raw_json
        stored = json.loads(raw_json)
        assert stored["updated_at"] == cfg["updated_at"]
        assert app.state.crypto.decrypt_text(stored["api_key_encrypted"]) == secret_key

        # Omitting or sending whitespace api_key preserves existing encrypted key
        preserve_resp = await client.put(
            "/api/assistant/config",
            json={
                "enabled": True,
                "base_url": "https://mock-llm.example.test/v1/",
                "api_key": "   ",
                "model": "anima-copilot-v2",
                "temperature": 0.8,
                "max_tokens": 1024,
            },
        )
        assert preserve_resp.status_code == 200
        assert preserve_resp.json()["config"]["has_api_key"] is True
        assert preserve_resp.json()["config"]["api_key_masked"] == "sk-••••OLOh"

        # Non-admin status hides base_url and key fields
        await client.post("/api/auth/logout")
        await client.post(
            "/api/auth/login",
            json={"identifier": "member1", "password": "memberpassword123"},
        )
        member_status = (await client.get("/api/assistant/status")).json()
        assert member_status == {
            "enabled": True,
            "configured": True,
            "model": "anima-copilot-v2",
        }

        # Short key (<8 chars) masks to "••••", and clear_api_key clears it
        client.cookies.set("cc_session", admin_cookie)
        short_resp = await client.put(
            "/api/assistant/config",
            json={
                "enabled": True,
                "base_url": "https://mock-llm.example.test/v1",
                "api_key": "short",
                "model": "anima-copilot-v2",
            },
        )
        assert short_resp.status_code == 200
        assert short_resp.json()["config"]["has_api_key"] is True
        assert short_resp.json()["config"]["api_key_masked"] == "••••"

        clear_resp = await client.put(
            "/api/assistant/config",
            json={
                "enabled": False,
                "base_url": "",
                "clear_api_key": True,
                "model": "",
            },
        )
        assert clear_resp.status_code == 200
        cleared = clear_resp.json()["config"]
        assert cleared["enabled"] is False
        assert cleared["has_api_key"] is False
        assert cleared["api_key_masked"] == ""
        assert (await client.get("/api/assistant/config")).json()["config"] == cleared


async def test_assistant_models_probe_200_fallback_and_401_sanitization(
    tmp_path, monkeypatch
) -> None:
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

    calls: list[dict[str, Any]] = []
    mode = {"status": 200}
    saved_secret = "sk-saved-secret-key-9999"
    probe_secret = "sk-probe-secret-key-1111"

    async def _fake_get(url: str, headers: dict[str, str]):
        if mode["status"] == 200:
            return _FakeHttpResponse(
                status_code=200,
                json_data={
                    "object": "list",
                    "data": [
                        {"id": "model-alpha"},
                        {"id": "model-beta"},
                        {"id": "model-alpha"},
                    ],
                },
            )
        return _FakeHttpResponse(
            status_code=401,
            json_data={"error": {"message": f"Invalid key {probe_secret}"}},
        )

    _install_fake_httpx(monkeypatch, get_handler=_fake_get, recorded_calls=calls)

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )

        # Probe before saving with explicit trailing slash
        resp_200 = await client.post(
            "/api/assistant/models",
            json={
                "base_url": "https://mock-llm.example.test/v1/",
                "api_key": probe_secret,
            },
        )
        assert resp_200.status_code == 200
        body_200 = resp_200.json()
        assert body_200["ok"] is True
        assert isinstance(body_200["latency_ms"], int)
        assert body_200["models"] == ["model-alpha", "model-beta"]
        assert calls[-1]["url"] == "https://mock-llm.example.test/v1/models"
        assert calls[-1]["headers"]["Authorization"] == f"Bearer {probe_secret}"
        assert calls[-1]["timeout"] == 15.0

        # Save config, then probe with empty body -> falls back to saved URL & decrypted key
        await client.put(
            "/api/assistant/config",
            json={
                "enabled": True,
                "base_url": "https://mock-llm.example.test/v1",
                "api_key": saved_secret,
                "model": "model-alpha",
            },
        )
        resp_fallback = await client.post("/api/assistant/models", json={})
        assert resp_fallback.status_code == 200
        assert resp_fallback.json()["ok"] is True
        assert calls[-1]["url"] == "https://mock-llm.example.test/v1/models"
        assert calls[-1]["headers"]["Authorization"] == f"Bearer {saved_secret}"

        # 401 failure returns clean error without leaking API key
        mode["status"] = 401
        resp_401 = await client.post(
            "/api/assistant/models",
            json={"api_key": probe_secret},
        )
        assert resp_401.status_code == 200
        body_401 = resp_401.json()
        assert body_401["ok"] is False
        assert body_401["status_code"] == 401
        assert probe_secret not in json.dumps(body_401)
        assert saved_secret not in json.dumps(body_401)


async def test_assistant_chat_streaming_fallback_errors_and_prompt_filtering(
    tmp_path, monkeypatch
) -> None:
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

    calls: list[dict[str, Any]] = []
    stream_mode = {"kind": "sse"}
    secret_key = "sk-chat-secret-key-ABCD"

    async def _fake_stream(
        method: str, url: str, headers: dict[str, str], json_body: Any
    ):
        kind = stream_mode["kind"]
        if kind == "sse":
            return _FakeStreamResponse(
                status_code=200,
                headers={"content-type": "text/event-stream"},
                lines=[
                    ": keepalive",
                    (
                        'data: {"choices":[{"delta":{"role":"assistant","content":""},'
                        '"finish_reason":null}]}'
                    ),
                    'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}',
                    'data: {"choices":[{"delta":{"content":"atelier!"},"finish_reason":"stop"}]}',
                    "data: [DONE]",
                ],
            )
        if kind == "json_fallback":
            return _FakeStreamResponse(
                status_code=200,
                headers={"content-type": "application/json"},
                body=json.dumps(
                    {
                        "choices": [
                            {
                                "message": {"role": "assistant", "content": "Fallback reply"},
                                "finish_reason": "stop",
                            }
                        ]
                    }
                ).encode("utf-8"),
            )
        if kind == "upstream_429":
            return _FakeStreamResponse(
                status_code=429,
                headers={"content-type": "application/json"},
                body=json.dumps(
                    {"error": {"message": f"Rate limit hit with Bearer {secret_key}"}}
                ).encode("utf-8"),
            )
        raise httpx.ReadTimeout("timed out")

    _install_fake_httpx(monkeypatch, stream_handler=_fake_stream, recorded_calls=calls)

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )

        # Register a LoRA so live LoRA details appear in system prompt
        lora_resp = await client.post(
            "/api/loras",
            json={
                "name": "Ink Wash Style",
                "source_type": "hf",
                "source_url": "https://huggingface.co/example/ink-wash/resolve/main/ink.safetensors",
                "filename": "ink-wash.safetensors",
                "default_weight": 0.75,
                "trigger_words": "ink wash, sumi-e",
            },
        )
        assert lora_resp.status_code == 201
        lora_id = lora_resp.json()["lora"]["id"]

        # Configure assistant (disabled first -> 503 check, then enabled)
        await client.put(
            "/api/assistant/config",
            json={
                "enabled": True,
                "base_url": "https://mock-llm.example.test/v1/",
                "api_key": secret_key,
                "model": "",
            },
        )
        assert (
            await client.post(
                "/api/assistant/chat",
                json={"messages": [{"role": "user", "content": "hi"}]},
            )
        ).status_code == 503

        await client.put(
            "/api/assistant/config",
            json={
                "enabled": True,
                "base_url": "https://mock-llm.example.test/v1/",
                "model": "gpt-atelier",
                "system_prompt": "Always prefer warm daylight palettes.",
                "temperature": 0.5,
                "max_tokens": 900,
            },
        )

        # Admin chat -> includes admin-only 'base' variant, zero T4
        admin_chunks: list[str] = []
        async with client.stream(
            "POST",
            "/api/assistant/chat",
            json={
                "messages": [{"role": "user", "content": "Give 3 variations"}],
                "locale": "en",
                "mode": "variations",
                "studio_context": {"variant": "turbo", "steps": 10},
            },
        ) as resp:
            assert resp.status_code == 200
            assert resp.headers["cache-control"] == "no-cache"
            assert resp.headers["connection"] == "keep-alive"
            assert resp.headers["x-accel-buffering"] == "no"
            async for raw in resp.aiter_text():
                admin_chunks.append(raw)

        admin_stream_text = "".join(admin_chunks)
        assert admin_stream_text.startswith(": connected\n\n")
        assert 'event: delta\ndata: {"content":"Hello "}\n\n' in admin_stream_text
        assert 'event: delta\ndata: {"content":"atelier!"}\n\n' in admin_stream_text
        assert 'event: done\ndata: {"finish_reason":"stop"}\n\n' in admin_stream_text

        admin_call = calls[-1]
        assert admin_call["url"] == "https://mock-llm.example.test/v1/chat/completions"
        assert admin_call["headers"]["Authorization"] == f"Bearer {secret_key}"
        assert admin_call["json"]["stream"] is True
        assert admin_call["json"]["model"] == "gpt-atelier"
        assert admin_call["json"]["temperature"] == 0.5
        assert admin_call["json"]["max_tokens"] == 900
        admin_sys = admin_call["json"]["messages"][0]["content"]
        assert "`turbo`" in admin_sys
        assert "`aesthetic`" in admin_sys
        assert "`base`" in admin_sys
        assert lora_id in admin_sys
        assert "ink wash, sumi-e" in admin_sys
        assert "canvas-recipe" in admin_sys
        assert "Always prefer warm daylight palettes." in admin_sys
        assert "T4" not in admin_sys
        assert "t4" not in admin_sys.lower()

        # Switch to non-admin member -> 'base' MUST NOT leak into system prompt, zero T4
        inv = (await client.post("/api/admin/invites", json={"max_uses": 1})).json()[
            "invite"
        ]["code"]
        await client.post("/api/auth/logout")
        await client.post(
            "/api/auth/register",
            json={
                "invite_code": inv,
                "email": "artist@example.com",
                "username": "artist1",
                "password": "artistpassword123",
            },
        )

        # Non-streaming JSON fallback for member in zh + polish mode
        stream_mode["kind"] = "json_fallback"
        fallback_resp = await client.post(
            "/api/assistant/chat",
            json={
                "messages": [{"role": "user", "content": "帮我润色提示词"}],
                "locale": "zh",
                "mode": "polish",
                "studio_context": {"prompt": "1girl, sunset", "gpu_type": "L4"},
            },
        )
        assert fallback_resp.status_code == 200
        fb_text = fallback_resp.text
        assert fb_text.startswith(": connected\n\n")
        assert 'event: delta\ndata: {"content":"Fallback reply"}\n\n' in fb_text
        assert 'event: done\ndata: {"finish_reason":"stop"}\n\n' in fb_text

        member_sys = calls[-1]["json"]["messages"][0]["content"]
        assert "`turbo`" in member_sys
        assert "`aesthetic`" in member_sys
        assert "base" not in member_sys.lower()
        assert "T4" not in member_sys
        assert "t4" not in member_sys.lower()
        assert "Simplified Chinese" in member_sys

        # Upstream 429 error emits sanitized SSE error event without leaking secret_key
        stream_mode["kind"] = "upstream_429"
        err_resp = await client.post(
            "/api/assistant/chat",
            json={"messages": [{"role": "user", "content": "retry"}]},
        )
        assert err_resp.status_code == 200
        assert err_resp.text.startswith(": connected\n\n")
        assert "event: error\n" in err_resp.text
        assert "429" in err_resp.text
        assert secret_key not in err_resp.text

        # Timeout error emits clean SSE error event
        stream_mode["kind"] = "timeout"
        to_resp = await client.post(
            "/api/assistant/chat",
            json={"messages": [{"role": "user", "content": "timeout"}]},
        )
        assert to_resp.status_code == 200
        assert "event: error\n" in to_resp.text
        assert "timed out" in to_resp.text.lower()
        assert secret_key not in to_resp.text

        # Diagnose mode works with empty messages when studio_context is provided
        stream_mode["kind"] = "sse"
        diag_resp = await client.post(
            "/api/assistant/chat",
            json={
                "messages": [],
                "locale": "en",
                "mode": "diagnose",
                "studio_context": {"prompt": "(1girl:1.3)", "variant": "turbo", "steps": 30},
            },
        )
        assert diag_resp.status_code == 200
        assert 'event: delta\ndata: {"content":"Hello "}\n\n' in diag_resp.text
        diag_sys = calls[-1]["json"]["messages"][0]["content"]
        assert "diagnose" in diag_sys.lower()
        assert "base" not in diag_sys.lower()
        assert "T4" not in diag_sys

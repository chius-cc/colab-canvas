"""End-to-end offline tests for /api/jobs, WorkerManager rollover, LoRA sync & recovery."""

from __future__ import annotations

import asyncio
import base64
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from colab_cli.client import ColabRequestError

from app.colab.gateway import (
    AcceleratorNotEntitledError,
    AssignedSession,
    AssignmentCancelledError,
    CcuSnapshot,
    ColabGateway,
    GpuCapacityUnavailableError,
    RemoteAssignment,
    TooManyAssignmentsGatewayError,
)
from app.comfy.client import ComfyConnectionError
from app.main import create_app
from tests.conftest import make_png_bytes, make_test_settings


def _sample_adc(tag: str) -> dict[str, Any]:
    return {
        "type": "authorized_user",
        "client_id": f"cid-{tag}",
        "client_secret": f"csec-{tag}",
        "refresh_token": f"rtoken-{tag}",
    }


class FakeWorkerGateway(ColabGateway):
    def __init__(self, ssh_dir: Path) -> None:
        super().__init__(ssh_dir=ssh_dir, assign_retries=2)
        self.assign_calls: list[tuple[str, str]] = []
        self.kernel_calls: list[str] = []
        self.unassigned_endpoints: list[str] = []
        self.mode_by_token: dict[str, str] = {
            "rtoken-a1": "412",
            "rtoken-a2": "400",
            "rtoken-a3": "ok",
        }
        self.active_endpoint: str | None = None

    async def verify_adc_credentials(self, adc_json: dict[str, Any]) -> tuple[str, CcuSnapshot]:
        rt = str(adc_json["refresh_token"])
        return f"{rt}@example.com", CcuSnapshot(balance_cu=150.0, rate_hr=0.0, assignments_count=0)

    async def get_usage(self, adc_json: dict[str, Any]) -> CcuSnapshot:
        del adc_json
        return CcuSnapshot(balance_cu=150.0, rate_hr=0.0, assignments_count=0)

    async def list_assignments(self, adc_json: dict[str, Any]) -> list[RemoteAssignment]:
        del adc_json
        if not self.active_endpoint:
            return []
        return [
            RemoteAssignment(
                endpoint=self.active_endpoint,
                accelerator="L4",
                variant="GPU",
                token="refreshed-token",
                url="https://mock-runtime.invalid",
                token_expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
        ]

    async def assign(
        self,
        adc_json: dict[str, Any],
        *,
        gpu_type: str,
        session_name: str,
        should_cancel: Any = None,
        on_retry: Any = None,
        **_kwargs: Any,
    ) -> AssignedSession:
        del should_cancel, on_retry
        rt = str(adc_json["refresh_token"])
        self.assign_calls.append((rt, gpu_type))
        mode = self.mode_by_token[rt]
        if mode == "412":
            raise TooManyAssignmentsGatewayError("412 busy")
        if mode == "400":
            raise AcceleratorNotEntitledError("400 no quota")
        self.active_endpoint = f"ep-{rt}-l4"
        return AssignedSession(
            session_name=session_name,
            endpoint=self.active_endpoint,
            gpu_type=gpu_type,
            token="init-token",
            url="https://mock-runtime.invalid",
            token_expires_at=datetime.now(UTC) + timedelta(hours=1),
        )

    async def exec_in_kernel(
        self, session: AssignedSession, code: str, *, timeout: float = 600.0
    ) -> str:
        del session, timeout
        self.kernel_calls.append(code)
        return "BOOTSTRAP_RESULT_JSON:{}\n"

    async def unassign(self, adc_json: dict[str, Any], endpoint: str) -> None:
        del adc_json
        self.unassigned_endpoints.append(endpoint)
        if self.active_endpoint == endpoint:
            self.active_endpoint = None


class FakeTunnel:
    def __init__(self, **_kwargs: Any) -> None:
        self.started_count = 0
        self.stopped_count = 0
        self.alive = False

    def is_alive(self) -> bool:
        return self.alive

    async def start(self, timeout: float = 45.0) -> None:
        del timeout
        self.started_count += 1
        self.alive = True

    async def stop(self) -> None:
        self.stopped_count += 1
        self.alive = False


class FakeComfyClient:
    def __init__(self, png_bytes: bytes, *, drop_once_on_ws: bool = False) -> None:
        self.png_bytes = png_bytes
        self.drop_once_on_ws = drop_once_on_ws
        self.submitted_graphs: list[dict[str, Any]] = []
        self._ws_attempts = 0

    async def system_stats(self) -> dict[str, Any]:
        return {"system": {"comfyui_version": "0.46.0"}}

    async def submit_prompt(self, graph: dict[str, Any], client_id: str) -> str:
        del client_id
        self.submitted_graphs.append(graph)
        return f"prompt-{len(self.submitted_graphs)}"

    async def wait_for_completion(
        self, prompt_id: str, client_id: str, *, on_progress=None, timeout: float = 600.0
    ) -> None:
        del prompt_id, client_id, timeout
        self._ws_attempts += 1
        if on_progress is not None:
            await on_progress(0.5)
        if self.drop_once_on_ws and self._ws_attempts == 1:
            raise ComfyConnectionError("Simulated SSH drop mid-sampling")

    async def wait_history_outputs(self, prompt_id: str, *, timeout: float = 120.0) -> list[dict]:
        del prompt_id, timeout
        return [{"filename": "out_00001.png", "subfolder": "", "type": "output"}]

    async def fetch_image_bytes(
        self, filename: str, subfolder: str = "", folder_type: str = "output"
    ) -> bytes:
        del filename, subfolder, folder_type
        return self.png_bytes

    async def interrupt(self) -> None:
        return


async def test_jobs_e2e_rollover_lora_reconnect_and_idle_stop(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
        worker_idle_timeout_seconds=0,
    )
    gw = FakeWorkerGateway(ssh_dir=tmp_path / "data" / "ssh")
    fake_comfy = FakeComfyClient(make_png_bytes(128, 128), drop_once_on_ws=True)
    tunnels: list[FakeTunnel] = []

    def make_tunnel(**kw: Any) -> FakeTunnel:
        t = FakeTunnel(**kw)
        tunnels.append(t)
        return t

    app = create_app(
        settings,
        colab_gateway=gw,
        comfy_client_factory=lambda _url: fake_comfy,
        tunnel_factory=make_tunnel,
        start_background_uploader=False,
        start_background_workers=False,
    )

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        # Silence real HTTP watchdog call in unit test
        heartbeats: list[int] = []

        async def _fake_hb(wd_port: int) -> None:
            heartbeats.append(wd_port)

        app.state.worker_manager._send_watchdog_heartbeat = _fake_hb

        await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )

        # Register 3 accounts (a1->412, a2->400, a3->ok) and 1 LoRA
        for idx in (1, 2, 3):
            r = await client.post(
                "/api/pool/accounts",
                json={
                    "label": f"Acc{idx}",
                    "adc_json": _sample_adc(f"a{idx}"),
                    "priority": idx * 10,
                },
            )
            assert r.status_code == 201

        lora_resp = await client.post(
            "/api/loras",
            json={
                "name": "Boost",
                "source_type": "hf",
                "source_url": "https://huggingface.co/circlestone-labs/Anima-Official-LoRAs/resolve/main/anima-highres-aesthetic-boost.safetensors",
                "filename": "anima-highres-aesthetic-boost.safetensors",
            },
        )
        assert lora_resp.status_code == 201
        lora_id = lora_resp.json()["lora"]["id"]

        # Submit job #1 (triggers rollover a1->a2->a3, bootstrap, LoRA sync, reconnect recovery)
        job_resp = await client.post(
            "/api/jobs",
            json={
                "workflow_id": "anima",
                "variant": "turbo",
                "prompt": "1girl, sunlit platform",
                "lora_ids": [{"id": lora_id, "strength": 0.75}],
                "seed": 777,
            },
        )
        assert job_resp.status_code == 202
        job_id = job_resp.json()["job"]["id"]
        assert job_resp.json()["job"]["status"] == "queued"

        # Submit job #2 and cancel it while queued
        cancel_job_resp = await client.post(
            "/api/jobs",
            json={"workflow_id": "anima", "variant": "turbo", "prompt": "cancel me"},
        )
        assert cancel_job_resp.status_code == 202
        cancel_id = cancel_job_resp.json()["job"]["id"]
        assert (await client.post(f"/api/jobs/{cancel_id}/cancel")).json()["job"][
            "status"
        ] == "cancelled"

        # Drive FIFO queue once -> processes job #1 cleanly
        processed = await app.state.worker_manager.process_next_job_once()
        assert processed is True

        # Verify rollover order & unsupported GPU marking on a2
        assert gw.assign_calls == [("rtoken-a1", "L4"), ("rtoken-a2", "L4"), ("rtoken-a3", "L4")]
        accs = {a["label"]: a for a in (await client.get("/api/pool/accounts")).json()["accounts"]}
        assert accs["Acc2"]["unsupported_gpus"] == ["L4"]

        # Verify bootstrap + LoRA sync ran inside Jupyter kernel (not SSH)
        assert len(gw.kernel_calls) == 2
        assert "HF_XET_HIGH_PERFORMANCE" in gw.kernel_calls[0]
        m = re.search(r'b64decode\("([^"]+)"\)', gw.kernel_calls[1])
        assert m is not None
        decoded_files = base64.b64decode(m.group(1)).decode("utf-8")
        assert "anima-highres-aesthetic-boost.safetensors" in decoded_files

        # Verify reconnect happened (2 tunnel starts) and LoRA node patched into ComfyUI graph
        assert len(tunnels) == 2
        assert fake_comfy.submitted_graphs[0]["100"]["inputs"]["lora_name"] == (
            "anima-highres-aesthetic-boost.safetensors"
        )

        # Verify job completed with stored image retrievable via Gallery API
        job_detail = (await client.get(f"/api/jobs/{job_id}")).json()["job"]
        assert job_detail["status"] == "completed"
        assert job_detail["progress"] == 1.0
        assert len(job_detail["image_ids"]) == 1
        img_id = job_detail["image_ids"][0]
        orig = await client.get(f"/api/images/{img_id}/original")
        assert orig.status_code == 200
        assert orig.content == fake_comfy.png_bytes

        # Heartbeat + idle timeout (0s configured) cleanly unassigns managed worker
        await app.state.worker_manager.heartbeat_and_idle_step()
        assert len(heartbeats) == 1
        assert gw.unassigned_endpoints == ["ep-rtoken-a3-l4"]

        workers = (await client.get("/api/pool/workers")).json()["workers"]
        assert workers[0]["status"] == "stopped"


async def test_job_submission_guards_and_emergency_stop(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
        worker_idle_timeout_seconds=900,
    )
    gw = FakeWorkerGateway(ssh_dir=tmp_path / "data" / "ssh")
    gw.mode_by_token["rtoken-ok"] = "ok"
    fake_comfy = FakeComfyClient(make_png_bytes(128, 128))

    app = create_app(
        settings,
        colab_gateway=gw,
        comfy_client_factory=lambda _url: fake_comfy,
        tunnel_factory=lambda **kw: FakeTunnel(**kw),
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
        await client.post(
            "/api/pool/accounts",
            json={"label": "Primary", "adc_json": _sample_adc("ok")},
        )

        # T4 GPU rejected even for admin (Invariant #8)
        assert (
            await client.post(
                "/api/jobs",
                json={
                    "workflow_id": "anima",
                    "variant": "turbo",
                    "prompt": "test",
                    "gpu_type": "T4",
                },
            )
        ).status_code == 400

        # Submit one job to spin up managed worker, then emergency stop it
        j = await client.post(
            "/api/jobs",
            json={"workflow_id": "anima", "variant": "turbo", "prompt": "warmup"},
        )
        assert j.status_code == 202
        assert await app.state.worker_manager.process_next_job_once() is True

        workers = (await client.get("/api/pool/workers")).json()["workers"]
        assert workers[0]["status"] == "ready"
        w_id = workers[0]["id"]

        stop_resp = await client.post(f"/api/pool/workers/{w_id}/stop")
        assert stop_resp.status_code == 200
        assert stop_resp.json()["worker"]["status"] == "stopped"
        assert gw.unassigned_endpoints == ["ep-rtoken-ok-l4"]

        # Member blocked from admin_only 'base' variant
        inv = (await client.post("/api/admin/invites", json={"max_uses": 1})).json()["invite"][
            "code"
        ]
        await client.post("/api/auth/logout")
        await client.post(
            "/api/auth/register",
            json={
                "invite_code": inv,
                "email": "m@example.com",
                "username": "member",
                "password": "memberpassword123",
            },
        )
        assert (
            await client.post(
                "/api/jobs",
                json={"workflow_id": "anima", "variant": "base", "prompt": "blocked"},
            )
        ).status_code == 403


async def test_gateway_assign_bounded_retry_and_cancel(tmp_path) -> None:
    gw = ColabGateway(ssh_dir=tmp_path / "ssh", assign_retries=3)
    seen_hashes: list[Any] = []
    retry_events: list[tuple[int, int, float, str]] = []
    unassigned: list[str] = []

    class FakeClient:
        def __init__(self, fail_times: int) -> None:
            self.fail_times = fail_times
            self.calls = 0

        def assign(self, notebook_hash, variant=None, accelerator=None):
            del variant, accelerator
            assert os.environ.get("COLAB_CLI_ASSIGN_RETRIES") == "0"
            seen_hashes.append(notebook_hash)
            self.calls += 1
            if self.calls <= self.fail_times:
                resp = SimpleNamespace(status_code=503)
                raise ColabRequestError("503 Service Unavailable", None, resp)
            info = SimpleNamespace(
                token="tok-ok",
                url="https://mock.invalid",
                expires_at=lambda: datetime.now(UTC) + timedelta(hours=1),
            )
            return SimpleNamespace(
                endpoint="gpu-l4-test",
                runtime_proxy_info=info,
                accelerator=SimpleNamespace(value="L4"),
            )

    async def fake_unassign(_adc, ep: str) -> None:
        unassigned.append(ep)

    gw.unassign = fake_unassign  # type: ignore[method-assign]

    # Case 1: succeeds on 3rd attempt with consistent notebook_hash
    c1 = FakeClient(fail_times=2)
    gw._build_client = lambda _adc: (c1, None)  # type: ignore[method-assign,return-value]

    async def on_retry(att: int, max_att: int, delay: float, reason: str) -> None:
        retry_events.append((att, max_att, delay, reason))

    sess = await gw.assign(
        _sample_adc("r"),
        gpu_type="L4",
        session_name="s1",
        on_retry=on_retry,
        retry_delays=(0.01, 0.01),
    )
    assert sess.endpoint == "gpu-l4-test"
    assert len(set(seen_hashes)) == 1 and len(seen_hashes) == 3
    assert retry_events == [(1, 3, 0.01, "HTTP 503"), (2, 3, 0.01, "HTTP 503")]

    # Case 2: cancelled right after assign completes -> immediately unassigns
    c2 = FakeClient(fail_times=0)
    gw._build_client = lambda _adc: (c2, None)  # type: ignore[method-assign,return-value]
    checks = iter([False, True])

    async def flipped_cancel() -> bool:
        return next(checks, True)

    with pytest.raises(AssignmentCancelledError):
        await gw.assign(
            _sample_adc("r"),
            gpu_type="L4",
            session_name="s2",
            should_cancel=flipped_cancel,
        )
    assert unassigned == ["gpu-l4-test"]

    # Case 3: retries exhausted -> raises GpuCapacityUnavailableError cleanly
    c3 = FakeClient(fail_times=5)
    gw._build_client = lambda _adc: (c3, None)  # type: ignore[method-assign,return-value]
    with pytest.raises(GpuCapacityUnavailableError):
        await gw.assign(
            _sample_adc("r"),
            gpu_type="L4",
            session_name="s3",
            retry_delays=(0.01, 0.01),
        )


async def test_booting_cancel_live_stage_and_503_failure(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
    )
    assign_entered = asyncio.Event()
    allow_finish = asyncio.Event()

    class SlowOrBusyGateway(FakeWorkerGateway):
        def __init__(self, ssh_dir: Path) -> None:
            super().__init__(ssh_dir)
            self.call_idx = 0

        async def assign(
            self,
            adc_json: dict[str, Any],
            *,
            gpu_type: str,
            session_name: str,
            should_cancel: Any = None,
            on_retry: Any = None,
            **_kwargs: Any,
        ) -> AssignedSession:
            del adc_json, on_retry
            self.call_idx += 1
            if self.call_idx == 1:
                raise GpuCapacityUnavailableError("Colab L4 capacity temporarily unavailable")
            assign_entered.set()
            await allow_finish.wait()
            if should_cancel is not None and await should_cancel():
                raise AssignmentCancelledError("Job cancelled during assignment")
            self.active_endpoint = f"ep-slow-{gpu_type.lower()}"
            return AssignedSession(
                session_name=session_name,
                endpoint=self.active_endpoint,
                gpu_type=gpu_type,
                token="tok",
                url="https://mock.invalid",
                token_expires_at=datetime.now(UTC) + timedelta(hours=1),
            )

    gw = SlowOrBusyGateway(ssh_dir=tmp_path / "data" / "ssh")
    fake_comfy = FakeComfyClient(make_png_bytes(128, 128))
    app = create_app(
        settings,
        colab_gateway=gw,
        comfy_client_factory=lambda _url: fake_comfy,
        tunnel_factory=lambda **kw: FakeTunnel(**kw),
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
        await client.post(
            "/api/pool/accounts",
            json={"label": "Primary", "adc_json": _sample_adc("busy")},
        )

        # 1) Exhausted 503 fails loudly with clear message instead of hanging in queued
        r1 = await client.post(
            "/api/jobs",
            json={"workflow_id": "anima", "variant": "turbo", "prompt": "p1"},
        )
        j1 = r1.json()["job"]["id"]
        assert await app.state.worker_manager.process_next_job_once() is True
        j1_after = (await client.get(f"/api/jobs/{j1}")).json()["job"]
        assert j1_after["status"] == "failed"
        assert "503" in (j1_after["error_msg"] or "") or "算力紧张" in (j1_after["error_msg"] or "")

        # 2) Booting job shows live stage_detail & can be cancelled mid-assignment
        r2 = await client.post(
            "/api/jobs",
            json={"workflow_id": "anima", "variant": "turbo", "prompt": "p2"},
        )
        j2 = r2.json()["job"]["id"]
        worker_task = asyncio.create_task(app.state.worker_manager.process_next_job_once())
        await assign_entered.wait()

        live = (await client.get(f"/api/jobs/{j2}")).json()["job"]
        assert live["status"] == "booting"
        assert live["stage"] == "assigning"
        assert live["stage_detail"] is not None

        cancel_resp = await client.post(f"/api/jobs/{j2}/cancel")
        assert cancel_resp.status_code == 200
        assert cancel_resp.json()["job"]["status"] == "cancelled"

        allow_finish.set()
        assert await worker_task is True
        j2_final = (await client.get(f"/api/jobs/{j2}")).json()["job"]
        assert j2_final["status"] == "cancelled"
        assert j2_final["stage"] is None

        # 3) Running job cancel must still return 409 Conflict
        await client.post(
            "/api/jobs",
            json={"workflow_id": "anima", "variant": "turbo", "prompt": "p3"},
        )
        j3 = (await client.get("/api/jobs?limit=1")).json()["jobs"][0]["id"]
        await app.state.db.execute("UPDATE jobs SET status = 'running' WHERE id = ?", (j3,))
        assert (await client.post(f"/api/jobs/{j3}/cancel")).status_code == 409

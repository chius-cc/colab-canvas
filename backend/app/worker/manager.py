"""WorkerManager: single-GPU FIFO queue, bootstrap, tunnel supervision, and Cost Guard."""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import random
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException, status

from app.api.events import EventBus
from app.colab.account_pool import AccountPool
from app.colab.gateway import (
    AcceleratorNotEntitledError,
    AssignedSession,
    AssignmentCancelledError,
    ColabGateway,
    GpuCapacityUnavailableError,
    TooManyAssignmentsGatewayError,
)
from app.colab.reconcile import Reconciler
from app.comfy.client import ComfyClient, ComfyConnectionError
from app.config import Settings
from app.db import Database
from app.storage.outbox import ImageStoreService
from app.worker.ssh_tunnel import ControlMasterTunnel, find_free_ports
from app.workflows.registry import LoraSelection, WorkflowRegistry


def _load_vm_bootstrap_module(scripts_dir: Path) -> Any:
    path = scripts_dir / "vm_bootstrap.py"
    spec = importlib.util.spec_from_file_location("colab_canvas_vm_bootstrap", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load vm_bootstrap.py from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@dataclass
class ManagedWorkerState:
    worker_id: str
    account_id: str
    home_dir: Path
    session: AssignedSession
    tunnel: Any
    comfy: Any
    comfy_port: int
    wd_port: int
    cached_files: set[str] = field(default_factory=set)
    last_activity_monotonic: float = field(default_factory=time.monotonic)


class WorkerManager:
    """Supervises on-demand Colab GPU workers and executes queued generation jobs."""

    def __init__(
        self,
        *,
        db: Database,
        settings: Settings,
        gateway: ColabGateway,
        account_pool: AccountPool,
        reconciler: Reconciler,
        workflows: WorkflowRegistry,
        image_store: ImageStoreService,
        events: EventBus,
        comfy_client_factory: Callable[[str], Any] | None = None,
        tunnel_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.gateway = gateway
        self.account_pool = account_pool
        self.reconciler = reconciler
        self.workflows = workflows
        self.image_store = image_store
        self.events = events
        self._comfy_client_factory = comfy_client_factory or (lambda url: ComfyClient(url))
        self._tunnel_factory = tunnel_factory or (lambda **kw: ControlMasterTunnel(**kw))

        self._active: ManagedWorkerState | None = None
        self._active_job_id: str | None = None
        self._job_stages: dict[str, dict[str, str]] = {}
        self._worker_lock = asyncio.Lock()
        self._queue_event = asyncio.Event()
        self._stop_event = asyncio.Event()
        self._tasks: list[asyncio.Task[None]] = []

    def get_job_stage(self, job_id: str) -> tuple[str | None, str | None]:
        entry = self._job_stages.get(job_id)
        if not entry:
            return None, None
        return entry.get("stage"), entry.get("detail")

    def clear_job_stage(self, job_id: str) -> None:
        self._job_stages.pop(job_id, None)

    async def _set_job_stage(
        self,
        job_id: str,
        user_id: str,
        *,
        status: str,
        stage: str,
        detail: str,
        progress: float = 0.0,
    ) -> None:
        self._job_stages[job_id] = {"stage": stage, "detail": detail}
        await self.events.publish(
            "job.updated",
            {
                "job_id": job_id,
                "status": status,
                "progress": progress,
                "stage": stage,
                "stage_detail": detail,
            },
            user_id=user_id,
        )

    @property
    def active_managed_endpoints(self) -> set[str]:
        if self._active is None:
            return set()
        return {self._active.session.endpoint}

    def notify_new_job(self) -> None:
        self._queue_event.set()

    def start(self) -> None:
        if self._tasks:
            return
        self._stop_event.clear()
        self._tasks = [
            asyncio.create_task(self._startup_and_queue_loop(), name="worker-queue"),
            asyncio.create_task(self._heartbeat_idle_loop(), name="worker-heartbeat-idle"),
            asyncio.create_task(self._reconcile_poll_loop(), name="worker-reconcile-poll"),
        ]

    async def stop(self) -> None:
        self._stop_event.set()
        self._queue_event.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()
        if self._active is not None:
            with contextlib.suppress(Exception):
                await self._active.tunnel.stop()

    async def _startup_and_queue_loop(self) -> None:
        with contextlib.suppress(Exception):
            await self.reconciler.reconcile_once(
                active_managed_endpoints=set(),
                cleanup_unowned_managed=True,
            )
            await self.account_pool.refresh_balances()

        while not self._stop_event.is_set():
            did_work = False
            try:
                did_work = await self.process_next_job_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(5.0)
            if not did_work:
                self._queue_event.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._queue_event.wait(), timeout=5.0)

    async def _heartbeat_idle_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.heartbeat_and_idle_step()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self.settings.worker_heartbeat_interval_seconds,
                )

    async def _reconcile_poll_loop(self) -> None:
        last_reconcile = 0.0
        last_balance = 0.0
        while not self._stop_event.is_set():
            now = time.monotonic()
            bal_interval = (
                self.settings.balance_poll_active_seconds
                if self._active is not None
                else self.settings.balance_poll_idle_seconds
            )
            if now - last_reconcile >= self.settings.reconcile_interval_seconds:
                with contextlib.suppress(Exception):
                    await self.reconciler.reconcile_once(
                        active_managed_endpoints=self.active_managed_endpoints,
                        cleanup_unowned_managed=False,
                    )
                last_reconcile = now

            if now - last_balance >= bal_interval:
                with contextlib.suppress(Exception):
                    await self.account_pool.refresh_balances()
                last_balance = now

            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop_event.wait(), timeout=15.0)

    async def _send_watchdog_heartbeat(self, wd_port: int) -> None:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"http://127.0.0.1:{wd_port}/heartbeat")
            resp.raise_for_status()

    async def heartbeat_and_idle_step(self) -> None:
        async with self._worker_lock:
            worker = self._active
            if worker is None:
                return

            now_iso = datetime.now(UTC).isoformat()
            try:
                await self._send_watchdog_heartbeat(worker.wd_port)
                await self.db.execute(
                    "UPDATE workers SET last_heartbeat_at = ? WHERE id = ?",
                    (now_iso, worker.worker_id),
                )
            except Exception:
                pass

            if self._active_job_id is not None:
                return

            qrow = await self.db.fetchone(
                "SELECT COUNT(*) AS cnt FROM jobs WHERE status IN ('queued', 'booting', 'running')"
            )
            if qrow and int(qrow["cnt"]) > 0:
                return

            idle_for = time.monotonic() - worker.last_activity_monotonic
            if idle_for >= self.settings.worker_idle_timeout_seconds:
                await self._teardown_active_worker_unlocked(reason="idle_timeout")

    async def _teardown_active_worker_unlocked(self, *, reason: str) -> None:
        worker = self._active
        if worker is None:
            return
        self._active = None
        with contextlib.suppress(Exception):
            await worker.tunnel.stop()
        with contextlib.suppress(Exception):
            adc, _ = await self.account_pool.get_decrypted_adc(worker.account_id)
            await self.gateway.unassign(adc, worker.session.endpoint)
        await self.db.execute(
            "UPDATE workers SET status = 'stopped', stopped_at = ? WHERE id = ?",
            (datetime.now(UTC).isoformat(), worker.worker_id),
        )
        await self.events.publish(
            "worker.updated",
            {"worker_id": worker.worker_id, "status": "stopped", "reason": reason},
            admin_only=True,
        )
        await self.events.publish("pool.updated", {"reason": reason}, admin_only=True)

    async def _reconnect_active_worker(self) -> ManagedWorkerState:
        worker = self._active
        if worker is None:
            raise RuntimeError("No active worker to reconnect")
        adc, _ = await self.account_pool.get_decrypted_adc(worker.account_id)
        refreshed = await self.gateway.refresh_session_token(adc, worker.session)
        if not refreshed:
            raise RuntimeError(f"Worker endpoint {worker.session.endpoint} vanished")
        await worker.tunnel.stop()
        _, sessions_path = self.gateway.prepare_account_home(
            worker.home_dir, adc, session=worker.session
        )
        proxy_cmd, env = self.gateway.build_ssh_proxy_command(
            home_dir=worker.home_dir,
            adc_path=worker.home_dir / "adc.json",
            sessions_path=sessions_path,
            session_name=worker.session.session_name,
        )
        new_tunnel = self._tunnel_factory(
            socket_path=self.settings.run_dir / f"{worker.worker_id}.sock",
            ssh_key_path=self.gateway.ensure_ssh_key(),
            proxy_command=proxy_cmd,
            env=env,
            local_comfy_port=worker.comfy_port,
            local_wd_port=worker.wd_port,
        )
        await new_tunnel.start(timeout=45.0)
        worker.tunnel = new_tunnel
        return worker

    async def _provision_worker(
        self,
        *,
        gpu_type: str,
        workflow_id: str,
        variant: str,
        job_id: str,
        user_id: str,
    ) -> ManagedWorkerState | None:
        gpu_order = [gpu_type.upper()]
        if gpu_type.upper() == "L4" and self.settings.allow_a100_fallback:
            gpu_order.append("A100")

        async def _is_cancelled() -> bool:
            row = await self.db.fetchone("SELECT status FROM jobs WHERE id = ?", (job_id,))
            return row is None or str(row["status"]) == "cancelled"

        async def _on_retry(attempt: int, max_attempts: int, delay: float, reason: str) -> None:
            await self._set_job_stage(
                job_id,
                user_id,
                status="booting",
                stage="assign_retry",
                detail=(
                    f"Colab {target_gpu} 繁忙 ({reason})，"
                    f"{int(delay)}s 后第 {attempt + 1}/{max_attempts} 次重试…"
                ),
            )

        assigned: tuple[str, dict[str, Any], Path, AssignedSession] | None = None
        last_capacity_error: GpuCapacityUnavailableError | None = None
        saw_412 = False

        for target_gpu in gpu_order:
            if target_gpu == "T4":
                continue
            candidates = await self.account_pool.select_candidates(target_gpu)
            for acc in candidates:
                acc_id = str(acc["id"])
                adc, home_dir = await self.account_pool.get_decrypted_adc(acc_id)
                session_name = f"cc-{uuid.uuid4().hex[:8]}"
                try:
                    sess = await self.gateway.assign(
                        adc,
                        gpu_type=target_gpu,
                        session_name=session_name,
                        should_cancel=_is_cancelled,
                        on_retry=_on_retry,
                    )
                    assigned = (acc_id, adc, home_dir, sess)
                    break
                except TooManyAssignmentsGatewayError:
                    saw_412 = True
                    continue
                except AcceleratorNotEntitledError:
                    await self.account_pool.mark_gpu_unsupported(acc_id, target_gpu)
                    continue
                except GpuCapacityUnavailableError as exc:
                    last_capacity_error = exc
                    continue
            if assigned is not None:
                break

        if assigned is None:
            if last_capacity_error is not None and not saw_412:
                raise GpuCapacityUnavailableError(
                    f"Colab {gpu_type} 当前算力紧张（{last_capacity_error}），"
                    "请稍后重试或切换其他加速卡"
                )
            await self.events.publish(
                "pool.gpu_unavailable",
                {"gpu_type": gpu_type, "job_id": job_id},
                admin_only=True,
            )
            return None

        acc_id, adc, home_dir, sess = assigned
        worker_id = str(uuid.uuid4())
        now_iso = datetime.now(UTC).isoformat()
        comfy_port, wd_port = find_free_ports(2)

        await self.db.execute(
            """
            INSERT INTO workers (
                id, account_id, endpoint, session_name, origin, gpu_type,
                status, comfy_port, watchdog_port, cached_files,
                started_at, last_heartbeat_at, last_activity_at, stopped_at
            ) VALUES (?, ?, ?, ?, 'managed', ?, 'bootstrapping', ?, ?, '[]', ?, ?, ?, NULL)
            """,
            (
                worker_id,
                acc_id,
                sess.endpoint,
                sess.session_name,
                sess.gpu_type,
                comfy_port,
                wd_port,
                now_iso,
                now_iso,
                now_iso,
            ),
        )
        await self.db.execute(
            "UPDATE jobs SET worker_id = ?, status = 'booting' WHERE id = ?",
            (worker_id, job_id),
        )
        await self.events.publish(
            "worker.updated",
            {"worker_id": worker_id, "status": "bootstrapping", "gpu_type": sess.gpu_type},
            admin_only=True,
        )
        await self._set_job_stage(
            job_id,
            user_id,
            status="booting",
            stage="bootstrapping",
            detail="正在初始化 ComfyUI 与模型权重…",
        )

        try:
            wf = self.workflows.get(workflow_id).manifest
            vspec = wf.variants[variant]
            weights = [w.model_dump() for w in [*wf.shared_weights, vspec.weight]]

            vm_boot = _load_vm_bootstrap_module(self.settings.scripts_dir)
            wd_src = (self.settings.scripts_dir / "vm_watchdog.py").read_text(encoding="utf-8")
            boot_code = vm_boot.render_bootstrap_code(
                {
                    "comfyui_commit": wf.comfyui_commit,
                    "weights": weights,
                    "watchdog_idle_seconds": self.settings.watchdog_idle_timeout_seconds,
                    "watchdog_max_lifetime_seconds": self.settings.watchdog_max_lifetime_seconds,
                },
                wd_src,
            )
            await self.gateway.exec_in_kernel(sess, boot_code, timeout=600.0)

            await self._set_job_stage(
                job_id,
                user_id,
                status="booting",
                stage="tunneling",
                detail="正在建立安全隧道并连接 ComfyUI…",
            )
            _, sessions_path = self.gateway.prepare_account_home(home_dir, adc, session=sess)
            proxy_cmd, env = self.gateway.build_ssh_proxy_command(
                home_dir=home_dir,
                adc_path=home_dir / "adc.json",
                sessions_path=sessions_path,
                session_name=sess.session_name,
            )
            tunnel = self._tunnel_factory(
                socket_path=self.settings.run_dir / f"{worker_id}.sock",
                ssh_key_path=self.gateway.ensure_ssh_key(),
                proxy_command=proxy_cmd,
                env=env,
                local_comfy_port=comfy_port,
                local_wd_port=wd_port,
            )
            await tunnel.start(timeout=45.0)
            comfy = self._comfy_client_factory(f"http://127.0.0.1:{comfy_port}")
            await comfy.system_stats()

            cached = {w["target_path"] for w in weights}
            await self.db.execute(
                "UPDATE workers SET status = 'ready', cached_files = ? WHERE id = ?",
                (json.dumps(sorted(cached)), worker_id),
            )
            worker_state = ManagedWorkerState(
                worker_id=worker_id,
                account_id=acc_id,
                home_dir=home_dir,
                session=sess,
                tunnel=tunnel,
                comfy=comfy,
                comfy_port=comfy_port,
                wd_port=wd_port,
                cached_files=cached,
            )
            await self.events.publish(
                "worker.updated",
                {"worker_id": worker_id, "status": "ready", "gpu_type": sess.gpu_type},
                admin_only=True,
            )
            return worker_state
        except Exception:
            with contextlib.suppress(Exception):
                await self.gateway.unassign(adc, sess.endpoint)
            await self.db.execute(
                "UPDATE workers SET status = 'error', stopped_at = ? WHERE id = ?",
                (datetime.now(UTC).isoformat(), worker_id),
            )
            await self.events.publish(
                "worker.updated",
                {"worker_id": worker_id, "status": "error"},
                admin_only=True,
            )
            raise

    async def _ensure_ready_worker(
        self,
        *,
        gpu_type: str,
        workflow_id: str,
        variant: str,
        job_id: str,
        user_id: str,
    ) -> ManagedWorkerState | None:
        async with self._worker_lock:
            if self._active is not None:
                if self._active.session.gpu_type != gpu_type.upper():
                    await self._teardown_active_worker_unlocked(reason="gpu_switch")
                elif self._active.tunnel.is_alive():
                    try:
                        await self._active.comfy.system_stats()
                        return self._active
                    except Exception:
                        pass
                if self._active is not None:
                    try:
                        return await self._reconnect_active_worker()
                    except Exception:
                        await self._teardown_active_worker_unlocked(reason="unhealthy")

            worker = await self._provision_worker(
                gpu_type=gpu_type,
                workflow_id=workflow_id,
                variant=variant,
                job_id=job_id,
                user_id=user_id,
            )
            self._active = worker
            return worker

    async def _ensure_job_files_on_vm(
        self,
        worker: ManagedWorkerState,
        *,
        workflow_id: str,
        variant: str,
        lora_rows: list[dict[str, Any]],
        job_id: str | None = None,
        user_id: str | None = None,
    ) -> None:
        manifest = self.workflows.get(workflow_id).manifest
        vspec = manifest.variants[variant]
        required_files: list[dict[str, Any]] = []

        for weight in [*manifest.shared_weights, vspec.weight]:
            if weight.target_path not in worker.cached_files:
                required_files.append(
                    {
                        "source_type": "hf_repo",
                        "repo_id": weight.repo_id,
                        "repo_path": weight.repo_path,
                        "target_path": weight.target_path,
                        "sha256": weight.sha256,
                    }
                )

        for lr in lora_rows:
            rel_target = f"loras/{lr['filename']}"
            if rel_target not in worker.cached_files:
                required_files.append(
                    {
                        "source_type": lr["source_type"],
                        "source_url": lr["source_url"],
                        "target_path": rel_target,
                        "sha256": lr.get("sha256"),
                        "max_bytes": lr.get("size_bytes"),
                    }
                )

        if not required_files:
            return

        if job_id and user_id:
            await self._set_job_stage(
                job_id,
                user_id,
                status="booting",
                stage="loading_files",
                detail="正在同步模型与 LoRA 权重…",
            )
        vm_boot = _load_vm_bootstrap_module(self.settings.scripts_dir)
        code = vm_boot.render_ensure_files_code(
            required_files, civitai_token=self.settings.civitai_api_token
        )
        await self.gateway.exec_in_kernel(worker.session, code, timeout=300.0)
        for item in required_files:
            worker.cached_files.add(item["target_path"])
        await self.db.execute(
            "UPDATE workers SET cached_files = ? WHERE id = ?",
            (json.dumps(sorted(worker.cached_files)), worker.worker_id),
        )

    async def process_next_job_once(self) -> bool:
        job_row = await self.db.fetchone(
            "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
        )
        if job_row is None:
            return False

        job_id = str(job_row["id"])
        user_id = str(job_row["user_id"])
        workflow_id = str(job_row["workflow_id"])
        variant = str(job_row["variant"])
        params = json.loads(str(job_row["params_json"]))
        gpu_type = str(params.get("gpu_type", "L4"))
        is_admin = bool(params.get("is_admin", False))

        self._active_job_id = job_id
        try:
            cur = await self.db.execute(
                "UPDATE jobs SET status = 'booting' WHERE id = ? AND status = 'queued'",
                (job_id,),
            )
            if cur.rowcount != 1:
                return True

            await self._set_job_stage(
                job_id,
                user_id,
                status="booting",
                stage="assigning",
                detail=f"正在申请 Colab {gpu_type} 算力…",
            )

            worker = await self._ensure_ready_worker(
                gpu_type=gpu_type,
                workflow_id=workflow_id,
                variant=variant,
                job_id=job_id,
                user_id=user_id,
            )
            if worker is None:
                # 412 / capacity slot occupied: return job to queued cleanly
                await self.db.execute(
                    """
                    UPDATE jobs
                    SET status = 'queued', worker_id = NULL
                    WHERE id = ? AND status = 'booting'
                    """,
                    (job_id,),
                )
                await self.events.publish(
                    "job.updated",
                    {
                        "job_id": job_id,
                        "status": "queued",
                        "progress": 0.0,
                        "stage": "queued_pool_busy",
                        "stage_detail": "算力池忙碌，继续排队等待空闲槽位…",
                    },
                    user_id=user_id,
                )
                return False

            # Confirm job wasn't cancelled while bootstrapping
            fresh_job = await self.db.fetchone("SELECT status FROM jobs WHERE id = ?", (job_id,))
            if fresh_job is None or fresh_job["status"] == "cancelled":
                return True

            lora_specs = params.get("loras", [])
            lora_rows: list[dict[str, Any]] = []
            lora_selections: list[LoraSelection] = []
            for item in lora_specs:
                lrow = await self.db.fetchone("SELECT * FROM loras WHERE id = ?", (item["id"],))
                if lrow is None:
                    raise RuntimeError(f"Registered LoRA {item['id']} was removed before execution")
                lora_rows.append(dict(lrow))
                lora_selections.append(
                    LoraSelection(filename=str(lrow["filename"]), strength=float(item["strength"]))
                )

            await self._ensure_job_files_on_vm(
                worker,
                workflow_id=workflow_id,
                variant=variant,
                lora_rows=lora_rows,
                job_id=job_id,
                user_id=user_id,
            )

            seed = int(params.get("seed") or random.randint(1, 2**31 - 1))
            graph = self.workflows.render_prompt_graph(
                workflow_id=workflow_id,
                variant=variant,
                is_admin=is_admin,
                prompt=params["prompt"],
                negative_prompt=params.get("negative_prompt"),
                width=int(params.get("width", 1024)),
                height=int(params.get("height", 1024)),
                batch_size=int(params.get("batch_size", 1)),
                steps=params.get("steps"),
                cfg=params.get("cfg"),
                sampler_name=params.get("sampler_name"),
                scheduler=params.get("scheduler"),
                seed=seed,
                loras=lora_selections,
                filename_prefix=f"job_{job_id[:8]}",
            )

            client_id = str(uuid.uuid4())
            prompt_id = await worker.comfy.submit_prompt(graph, client_id)
            await self.db.execute(
                """
                UPDATE jobs
                SET worker_id = ?, status = 'running', comfy_prompt_id = ?
                WHERE id = ?
                """,
                (worker.worker_id, prompt_id, job_id),
            )
            await self._set_job_stage(
                job_id,
                user_id,
                status="running",
                stage="sampling",
                detail="正在生成图像…",
                progress=0.0,
            )

            async def _on_progress(pct: float) -> None:
                detail = f"正在生成图像 ({round(pct * 100)}%)…"
                self._job_stages[job_id] = {"stage": "sampling", "detail": detail}
                await self.db.execute(
                    "UPDATE jobs SET progress = ? WHERE id = ?", (pct, job_id)
                )
                await self.events.publish(
                    "job.updated",
                    {
                        "job_id": job_id,
                        "status": "running",
                        "progress": round(pct, 3),
                        "stage": "sampling",
                        "stage_detail": detail,
                    },
                    user_id=user_id,
                )

            try:
                await worker.comfy.wait_for_completion(
                    prompt_id, client_id, on_progress=_on_progress
                )
                outputs = await worker.comfy.wait_history_outputs(prompt_id)
            except ComfyConnectionError:
                async with self._worker_lock:
                    worker = await self._reconnect_active_worker()
                outputs = await worker.comfy.wait_history_outputs(prompt_id)

            image_ids: list[str] = []
            for img_meta in outputs:
                png_bytes = await worker.comfy.fetch_image_bytes(
                    img_meta["filename"],
                    subfolder=img_meta.get("subfolder", ""),
                    folder_type=img_meta.get("type", "output"),
                )
                stored = await self.image_store.ingest_png(
                    user_id=user_id,
                    job_id=job_id,
                    workflow_id=workflow_id,
                    variant=variant,
                    png_bytes=png_bytes,
                    seed=seed,
                    meta={**params, "seed": seed},
                )
                image_ids.append(stored["id"])

            now_iso = datetime.now(UTC).isoformat()
            worker.last_activity_monotonic = time.monotonic()
            await self.db.execute(
                "UPDATE workers SET last_activity_at = ? WHERE id = ?",
                (now_iso, worker.worker_id),
            )
            await self.db.execute(
                """
                UPDATE jobs
                SET status = 'completed', progress = 1.0, finished_at = ?
                WHERE id = ?
                """,
                (now_iso, job_id),
            )
            self._job_stages.pop(job_id, None)
            await self.events.publish(
                "job.updated",
                {
                    "job_id": job_id,
                    "status": "completed",
                    "progress": 1.0,
                    "image_ids": image_ids,
                    "stage": None,
                    "stage_detail": None,
                },
                user_id=user_id,
            )
            return True

        except AssignmentCancelledError:
            self._job_stages.pop(job_id, None)
            await self.db.execute(
                """
                UPDATE jobs
                SET status = 'cancelled', finished_at = COALESCE(finished_at, ?)
                WHERE id = ?
                """,
                (datetime.now(UTC).isoformat(), job_id),
            )
            await self.events.publish(
                "job.updated",
                {"job_id": job_id, "status": "cancelled", "stage": None, "stage_detail": None},
                user_id=user_id,
            )
            return True
        except Exception as exc:
            self._job_stages.pop(job_id, None)
            err_msg = f"{type(exc).__name__}: {exc}"[:500]
            await self.db.execute(
                "UPDATE jobs SET status = 'failed', error_msg = ?, finished_at = ? WHERE id = ?",
                (err_msg, datetime.now(UTC).isoformat(), job_id),
            )
            await self.events.publish(
                "job.updated",
                {
                    "job_id": job_id,
                    "status": "failed",
                    "error": err_msg,
                    "stage": None,
                    "stage_detail": None,
                },
                user_id=user_id,
            )
            return True
        finally:
            self._active_job_id = None
            self._job_stages.pop(job_id, None)

    async def emergency_stop_worker(self, worker_id: str) -> dict[str, Any]:
        row = await self.db.fetchone("SELECT * FROM workers WHERE id = ?", (worker_id,))
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Worker not found")
        if row["origin"] != "managed":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot stop an external Colab session (Invariant #3)",
            )

        async with self._worker_lock:
            if self._active is not None and self._active.worker_id == worker_id:
                with contextlib.suppress(Exception):
                    await self._active.comfy.interrupt()
                await self._teardown_active_worker_unlocked(reason="emergency_stop")
            else:
                adc, _ = await self.account_pool.get_decrypted_adc(str(row["account_id"]))
                await self.gateway.unassign(adc, str(row["endpoint"]))
                await self.db.execute(
                    "UPDATE workers SET status = 'stopped', stopped_at = ? WHERE id = ?",
                    (datetime.now(UTC).isoformat(), worker_id),
                )
                await self.events.publish(
                    "worker.updated",
                    {"worker_id": worker_id, "status": "stopped", "reason": "emergency_stop"},
                    admin_only=True,
                )

            now_iso = datetime.now(UTC).isoformat()
            await self.db.execute(
                """
                UPDATE jobs
                SET status = 'failed', error_msg = 'Worker stopped by admin', finished_at = ?
                WHERE worker_id = ? AND status IN ('booting', 'running')
                """,
                (now_iso, worker_id),
            )

        updated = await self.db.fetchone("SELECT * FROM workers WHERE id = ?", (worker_id,))
        assert updated is not None
        return dict(updated)

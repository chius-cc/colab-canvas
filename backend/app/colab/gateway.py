"""Sole boundary for all google-colab-cli imports and Colab backend calls (Invariant #1)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shlex
import subprocess
import sys
import threading
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from colab_cli.client import (
    Accelerator,
    Client,
    ColabRequestError,
    PostAssignmentResponse,
    Prod,
    TooManyAssignmentsError,
    Variant,
)
from colab_cli.runtime import ColabRuntime
from colab_cli.state import SessionState, StateStore
from colab_cli.utils import get_status_code
from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2.credentials import Credentials

from app.security.crypto import write_private_file

MAX_COLAB_LOG_BYTES = 5 * 1024 * 1024

_GPU_MAP = {
    "L4": Accelerator.L4,
    "A100": Accelerator.A100,
    "G4": Accelerator.G4,
}


class ColabGatewayError(RuntimeError):
    """Base error raised by ColabGateway."""


class TooManyAssignmentsGatewayError(ColabGatewayError):
    """Raised when Colab rejects allocation with HTTP 412."""


class AcceleratorNotEntitledError(ColabGatewayError):
    """Raised when the account lacks entitlement for the requested accelerator (HTTP 400)."""


class CredentialsInvalidError(ColabGatewayError):
    """Raised when ADC credentials cannot refresh or lack required Colab access."""


class GpuCapacityUnavailableError(ColabGatewayError):
    """Raised when transient Colab 502/503/504 or timeout errors exhaust retries."""


class AssignmentCancelledError(ColabGatewayError):
    """Raised when assignment is cancelled before or during allocation."""


@dataclass(frozen=True)
class CcuSnapshot:
    balance_cu: float
    rate_hr: float
    assignments_count: int


@dataclass(frozen=True)
class RemoteAssignment:
    endpoint: str
    accelerator: str
    variant: str
    token: str
    url: str
    token_expires_at: datetime


@dataclass
class AssignedSession:
    session_name: str
    endpoint: str
    gpu_type: str
    token: str
    url: str
    token_expires_at: datetime
    kernel_id: str | None = None
    session_id: str | None = None


class ColabGateway:
    """Thread-safe wrapper around colab_cli.client, ColabRuntime, and isolated SSH proxy."""

    def __init__(self, ssh_dir: Path, assign_retries: int = 5, proxy_url: str = "") -> None:
        self.ssh_dir = ssh_dir
        self.assign_retries = max(1, assign_retries)
        self.proxy_url = proxy_url.strip()
        self._assign_env_lock = threading.Lock()

    @property
    def ssh_key_path(self) -> Path:
        return self.ssh_dir / "id_ed25519"

    def ensure_ssh_key(self) -> Path:
        self.ssh_dir.mkdir(parents=True, exist_ok=True)
        self.ssh_dir.chmod(0o700)
        key = self.ssh_key_path
        pub = Path(f"{key}.pub")
        if not key.is_file() or not pub.is_file():
            subprocess.run(
                ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(key)],
                check=True,
                capture_output=True,
                text=True,
            )
        os.chmod(key, 0o600)
        return key

    def prepare_account_home(
        self,
        home_dir: Path,
        adc_json: dict[str, Any],
        session: AssignedSession | None = None,
    ) -> tuple[Path, Path]:
        """Materialize isolated HOME, settings.json, 0600 adc.json, and optional sessions.json."""
        home_dir.mkdir(parents=True, exist_ok=True)
        home_dir.chmod(0o700)
        cli_dir = home_dir / ".config" / "colab-cli"
        cli_dir.mkdir(parents=True, exist_ok=True)
        cli_dir.chmod(0o700)

        settings_path = cli_dir / "settings.json"
        settings_path.write_text(
            json.dumps({"enable_update_check": False}, indent=2),
            encoding="utf-8",
        )

        log_path = cli_dir / "colab.log"
        if log_path.exists() and log_path.stat().st_size > MAX_COLAB_LOG_BYTES:
            rotated = cli_dir / "colab.log.1"
            log_path.replace(rotated)

        adc_path = home_dir / "adc.json"
        write_private_file(adc_path, json.dumps(adc_json))

        sessions_path = home_dir / "sessions.json"
        if session is not None:
            store = StateStore(str(sessions_path))
            store.add(
                SessionState(
                    name=session.session_name,
                    token=session.token,
                    url=session.url,
                    endpoint=session.endpoint,
                    token_expires_at=session.token_expires_at,
                    variant="GPU",
                    accelerator=session.gpu_type,
                    machine_shape="STANDARD",
                    kernel_id=session.kernel_id,
                    session_id=session.session_id,
                )
            )
            os.chmod(sessions_path, 0o600)

        return adc_path, sessions_path

    def build_ssh_proxy_command(
        self,
        *,
        home_dir: Path,
        adc_path: Path,
        sessions_path: Path,
        session_name: str,
    ) -> tuple[str, dict[str, str]]:
        """Build OpenSSH ProxyCommand and isolated per-account environment (Invariant #2)."""
        key_path = self.ensure_ssh_key()
        proxy_cmd = shlex.join(
            [
                sys.executable,
                "-m",
                "colab_cli.cli",
                "--auth",
                "adc",
                "--config",
                str(sessions_path),
                "ssh",
                "--proxy-mode",
                "-s",
                session_name,
                "--identity",
                str(key_path),
            ]
        )
        env = os.environ.copy()
        env["HOME"] = str(home_dir)
        env["GOOGLE_APPLICATION_CREDENTIALS"] = str(adc_path)
        if self.proxy_url:
            env["HTTPS_PROXY"] = self.proxy_url
            env["HTTP_PROXY"] = self.proxy_url
        return proxy_cmd, env

    def _build_client(self, adc_json: dict[str, Any]) -> tuple[Client, AuthorizedSession]:
        try:
            creds = Credentials.from_authorized_user_info(adc_json)
            if not creds.valid:
                authed_tmp = AuthorizedSession(creds)
                if self.proxy_url:
                    authed_tmp.proxies = {"http": self.proxy_url, "https": self.proxy_url}
                creds.refresh(Request(session=authed_tmp))
        except Exception as exc:
            raise CredentialsInvalidError(
                f"Invalid or unrefreshable ADC credentials: {exc}"
            ) from exc
        authed = AuthorizedSession(creds)
        if self.proxy_url:
            authed.proxies = {"http": self.proxy_url, "https": self.proxy_url}
        return Client(Prod(), authed), authed

    async def verify_adc_credentials(self, adc_json: dict[str, Any]) -> tuple[str, CcuSnapshot]:
        def _verify() -> tuple[str, CcuSnapshot]:
            client, authed = self._build_client(adc_json)
            resp = authed.get("https://www.googleapis.com/oauth2/v3/userinfo", timeout=15)
            if not resp.ok:
                raise CredentialsInvalidError(
                    f"Failed to fetch userinfo for ADC account (HTTP {resp.status_code})"
                )
            email = str(resp.json().get("email", "")).strip().lower()
            if not email:
                raise CredentialsInvalidError("ADC credentials returned empty user email")
            ccu = client.get_consumption_user_info()
            return email, CcuSnapshot(
                balance_cu=float(ccu.paid_compute_units_balance),
                rate_hr=float(ccu.consumption_rate_hourly),
                assignments_count=int(ccu.assignments_count),
            )

        return await asyncio.to_thread(_verify)

    async def get_usage(self, adc_json: dict[str, Any]) -> CcuSnapshot:
        def _fetch() -> CcuSnapshot:
            client, _ = self._build_client(adc_json)
            ccu = client.get_consumption_user_info()
            return CcuSnapshot(
                balance_cu=float(ccu.paid_compute_units_balance),
                rate_hr=float(ccu.consumption_rate_hourly),
                assignments_count=int(ccu.assignments_count),
            )

        return await asyncio.to_thread(_fetch)

    async def list_assignments(self, adc_json: dict[str, Any]) -> list[RemoteAssignment]:
        def _list() -> list[RemoteAssignment]:
            client, _ = self._build_client(adc_json)
            items = client.list_assignments()
            return [
                RemoteAssignment(
                    endpoint=a.endpoint,
                    accelerator=a.accelerator.value,
                    variant=a.variant.name,
                    token=a.runtime_proxy_info.token,
                    url=a.runtime_proxy_info.url,
                    token_expires_at=a.runtime_proxy_info.expires_at(),
                )
                for a in items
            ]

        return await asyncio.to_thread(_list)

    async def assign(
        self,
        adc_json: dict[str, Any],
        *,
        gpu_type: str,
        session_name: str,
        should_cancel: Callable[[], Awaitable[bool]] | None = None,
        on_retry: Callable[[int, int, float, str], Awaitable[None]] | None = None,
        retry_delays: tuple[float, ...] = (3.0, 6.0, 10.0, 15.0),
    ) -> AssignedSession:
        gpu = gpu_type.strip().upper()
        if gpu == "T4":
            raise AcceleratorNotEntitledError("T4 GPU is forbidden by architecture Invariant #8")
        acc = _GPU_MAP.get(gpu)
        if acc is None:
            raise AcceleratorNotEntitledError(f"Unsupported GPU type '{gpu}'")

        notebook_hash = uuid.uuid4()
        max_attempts = max(1, self.assign_retries)

        def _assign_once() -> AssignedSession:
            client, _ = self._build_client(adc_json)
            with self._assign_env_lock:
                prev = os.environ.get("COLAB_CLI_ASSIGN_RETRIES")
                os.environ["COLAB_CLI_ASSIGN_RETRIES"] = "0"
                try:
                    res = client.assign(notebook_hash, variant=Variant.GPU, accelerator=acc)
                finally:
                    if prev is None:
                        os.environ.pop("COLAB_CLI_ASSIGN_RETRIES", None)
                    else:
                        os.environ["COLAB_CLI_ASSIGN_RETRIES"] = prev

            info = res.runtime_proxy_info
            resolved_gpu = res.accelerator.value if isinstance(res, PostAssignmentResponse) else gpu
            return AssignedSession(
                session_name=session_name,
                endpoint=res.endpoint,
                gpu_type=resolved_gpu,
                token=info.token,
                url=info.url,
                token_expires_at=info.expires_at(),
            )

        last_reason = "Service Unavailable"
        for attempt in range(1, max_attempts + 1):
            if should_cancel is not None and await should_cancel():
                raise AssignmentCancelledError("Job cancelled before assignment")

            try:
                sess = await asyncio.to_thread(_assign_once)
                if should_cancel is not None and await should_cancel():
                    with contextlib.suppress(Exception):
                        await self.unassign(adc_json, sess.endpoint)
                    raise AssignmentCancelledError("Job cancelled during assignment")
                return sess
            except TooManyAssignmentsError as exc:
                raise TooManyAssignmentsGatewayError(str(exc)) from exc
            except ColabRequestError as exc:
                code = get_status_code(exc)
                if code == 400:
                    raise AcceleratorNotEntitledError(
                        f"Account lacks quota or entitlement for {gpu}"
                    ) from exc
                if code in (502, 503, 504):
                    last_reason = f"HTTP {code}"
                else:
                    raise ColabGatewayError(f"Colab assign failed: {exc}") from exc
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
                last_reason = type(exc).__name__

            if attempt >= max_attempts:
                raise GpuCapacityUnavailableError(
                    f"Colab {gpu} capacity temporarily unavailable ({last_reason})"
                )

            delay = retry_delays[min(attempt - 1, len(retry_delays) - 1)]
            if on_retry is not None:
                await on_retry(attempt, max_attempts, delay, last_reason)

            remaining = delay
            while remaining > 0:
                if should_cancel is not None and await should_cancel():
                    raise AssignmentCancelledError("Job cancelled while waiting to retry")
                step = min(0.5, remaining)
                await asyncio.sleep(step)
                remaining -= step

        raise GpuCapacityUnavailableError(
            f"Colab {gpu} capacity temporarily unavailable ({last_reason})"
        )

    async def unassign(self, adc_json: dict[str, Any], endpoint: str) -> None:
        def _unassign() -> None:
            client, _ = self._build_client(adc_json)
            active = {a.endpoint for a in client.list_assignments()}
            if endpoint in active:
                client.unassign(endpoint)

        await asyncio.to_thread(_unassign)

    async def refresh_session_token(
        self,
        adc_json: dict[str, Any],
        session: AssignedSession,
    ) -> bool:
        assignments = await self.list_assignments(adc_json)
        for item in assignments:
            if item.endpoint == session.endpoint:
                session.token = item.token
                session.url = item.url
                session.token_expires_at = item.token_expires_at
                return True
        return False

    async def exec_in_kernel(
        self,
        session: AssignedSession,
        code: str,
        *,
        timeout: float = 600.0,
    ) -> str:
        def _exec() -> str:
            chunks: list[str] = []
            errors: list[str] = []

            def on_kernel(kid: str) -> None:
                session.kernel_id = kid

            def on_sess(sid: str) -> None:
                session.session_id = sid

            def on_output(out: dict[str, Any]) -> None:
                otype = out.get("output_type")
                if otype == "stream":
                    chunks.append(out.get("text", ""))
                elif otype == "error":
                    tb = "\n".join(out.get("traceback", []))
                    errors.append(f"{out.get('ename')}: {out.get('evalue')}\n{tb}")

            runtime = ColabRuntime(
                session.url,
                session.token,
                session_name=session.session_name,
                kernel_id=session.kernel_id,
                session_id=session.session_id,
                on_kernel_started=on_kernel,
                on_session_started=on_sess,
            )
            try:
                outputs = runtime.execute_code(
                    code,
                    allow_stdin=False,
                    output_hook=on_output,
                    timeout=timeout,
                )
            finally:
                runtime.stop(shutdown_kernel=False)

            if not errors:
                for out in outputs:
                    if out.get("output_type") == "error":
                        tb = "\n".join(out.get("traceback", []))
                        errors.append(f"{out.get('ename')}: {out.get('evalue')}\n{tb}")
            if errors:
                raise ColabGatewayError("\n".join(errors))
            return "".join(chunks)

        return await asyncio.to_thread(_exec)

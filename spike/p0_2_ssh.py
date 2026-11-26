"""Phase 0 - P0-2: OpenSSH ControlMaster multiplexing & SSH concurrency limit probe."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from spike.common import (
    SSH_KEY_PATH,
    VENV_PYTHON,
    build_colab_ssh_env,
    build_proxy_command,
)


class ControlMasterTunnel:
    """Manages a single multiplexed OpenSSH ControlMaster tunnel."""

    def __init__(
        self,
        *,
        session_name: str,
        auth_mode: str,
        sessions_path: Path,
        home_dir: Path,
        socket_path: Path,
        local_comfy_port: int,
        local_wd_port: int,
        adc_path: Path | None = None,
    ) -> None:
        self.session_name = session_name
        self.auth_mode = auth_mode
        self.sessions_path = sessions_path
        self.home_dir = home_dir
        self.socket_path = socket_path
        self.local_comfy_port = local_comfy_port
        self.local_wd_port = local_wd_port
        self.adc_path = adc_path
        self.proc: subprocess.Popen[bytes] | None = None
        self.env = build_colab_ssh_env(home_dir, adc_path=adc_path)

    def start(self, timeout: float = 45.0) -> float:
        if self.socket_path.exists():
            self.socket_path.unlink()
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        proxy_cmd = build_proxy_command(
            VENV_PYTHON, self.auth_mode, self.sessions_path, SSH_KEY_PATH, self.session_name
        )
        cmd = [
            "ssh",
            "-N",
            "-M",
            "-S",
            str(self.socket_path),
            "-i",
            str(SSH_KEY_PATH),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "ControlPersist=no",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=4",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            f"ProxyCommand={proxy_cmd}",
            "-L",
            f"127.0.0.1:{self.local_comfy_port}:127.0.0.1:8188",
            "-L",
            f"127.0.0.1:{self.local_wd_port}:127.0.0.1:8189",
            "root@colab-runtime",
        ]
        t0 = time.monotonic()
        self.proc = subprocess.Popen(
            cmd,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                stderr = (self.proc.stderr.read() if self.proc.stderr else b"").decode(errors="replace")
                raise RuntimeError(f"ControlMaster SSH exited early rc={self.proc.returncode}: {stderr}")
            if self.socket_path.exists() and self.check():
                return time.monotonic() - t0
            time.sleep(0.5)
        raise TimeoutError("Timed out waiting for ControlMaster SSH socket")

    def check(self) -> bool:
        res = subprocess.run(
            ["ssh", "-S", str(self.socket_path), "-O", "check", "root@colab-runtime"],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return res.returncode == 0

    def run_cmd(self, remote_cmd: str, timeout: float = 120.0) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["ssh", "-S", str(self.socket_path), "root@colab-runtime", remote_cmd],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def stop(self) -> None:
        if self.socket_path.exists():
            try:
                subprocess.run(
                    ["ssh", "-S", str(self.socket_path), "-O", "exit", "root@colab-runtime"],
                    env=self.env,
                    capture_output=True,
                    timeout=10,
                )
            except Exception:
                pass
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.socket_path.exists():
            try:
                self.socket_path.unlink()
            except OSError:
                pass


def probe_ssh_concurrency_limit(
    *,
    session_name: str,
    auth_mode: str,
    sessions_path: Path,
    home_dir: Path,
    existing_count: int = 1,
    max_total: int = 6,
) -> dict:
    """Open independent non-ControlMaster SSH connections until HTTP 429 or max_total."""
    env = build_colab_ssh_env(home_dir)
    proxy_cmd = build_proxy_command(
        VENV_PYTHON, auth_mode, sessions_path, SSH_KEY_PATH, session_name
    )
    procs: list[subprocess.Popen[str]] = []
    attempts: list[dict] = []
    observed_limit: int | None = None

    try:
        for idx in range(existing_count + 1, max_total + 1):
            p = subprocess.Popen(
                [
                    "ssh",
                    "-N",
                    "-i",
                    str(SSH_KEY_PATH),
                    "-o",
                    "IdentitiesOnly=yes",
                    "-o",
                    "StrictHostKeyChecking=no",
                    "-o",
                    "UserKnownHostsFile=/dev/null",
                    "-o",
                    "ControlMaster=no",
                    "-o",
                    "ControlPath=none",
                    "-o",
                    f"ProxyCommand={proxy_cmd}",
                    "root@colab-runtime",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            procs.append(p)
            time.sleep(5)
            rc = p.poll()
            if rc is not None:
                stderr = p.stderr.read() if p.stderr else ""
                attempts.append({"connection_num": idx, "status": "rejected", "rc": rc, "stderr": stderr.strip()})
                if "429" in stderr or "SSH session limit" in stderr or "Already-active SSH session" in stderr:
                    observed_limit = idx - 1
                    break
            else:
                attempts.append({"connection_num": idx, "status": "connected"})
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()

    return {
        "existing_connections": existing_count,
        "observed_concurrent_limit": observed_limit,
        "attempts": attempts,
    }

"""Single-connection OpenSSH ControlMaster tunnel (verified in Phase 0 P0-2)."""

from __future__ import annotations

import asyncio
import contextlib
import socket
import time
from pathlib import Path


def find_free_ports(count: int = 2) -> list[int]:
    """Allocate `count` free localhost TCP ports."""
    socks: list[socket.socket] = []
    ports: list[int] = []
    try:
        for _ in range(count):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            ports.append(sock.getsockname()[1])
            socks.append(sock)
    finally:
        for sock in socks:
            sock.close()
    return ports


class ControlMasterTunnel:
    """Supervises one foreground ControlMaster SSH connection per Colab runtime."""

    def __init__(
        self,
        *,
        socket_path: Path,
        ssh_key_path: Path,
        proxy_command: str,
        env: dict[str, str],
        local_comfy_port: int,
        local_wd_port: int,
    ) -> None:
        self.socket_path = socket_path
        self.ssh_key_path = ssh_key_path
        self.proxy_command = proxy_command
        self.env = env
        self.local_comfy_port = local_comfy_port
        self.local_wd_port = local_wd_port
        self.proc: asyncio.subprocess.Process | None = None

    def is_alive(self) -> bool:
        return (
            self.proc is not None
            and self.proc.returncode is None
            and self.socket_path.exists()
        )

    async def start(self, timeout: float = 45.0) -> None:
        if self.socket_path.exists():
            self.socket_path.unlink(missing_ok=True)
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)

        self.proc = await asyncio.create_subprocess_exec(
            "ssh",
            "-N",
            "-M",
            "-S",
            str(self.socket_path),
            "-i",
            str(self.ssh_key_path),
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
            f"ProxyCommand={self.proxy_command}",
            "-L",
            f"127.0.0.1:{self.local_comfy_port}:127.0.0.1:8188",
            "-L",
            f"127.0.0.1:{self.local_wd_port}:127.0.0.1:8189",
            "root@colab-runtime",
            env=self.env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.returncode is not None:
                err_bytes = await self.proc.stderr.read() if self.proc.stderr else b""
                err = err_bytes.decode(errors="replace").strip()
                raise RuntimeError(
                    f"ControlMaster SSH exited early rc={self.proc.returncode}: {err}"
                )
            if self.socket_path.exists() and await self.check():
                return
            await asyncio.sleep(0.5)
        await self.stop()
        raise TimeoutError("Timed out waiting for ControlMaster SSH socket")

    async def check(self) -> bool:
        proc = await asyncio.create_subprocess_exec(
            "ssh",
            "-S",
            str(self.socket_path),
            "-O",
            "check",
            "root@colab-runtime",
            env=self.env,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        return proc.returncode == 0

    async def run_cmd(self, remote_cmd: str, timeout: float = 120.0) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            "ssh",
            "-S",
            str(self.socket_path),
            "root@colab-runtime",
            remote_cmd,
            env=self.env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return (
            int(proc.returncode or 0),
            stdout_b.decode(errors="replace"),
            stderr_b.decode(errors="replace"),
        )

    async def stop(self) -> None:
        if self.socket_path.exists():
            with contextlib.suppress(Exception):
                exit_proc = await asyncio.create_subprocess_exec(
                    "ssh",
                    "-S",
                    str(self.socket_path),
                    "-O",
                    "exit",
                    "root@colab-runtime",
                    env=self.env,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(exit_proc.wait(), timeout=5.0)

        if self.proc is not None and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5.0)
            except TimeoutError:
                self.proc.kill()
                with contextlib.suppress(Exception):
                    await self.proc.wait()
        self.proc = None
        self.socket_path.unlink(missing_ok=True)

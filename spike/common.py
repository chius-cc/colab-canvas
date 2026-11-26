"""Shared helpers for colab-canvas Phase 0 spike scripts.

Safety invariant:
  - Always snapshot `baseline = {a.endpoint for a in client.list_assignments()}`
    before assigning a VM.
  - Never unassign any endpoint in `baseline`.
  - Always wrap managed endpoints in `try ... finally: safe_unassign(...)`.
"""

from __future__ import annotations

import json
import os
import shlex
import socket
import time
import uuid
from pathlib import Path
from typing import Any

from colab_cli.auth import AuthProvider, get_credentials
from colab_cli.client import (
    Accelerator,
    Client,
    PostAssignmentResponse,
    Prod,
    Variant,
)
from colab_cli.runtime import ColabRuntime
from colab_cli.state import SessionState, StateStore
from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2.credentials import Credentials

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCAL_DIR = REPO_ROOT / "spike" / ".local"
SSH_KEY_PATH = LOCAL_DIR / "ssh" / "id_ed25519"
VENV_PYTHON = REPO_ROOT / "spike" / ".venv" / "bin" / "python"


def make_client(adc_path: str | Path | None = None) -> tuple[Client, str]:
    """Build a colab_cli Client using either an isolated ADC JSON or keyring oauth2."""
    if adc_path is not None:
        creds = Credentials.from_authorized_user_file(str(adc_path))
        if not creds.valid:
            creds.refresh(Request())
        session = AuthorizedSession(creds)
        return Client(Prod(), session), "adc"

    session = get_credentials(provider=AuthProvider.OAUTH2)
    return Client(Prod(), session), "oauth2"


def prepare_isolated_home(home_dir: Path, session_state: SessionState | None = None) -> Path:
    """Create an isolated HOME directory with update checks disabled and optional session."""
    cli_dir = home_dir / ".config" / "colab-cli"
    cli_dir.mkdir(parents=True, exist_ok=True)
    settings_path = cli_dir / "settings.json"
    settings_path.write_text(
        json.dumps({"enable_update_check": False}, indent=2),
        encoding="utf-8",
    )
    sessions_path = home_dir / "sessions.json"
    if session_state is not None:
        StateStore(str(sessions_path)).add(session_state)
    return sessions_path


def build_colab_ssh_env(home_dir: Path, adc_path: str | Path | None = None) -> dict[str, str]:
    """Return environment dict with isolated HOME (and optional ADC credentials)."""
    env = os.environ.copy()
    env["HOME"] = str(home_dir)
    if adc_path is not None:
        env["GOOGLE_APPLICATION_CREDENTIALS"] = str(adc_path)
    else:
        env.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
    return env


def build_proxy_command(
    python_exe: str | Path,
    auth_mode: str,
    sessions_path: Path,
    key_path: Path,
    session_name: str,
) -> str:
    """Construct the OpenSSH ProxyCommand string for colab ssh --proxy-mode."""
    return shlex.join(
        [
            str(python_exe),
            "-m",
            "colab_cli.cli",
            "--auth",
            auth_mode,
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


def assign_l4(client: Client, session_name: str) -> tuple[SessionState, set[str], float]:
    """Snapshot baseline assignments and allocate one fresh L4 runtime."""
    baseline = {a.endpoint for a in client.list_assignments()}
    t0 = time.monotonic()
    res = client.assign(
        uuid.uuid4(),
        variant=Variant.GPU,
        accelerator=Accelerator.L4,
    )
    elapsed = time.monotonic() - t0

    if isinstance(res, PostAssignmentResponse):
        info = res.runtime_proxy_info
        variant_name = res.variant.name
    else:
        info = res.runtime_proxy_info
        variant_name = Variant.GPU.value

    session = SessionState(
        name=session_name,
        token=info.token,
        url=info.url,
        endpoint=res.endpoint,
        token_expires_at=info.expires_at(),
        variant=variant_name,
        accelerator=Accelerator.L4.value,
        machine_shape="STANDARD",
    )
    return session, baseline, elapsed


def safe_unassign(client: Client, endpoint: str, baseline: set[str]) -> bool:
    """Unassign `endpoint` iff it is not in `baseline` and still active on server."""
    if endpoint in baseline:
        raise RuntimeError(f"Refusing to unassign baseline endpoint: {endpoint}")
    active = {a.endpoint for a in client.list_assignments()}
    if endpoint not in active:
        return False
    client.unassign(endpoint)
    return True


def refresh_session_token(
    client: Client, session: SessionState, sessions_path: Path | None = None
) -> bool:
    """Refresh runtime proxy token/url from list_assignments()."""
    by_ep = {a.endpoint: a for a in client.list_assignments()}
    a = by_ep.get(session.endpoint)
    if a is None:
        return False
    session.token = a.runtime_proxy_info.token
    session.url = a.runtime_proxy_info.url
    session.token_expires_at = a.runtime_proxy_info.expires_at()
    if sessions_path is not None:
        StateStore(str(sessions_path)).add(session)
    return True


def exec_in_kernel(
    session: SessionState,
    code: str,
    timeout: float = 600.0,
    stream_to_stdout: bool = True,
) -> tuple[str, list[dict[str, Any]]]:
    """Execute Python code inside the remote Colab Jupyter kernel."""
    chunks: list[str] = []

    def on_kernel(kid: str) -> None:
        session.kernel_id = kid

    def on_sess(sid: str) -> None:
        session.session_id = sid

    def on_output(out: dict[str, Any]) -> None:
        otype = out.get("output_type")
        if otype == "stream":
            text = out.get("text", "")
            chunks.append(text)
            if stream_to_stdout:
                print(text, end="", flush=True)
        elif otype == "error":
            tb = "\n".join(out.get("traceback", []))
            msg = f"{out.get('ename')}: {out.get('evalue')}\n{tb}\n"
            chunks.append(msg)
            if stream_to_stdout:
                print(msg, end="", flush=True)

    runtime = ColabRuntime(
        session.url,
        session.token,
        session_name=session.name,
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

    return "".join(chunks), outputs


def find_free_ports(count: int = 2) -> list[int]:
    """Pick `count` distinct ephemeral localhost TCP ports."""
    sockets: list[socket.socket] = []
    ports: list[int] = []
    try:
        for _ in range(count):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("127.0.0.1", 0))
            ports.append(s.getsockname()[1])
            sockets.append(s)
    finally:
        for s in sockets:
            s.close()
    return ports

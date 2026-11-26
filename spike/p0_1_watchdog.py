"""Phase 0 - P0-1: Verify VM-side runtime.unassign() self-termination on L4.

Usage:
    spike/.venv/bin/python spike/p0_1_watchdog.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from spike.common import (
    LOCAL_DIR,
    SSH_KEY_PATH,
    VENV_PYTHON,
    assign_l4,
    build_colab_ssh_env,
    build_proxy_command,
    exec_in_kernel,
    make_client,
    prepare_isolated_home,
    safe_unassign,
)

IDLE_TIMEOUT_SEC = 75
POLL_INTERVAL_SEC = 10
MAX_POLL_SEC = 210

KERNEL_SETUP_CODE = f"""
import inspect
import json
import os
import subprocess
import sys

info = {{}}
try:
    from google.colab import runtime
    info["unassign_source"] = inspect.getsource(runtime.unassign)
except Exception as e:
    info["unassign_source_error"] = repr(e)

env_summary = {{}}
for k, v in sorted(os.environ.items()):
    if k.startswith(("TBE_", "COLAB_")):
        if any(s in k.upper() for s in ("TOKEN", "SECRET", "KEY", "AUTH")):
            env_summary[k] = "<REDACTED len=" + str(len(v)) + ">"
        else:
            env_summary[k] = v
info["kernel_env"] = env_summary
info["kernel_has_tbe_runtime_addr"] = "TBE_RUNTIME_ADDR" in os.environ

watchdog_code = '''import http.server
import json
import os
import threading
import time
import urllib.request

IDLE_TIMEOUT = {IDLE_TIMEOUT_SEC}
last_activity = time.monotonic()
lock = threading.Lock()
unassign_triggered = False

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/status":
            with lock:
                idle = time.monotonic() - last_activity
            body = json.dumps({{
                "ok": True,
                "idle_seconds": round(idle, 2),
                "idle_timeout": IDLE_TIMEOUT,
                "has_tbe_runtime_addr": "TBE_RUNTIME_ADDR" in os.environ,
                "tbe_runtime_addr": os.environ.get("TBE_RUNTIME_ADDR"),
                "unassign_triggered": unassign_triggered,
            }}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global last_activity
        if self.path == "/heartbeat":
            with lock:
                last_activity = time.monotonic()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{{"ok": true}}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

def monitor():
    global unassign_triggered
    while True:
        time.sleep(2)
        with lock:
            idle = time.monotonic() - last_activity
        if idle >= IDLE_TIMEOUT and not unassign_triggered:
            unassign_triggered = True
            print(f"[watchdog] {{time.strftime('%H:%M:%S')}} idle={{idle:.1f}}s >= {{IDLE_TIMEOUT}}s, calling runtime.unassign()", flush=True)
            try:
                from google.colab import runtime
                runtime.unassign()
                print(f"[watchdog] {{time.strftime('%H:%M:%S')}} runtime.unassign() returned", flush=True)
            except Exception as e:
                print(f"[watchdog] {{time.strftime('%H:%M:%S')}} runtime.unassign() error: {{e!r}}", flush=True)
            break

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8189), Handler)
t = threading.Thread(target=monitor, daemon=True)
t.start()
print(f"[watchdog] {{time.strftime('%H:%M:%S')}} started on 127.0.0.1:8189, TBE_RUNTIME_ADDR={{os.environ.get('TBE_RUNTIME_ADDR')}}", flush=True)
srv.serve_forever()
'''

with open("/tmp/test_watchdog.py", "w", encoding="utf-8") as f:
    f.write(watchdog_code)

log_f = open("/tmp/wd.log", "w", encoding="utf-8")
proc = subprocess.Popen(
    [sys.executable, "/tmp/test_watchdog.py"],
    start_new_session=True,
    stdout=log_f,
    stderr=subprocess.STDOUT,
)
info["watchdog_pid"] = proc.pid
print("KERNEL_INFO_JSON:" + json.dumps(info))
"""


def main() -> int:
    client, auth_mode = make_client()
    usage_before = client.get_consumption_user_info()
    print(
        f"[p0-1] Before: balance={usage_before.paid_compute_units_balance:.2f} CU, "
        f"rate={usage_before.consumption_rate_hourly:.2f}/hr, "
        f"assignments={usage_before.assignments_count}"
    )

    session, baseline, t_assign = assign_l4(client, "p0-1-wd")
    print(f"[p0-1] Assigned L4 endpoint={session.endpoint} in {t_assign:.2f}s (baseline={sorted(baseline)})")

    home_dir = LOCAL_DIR / "p0_1_home"
    if home_dir.exists():
        shutil.rmtree(home_dir)

    result: dict = {
        "endpoint": session.endpoint,
        "baseline_endpoints": sorted(baseline),
        "assign_seconds": round(t_assign, 2),
        "idle_timeout_seconds": IDLE_TIMEOUT_SEC,
        "passed": False,
    }

    try:
        out_text, _ = exec_in_kernel(session, KERNEL_SETUP_CODE, timeout=120.0, stream_to_stdout=False)
        t_wd_start = time.monotonic()

        kernel_info = {}
        for line in out_text.splitlines():
            if line.startswith("KERNEL_INFO_JSON:"):
                kernel_info = json.loads(line[len("KERNEL_INFO_JSON:") :])
        result["kernel_info"] = kernel_info
        print("[p0-1] Kernel inspection:")
        print(f"  kernel_has_tbe_runtime_addr = {kernel_info.get('kernel_has_tbe_runtime_addr')}")
        print(f"  kernel_env = {json.dumps(kernel_info.get('kernel_env', {}), indent=2)}")
        if "unassign_source" in kernel_info:
            print("  runtime.unassign source:\n" + kernel_info["unassign_source"])

        # Short SSH probe (before timeout) to inspect SSH shell env and watchdog /status
        sessions_path = prepare_isolated_home(home_dir, session)
        proxy_cmd = build_proxy_command(VENV_PYTHON, auth_mode, sessions_path, SSH_KEY_PATH, session.name)
        ssh_env = build_colab_ssh_env(home_dir)
        remote_cmd = (
            "echo '===SSH_ENV==='; env | grep -E '^(TBE_|COLAB_)' || true; "
            "echo '===WD_STATUS==='; curl -fsS http://127.0.0.1:8189/status; echo ''"
        )
        ssh_proc = subprocess.run(
            [
                "ssh",
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
                f"ProxyCommand={proxy_cmd}",
                "root@colab-runtime",
                remote_cmd,
            ],
            env=ssh_env,
            capture_output=True,
            text=True,
            timeout=45,
        )
        result["ssh_probe_returncode"] = ssh_proc.returncode
        result["ssh_probe_stdout"] = ssh_proc.stdout
        result["ssh_probe_stderr"] = ssh_proc.stderr
        result["ssh_has_tbe_runtime_addr"] = "TBE_RUNTIME_ADDR=" in ssh_proc.stdout
        print(f"[p0-1] SSH probe rc={ssh_proc.returncode}, ssh_has_tbe_runtime_addr={result['ssh_has_tbe_runtime_addr']}")
        print(ssh_proc.stdout.strip())
        if ssh_proc.stderr.strip():
            print("[p0-1] SSH stderr:", ssh_proc.stderr.strip())
        if ssh_proc.returncode != 0:
            log_out, _ = exec_in_kernel(
                session,
                "print(open('/tmp/wd.log').read())",
                timeout=20.0,
                stream_to_stdout=False,
            )
            raise RuntimeError(f"Watchdog HTTP probe failed:\n{log_out}")

        # Now wait with zero open connections to simulate control plane outage
        print(f"[p0-1] Waiting up to {MAX_POLL_SEC}s for autonomous VM unassign (idle timeout={IDLE_TIMEOUT_SEC}s)...")
        disappeared_at: float | None = None
        poll_history = []
        while (time.monotonic() - t_wd_start) <= MAX_POLL_SEC:
            time.sleep(POLL_INTERVAL_SEC)
            elapsed = time.monotonic() - t_wd_start
            active = [a.endpoint for a in client.list_assignments()]
            usage_now = client.get_consumption_user_info()
            present = session.endpoint in active
            poll_history.append(
                {
                    "elapsed_s": round(elapsed, 1),
                    "endpoint_present": present,
                    "assignments_count": usage_now.assignments_count,
                }
            )
            print(
                f"[p0-1] t=+{elapsed:5.1f}s | endpoint_present={present} | "
                f"assignments_count={usage_now.assignments_count}"
            )
            if not present and usage_now.assignments_count == len(baseline):
                disappeared_at = elapsed
                break

        result["poll_history"] = poll_history
        if disappeared_at is not None:
            result["passed"] = True
            result["total_release_seconds"] = round(disappeared_at, 2)
            result["post_timeout_release_seconds"] = round(disappeared_at - IDLE_TIMEOUT_SEC, 2)
            print(
                f"[p0-1] PASS! Endpoint vanished at +{disappeared_at:.1f}s "
                f"(+{disappeared_at - IDLE_TIMEOUT_SEC:.1f}s after {IDLE_TIMEOUT_SEC}s idle deadline)."
            )
        else:
            print("[p0-1] FAIL: Endpoint still active after polling window; collecting /tmp/wd.log...")
            try:
                log_out, _ = exec_in_kernel(
                    session,
                    "print(open('/tmp/wd.log').read())",
                    timeout=20.0,
                    stream_to_stdout=False,
                )
                result["wd_log"] = log_out
                print("=== /tmp/wd.log ===\n" + log_out)
            except Exception as e:
                result["wd_log_error"] = repr(e)
    finally:
        unassigned = safe_unassign(client, session.endpoint, baseline)
        if unassigned:
            print(f"[p0-1] Cleanup: safely unassigned managed endpoint {session.endpoint}")
        usage_after = client.get_consumption_user_info()
        result["usage_after"] = {
            "balance": usage_after.paid_compute_units_balance,
            "rate": usage_after.consumption_rate_hourly,
            "assignments_count": usage_after.assignments_count,
        }
        out_file = LOCAL_DIR / "p0_1_result.json"
        out_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"[p0-1] Saved result to {out_file}")

    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Detached VM watchdog launched inside the Colab Jupyter kernel.

Must be started via `colab exec` / Jupyter kernel so it inherits `TBE_RUNTIME_ADDR`.
Calls `google.colab.runtime.unassign()` (with direct POST fallback) when idle or
max lifetime is reached.
"""

from __future__ import annotations

import http.server
import json
import os
import threading
import time
import urllib.request

PORT = int(os.environ.get("WATCHDOG_PORT", "8189"))
IDLE_TIMEOUT = int(os.environ.get("WATCHDOG_IDLE_SECONDS", "1200"))
MAX_LIFETIME = int(os.environ.get("WATCHDOG_MAX_LIFETIME_SECONDS", "21600"))
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")

_started_at = time.monotonic()
_last_activity = _started_at
_lock = threading.Lock()
_unassigned = False


def _comfy_queue_empty() -> bool:
    try:
        with urllib.request.urlopen(f"{COMFY_URL}/queue", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            running = data.get("queue_running", [])
            pending = data.get("queue_pending", [])
            return len(running) == 0 and len(pending) == 0
    except Exception:
        return True


def _trigger_unassign() -> None:
    try:
        from google.colab import runtime

        runtime.unassign()
        return
    except Exception as exc:
        print(f"[vm_watchdog] runtime.unassign() error, trying HTTP fallback: {exc!r}", flush=True)

    addr = os.environ.get("TBE_RUNTIME_ADDR")
    if addr:
        req = urllib.request.Request(f"http://{addr}/unassign", data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"[vm_watchdog] fallback POST /unassign -> {resp.status}", flush=True)


class WatchdogHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/status":
            with _lock:
                idle = time.monotonic() - _last_activity
                unassigned = _unassigned
            payload = json.dumps(
                {
                    "ok": True,
                    "uptime_seconds": round(time.monotonic() - _started_at, 1),
                    "idle_seconds": round(idle, 1),
                    "idle_timeout": IDLE_TIMEOUT,
                    "max_lifetime": MAX_LIFETIME,
                    "has_tbe_runtime_addr": "TBE_RUNTIME_ADDR" in os.environ,
                    "unassigned": unassigned,
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self) -> None:
        global _last_activity
        if self.path == "/heartbeat":
            with _lock:
                _last_activity = time.monotonic()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        del format, args


def _monitor_loop() -> None:
    global _unassigned
    while True:
        time.sleep(10)
        now = time.monotonic()
        with _lock:
            idle = now - _last_activity
        uptime = now - _started_at
        if _unassigned:
            break
        if (idle >= IDLE_TIMEOUT and _comfy_queue_empty()) or uptime >= MAX_LIFETIME:
            with _lock:
                _unassigned = True
            print(
                f"[vm_watchdog] triggering unassign (idle={idle:.1f}s, uptime={uptime:.1f}s)",
                flush=True,
            )
            _trigger_unassign()
            break


def main() -> None:
    threading.Thread(target=_monitor_loop, daemon=True).start()
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), WatchdogHandler).serve_forever()


if __name__ == "__main__":
    main()

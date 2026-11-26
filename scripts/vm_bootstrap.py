"""Code generators for remote Colab VM bootstrap and on-demand weight/LoRA sync."""

from __future__ import annotations

import base64
import json
from typing import Any


def render_bootstrap_code(config: dict[str, Any], watchdog_source: str) -> str:
    """Render self-contained Python executed inside the Colab Jupyter kernel."""
    cfg_b64 = base64.b64encode(json.dumps(config).encode("utf-8")).decode("ascii")
    wd_b64 = base64.b64encode(watchdog_source.encode("utf-8")).decode("ascii")

    return f"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

cfg = json.loads(base64.b64decode("{cfg_b64}").decode("utf-8"))
wd_src = base64.b64decode("{wd_b64}").decode("utf-8")

COMFY_DIR = "/content/ComfyUI"
STAGE_DIR = "/content/hf_stage"
COMFY_COMMIT = cfg["comfyui_commit"]
t_boot_start = time.monotonic()
timings = {{}}

def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()

def _http_ok(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except Exception:
        pass
    return None

# 1. Clone ComfyUI & install non-torch requirements
t0 = time.monotonic()
if not os.path.exists(COMFY_DIR):
    subprocess.run(
        ["git", "clone", "--depth", "1", "https://github.com/Comfy-Org/ComfyUI.git", COMFY_DIR],
        check=True,
    )
    fetch_res = subprocess.run(
        ["git", "-C", COMFY_DIR, "fetch", "--depth", "1", "origin", COMFY_COMMIT],
        capture_output=True,
        text=True,
    )
    if fetch_res.returncode == 0:
        subprocess.run(["git", "-C", COMFY_DIR, "checkout", COMFY_COMMIT], check=True)

if not os.path.exists("/tmp/.comfy_deps_ready"):
    skip_pkgs = {{"torch", "torchvision", "torchaudio", "xformers"}}
    req_lines = []
    with open(os.path.join(COMFY_DIR, "requirements.txt"), "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            pkg = re.split(r"[<>=!~;\\[\\s]", s, maxsplit=1)[0].lower().replace("_", "-")
            if pkg in skip_pkgs:
                continue
            req_lines.append(s)
    filtered_req = "/tmp/comfy_reqs_notorch.txt"
    with open(filtered_req, "w", encoding="utf-8") as f:
        f.write("\\n".join(req_lines) + "\\n")
    if shutil.which("uv"):
        subprocess.run(
            ["uv", "pip", "install", "--system", "-q", "-r", filtered_req, "huggingface_hub"],
            check=True,
        )
    else:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "-r", filtered_req, "huggingface_hub"],
            check=True,
        )
    open("/tmp/.comfy_deps_ready", "w").write("1")
timings["deps_seconds"] = round(time.monotonic() - t0, 2)

# 2. Download requested model weights with HF_XET_HIGH_PERFORMANCE=1
t1 = time.monotonic()
os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
from huggingface_hub import hf_hub_download

os.makedirs(STAGE_DIR, exist_ok=True)
models_root = os.path.realpath(os.path.join(COMFY_DIR, "models"))
cached_files = []
for w in cfg.get("weights", []):
    rel = os.path.normpath(w["target_path"]).lstrip("/")
    dest = os.path.realpath(os.path.join(models_root, rel))
    if not dest.startswith(models_root + os.sep):
        raise RuntimeError(f"Unsafe model target path: {{rel}}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    expected_sha = (w.get("sha256") or "").lower()
    if not (os.path.exists(dest) and (not expected_sha or _sha256_file(dest) == expected_sha)):
        cached = hf_hub_download(
            repo_id=w["repo_id"],
            filename=w["repo_path"],
            local_dir=STAGE_DIR,
        )
        os.replace(cached, dest)
        if expected_sha:
            actual = _sha256_file(dest)
            if actual != expected_sha:
                os.unlink(dest)
                raise RuntimeError(f"SHA256 mismatch for {{rel}}: {{actual}} != {{expected_sha}}")
    cached_files.append(rel)
timings["weights_seconds"] = round(time.monotonic() - t1, 2)

# 3. Start Watchdog & ComfyUI headless if not already running
t2 = time.monotonic()
if _http_ok("http://127.0.0.1:8189/status") is None:
    with open("/tmp/vm_watchdog.py", "w", encoding="utf-8") as f:
        f.write(wd_src)
    wd_env = os.environ.copy()
    wd_env["WATCHDOG_IDLE_SECONDS"] = str(cfg.get("watchdog_idle_seconds", 1200))
    wd_env["WATCHDOG_MAX_LIFETIME_SECONDS"] = str(cfg.get("watchdog_max_lifetime_seconds", 21600))
    wd_log = open("/tmp/vm_watchdog.log", "w", encoding="utf-8")
    subprocess.Popen(
        [sys.executable, "/tmp/vm_watchdog.py"],
        env=wd_env,
        start_new_session=True,
        stdout=wd_log,
        stderr=subprocess.STDOUT,
    )

comfy_proc = None
if _http_ok("http://127.0.0.1:8188/system_stats") is None:
    comfy_log = open("/tmp/comfyui.log", "w", encoding="utf-8")
    comfy_proc = subprocess.Popen(
        [
            sys.executable,
            os.path.join(COMFY_DIR, "main.py"),
            "--listen",
            "127.0.0.1",
            "--port",
            "8188",
            "--disable-auto-launch",
        ],
        cwd=COMFY_DIR,
        start_new_session=True,
        stdout=comfy_log,
        stderr=subprocess.STDOUT,
    )

def _wait(url, timeout_s=180):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        data = _http_ok(url)
        if data is not None:
            return data
        if comfy_proc is not None and comfy_proc.poll() is not None:
            tail = open("/tmp/comfyui.log", encoding="utf-8", errors="replace").read()[-2000:]
            raise RuntimeError(f"ComfyUI exited rc={{comfy_proc.returncode}}:\\n{{tail}}")
        time.sleep(1.5)
    raise TimeoutError(f"Timed out waiting for {{url}}")

wd_status = _wait("http://127.0.0.1:8189/status", timeout_s=30)
sys_stats = _wait("http://127.0.0.1:8188/system_stats", timeout_s=180)
timings["launch_seconds"] = round(time.monotonic() - t2, 2)
timings["bootstrap_total_seconds"] = round(time.monotonic() - t_boot_start, 2)

head_sha = subprocess.check_output(
    ["git", "-C", COMFY_DIR, "rev-parse", "HEAD"], text=True
).strip()
print("BOOTSTRAP_RESULT_JSON:" + json.dumps({{
    "comfy_commit": head_sha,
    "cached_files": cached_files,
    "wd_status": wd_status,
    "timings": timings,
    "system": sys_stats.get("system", {{}}),
}}))
"""


def render_ensure_files_code(files: list[dict[str, Any]], civitai_token: str = "") -> str:
    """Render Python code to download missing model/LoRA files without restarting ComfyUI."""
    files_b64 = base64.b64encode(json.dumps(files).encode("utf-8")).decode("ascii")
    token_b64 = base64.b64encode(civitai_token.encode("utf-8")).decode("ascii")

    return f"""
import base64
import hashlib
import json
import os
import urllib.request

files = json.loads(base64.b64decode("{files_b64}").decode("utf-8"))
civitai_token = base64.b64decode("{token_b64}").decode("utf-8")

os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
from huggingface_hub import hf_hub_download

MODELS_ROOT = os.path.realpath("/content/ComfyUI/models")
STAGE_DIR = "/content/hf_stage_extra"
os.makedirs(STAGE_DIR, exist_ok=True)
DEFAULT_MAX_BYTES = 1_500_000_000

def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()

ensured = []
for item in files:
    rel = os.path.normpath(item["target_path"]).lstrip("/")
    dest = os.path.realpath(os.path.join(MODELS_ROOT, rel))
    if not dest.startswith(MODELS_ROOT + os.sep):
        raise RuntimeError(f"Unsafe target_path: {{rel}}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    expected_sha = (item.get("sha256") or "").lower()
    if os.path.exists(dest) and (not expected_sha or _sha256_file(dest) == expected_sha):
        ensured.append(rel)
        continue

    stype = item["source_type"]
    if stype == "hf_repo":
        cached = hf_hub_download(
            repo_id=item["repo_id"],
            filename=item["repo_path"],
            local_dir=STAGE_DIR,
        )
        os.replace(cached, dest)
    else:
        url = item["source_url"]
        max_bytes = int(item.get("max_bytes") or DEFAULT_MAX_BYTES)
        headers = {{"User-Agent": "colab-canvas/0.1"}}
        if stype == "civitai" and civitai_token:
            headers["Authorization"] = f"Bearer {{civitai_token}}"
        req = urllib.request.Request(url, headers=headers)
        tmp = dest + ".part"
        written = 0
        try:
            with urllib.request.urlopen(req, timeout=180) as resp, open(tmp, "wb") as out:
                while chunk := resp.read(1024 * 1024):
                    written += len(chunk)
                    if written > max_bytes:
                        raise RuntimeError(f"File {{rel}} exceeds max size {{max_bytes}} bytes")
                    out.write(chunk)
            os.replace(tmp, dest)
        except Exception:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    if expected_sha:
        actual = _sha256_file(dest)
        if actual != expected_sha:
            os.unlink(dest)
            raise RuntimeError(f"SHA256 mismatch for {{rel}}: {{actual}} != {{expected_sha}}")
    ensured.append(rel)

print("ENSURE_FILES_RESULT_JSON:" + json.dumps({{"ensured": ensured}}))
"""

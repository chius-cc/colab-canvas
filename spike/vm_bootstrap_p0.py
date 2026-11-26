"""Remote bootstrap code executed inside Colab Jupyter kernel via colab exec."""

BOOTSTRAP_CODE = r"""
import http.server
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

t_boot_start = time.monotonic()
timings = {}

import torch
print(f"[boot] torch={torch.__version__}, cuda={torch.cuda.is_available()}", flush=True)
gpu_info = {}
if torch.cuda.is_available():
    props = torch.cuda.get_device_properties(0)
    gpu_info = {
        "name": props.name,
        "total_vram_gb": round(props.total_memory / (1024 ** 3), 2),
    }
    print(f"[boot] GPU={gpu_info['name']}, VRAM={gpu_info['total_vram_gb']} GB", flush=True)

COMFY_DIR = "/content/ComfyUI"
LOCKED_COMMIT = "4a4b3409792d499cc36626d76a24fe425f40b5e7"

# 1. Clone ComfyUI & install non-torch requirements
t0 = time.monotonic()
if not os.path.exists(COMFY_DIR):
    subprocess.run(
        ["git", "clone", "--depth", "1", "https://github.com/Comfy-Org/ComfyUI.git", COMFY_DIR],
        check=True,
    )
    fetch_res = subprocess.run(
        ["git", "-C", COMFY_DIR, "fetch", "--depth", "1", "origin", LOCKED_COMMIT],
        capture_output=True,
        text=True,
    )
    if fetch_res.returncode == 0:
        subprocess.run(["git", "-C", COMFY_DIR, "checkout", LOCKED_COMMIT], check=True)
    else:
        print(f"[boot] Warning: could not fetch {LOCKED_COMMIT}, staying on shallow HEAD", flush=True)

comfy_commit = subprocess.check_output(
    ["git", "-C", COMFY_DIR, "rev-parse", "HEAD"], text=True
).strip()

skip_pkgs = {"torch", "torchvision", "torchaudio", "xformers"}
req_lines = []
with open(os.path.join(COMFY_DIR, "requirements.txt"), "r", encoding="utf-8") as f:
    for line in f:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        pkg = re.split(r"[<>=!~;\[\s]", s, maxsplit=1)[0].lower().replace("_", "-")
        if pkg in skip_pkgs:
            continue
        req_lines.append(s)

filtered_req = "/tmp/comfy_reqs_notorch.txt"
with open(filtered_req, "w", encoding="utf-8") as f:
    f.write("\n".join(req_lines) + "\n")

if shutil.which("uv"):
    subprocess.run(
        ["uv", "pip", "install", "--system", "-q", "-r", filtered_req, "huggingface_hub", "hf_transfer"],
        check=True,
    )
else:
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "-r", filtered_req, "huggingface_hub", "hf_transfer"],
        check=True,
    )
timings["deps_seconds"] = round(time.monotonic() - t0, 2)
print(f"[boot] ComfyUI commit={comfy_commit}, deps installed in {timings['deps_seconds']}s", flush=True)

# 2. Download ONLY turbo variant weights with hf_transfer
t1 = time.monotonic()
os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
from huggingface_hub import hf_hub_download

stage_dir = "/content/hf_stage"
os.makedirs(stage_dir, exist_ok=True)

WEIGHTS = [
    (
        "split_files/text_encoders/qwen_3_06b_base.safetensors",
        os.path.join(COMFY_DIR, "models", "text_encoders", "qwen_3_06b_base.safetensors"),
        "cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba",
    ),
    (
        "split_files/vae/qwen_image_vae.safetensors",
        os.path.join(COMFY_DIR, "models", "vae", "qwen_image_vae.safetensors"),
        "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
    ),
    (
        "split_files/diffusion_models/anima-turbo-v1.1.safetensors",
        os.path.join(COMFY_DIR, "models", "diffusion_models", "anima-turbo-v1.1.safetensors"),
        "fba11953276b57edf59d1dc4f1857ac05aa079c56f982b4d7c20298d57d3f7eb",
    ),
]

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()

downloaded_files = {}
for hf_path, dest_path, expected_sha in WEIGHTS:
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    if not os.path.exists(dest_path):
        cached = hf_hub_download(
            repo_id="circlestone-labs/Anima",
            filename=hf_path,
            local_dir=stage_dir,
        )
        os.replace(cached, dest_path)
    actual_sha = sha256_file(dest_path)
    if actual_sha != expected_sha:
        raise RuntimeError(f"SHA256 mismatch for {dest_path}: {actual_sha} != {expected_sha}")
    downloaded_files[os.path.basename(dest_path)] = {
        "size_bytes": os.path.getsize(dest_path),
        "sha256_ok": True,
    }

timings["weights_seconds"] = round(time.monotonic() - t1, 2)
print(f"[boot] Weights downloaded & verified in {timings['weights_seconds']}s", flush=True)

# 3. Launch Watchdog (20m idle, 6h max lifetime) & ComfyUI headless
t2 = time.monotonic()
watchdog_code = '''import http.server
import json
import os
import threading
import time
import urllib.request

IDLE_TIMEOUT = 1200
MAX_LIFETIME = 21600
started_at = time.monotonic()
last_activity = started_at
lock = threading.Lock()
unassigned = False

def comfy_queue_empty():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8188/queue", timeout=3) as resp:
            data = json.loads(resp.read().decode())
            return len(data.get("queue_running", [])) == 0 and len(data.get("queue_pending", [])) == 0
    except Exception:
        return True

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/status":
            with lock:
                idle = time.monotonic() - last_activity
            body = json.dumps({
                "ok": True,
                "uptime_seconds": round(time.monotonic() - started_at, 1),
                "idle_seconds": round(idle, 1),
                "has_tbe_runtime_addr": "TBE_RUNTIME_ADDR" in os.environ,
            }).encode()
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
            self.wfile.write(b'{"ok": true}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

def monitor():
    global unassigned
    while True:
        time.sleep(10)
        now = time.monotonic()
        with lock:
            idle = now - last_activity
        uptime = now - started_at
        if not unassigned and ((idle >= IDLE_TIMEOUT and comfy_queue_empty()) or uptime >= MAX_LIFETIME):
            unassigned = True
            from google.colab import runtime
            runtime.unassign()
            break

threading.Thread(target=monitor, daemon=True).start()
http.server.ThreadingHTTPServer(("127.0.0.1", 8189), Handler).serve_forever()
'''

with open("/tmp/vm_watchdog.py", "w", encoding="utf-8") as f:
    f.write(watchdog_code)

wd_log = open("/tmp/vm_watchdog.log", "w", encoding="utf-8")
wd_proc = subprocess.Popen(
    [sys.executable, "/tmp/vm_watchdog.py"],
    start_new_session=True,
    stdout=wd_log,
    stderr=subprocess.STDOUT,
)

comfy_log = open("/tmp/comfyui.log", "w", encoding="utf-8")
comfy_proc = subprocess.Popen(
    [sys.executable, os.path.join(COMFY_DIR, "main.py"), "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"],
    cwd=COMFY_DIR,
    start_new_session=True,
    stdout=comfy_log,
    stderr=subprocess.STDOUT,
)

def wait_http(url, timeout_s=180):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                if resp.status == 200:
                    return json.loads(resp.read().decode())
        except Exception:
            pass
        if comfy_proc.poll() is not None:
            tail = open("/tmp/comfyui.log", encoding="utf-8", errors="replace").read()[-2000:]
            raise RuntimeError(f"ComfyUI exited early rc={comfy_proc.returncode}:\n{tail}")
        time.sleep(1.5)
    raise TimeoutError(f"Timed out waiting for {url}")

wd_status = wait_http("http://127.0.0.1:8189/status", timeout_s=30)
sys_stats = wait_http("http://127.0.0.1:8188/system_stats", timeout_s=180)
timings["launch_seconds"] = round(time.monotonic() - t2, 2)
timings["bootstrap_total_seconds"] = round(time.monotonic() - t_boot_start, 2)

result = {
    "torch_version": torch.__version__,
    "gpu_info": gpu_info,
    "comfy_commit": comfy_commit,
    "timings": timings,
    "downloaded_files": downloaded_files,
    "wd_status": wd_status,
    "comfy_system_stats": sys_stats.get("system", {}),
    "comfy_pid": comfy_proc.pid,
    "watchdog_pid": wd_proc.pid,
}
print("BOOTSTRAP_RESULT_JSON:" + json.dumps(result))
"""

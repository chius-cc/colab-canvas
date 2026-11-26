"""Phase 0 - P0-2, P0-5, P0-6: Clean L4 cold start, ControlMaster SSH, Anima Turbo/Aesthetic, LoRA & reconnect recovery.

Usage:
    spike/.venv/bin/python -u spike/p0_5_p0_6_comfy_anima.py
"""

from __future__ import annotations

import json
import shutil
import sys
import time
import uuid
from pathlib import Path

import httpx
import websocket
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from spike.common import (
    LOCAL_DIR,
    assign_l4,
    exec_in_kernel,
    find_free_ports,
    make_client,
    prepare_isolated_home,
    refresh_session_token,
    safe_unassign,
)
from spike.p0_2_ssh import ControlMasterTunnel, probe_ssh_concurrency_limit
from spike.vm_bootstrap_p0 import BOOTSTRAP_CODE

AESTHETIC_FILENAME = "anima-aesthetic-v1.1.safetensors"
TURBO_FILENAME = "anima-turbo-v1.1.safetensors"
LORA_FILENAME = "anima-highres-aesthetic-boost.safetensors"


def build_anima_prompt_graph(
    *,
    unet_name: str,
    prompt: str,
    negative_prompt: str,
    steps: int,
    cfg: float,
    sampler_name: str,
    seed: int = 42,
    width: int = 1024,
    height: int = 1024,
    filename_prefix: str = "p0_test",
    lora_name: str | None = None,
    lora_strength: float = 0.8,
) -> dict:
    model_ref: list = ["1", 0]
    graph: dict = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": unet_name, "weight_dtype": "default"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": "qwen_3_06b_base.safetensors",
                "type": "stable_diffusion",
                "device": "default",
            },
        },
        "3": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "qwen_image_vae.safetensors"},
        },
    }
    if lora_name:
        graph["10"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": ["1", 0],
                "lora_name": lora_name,
                "strength_model": lora_strength,
            },
        }
        model_ref = ["10", 0]

    graph.update(
        {
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": prompt, "clip": ["2", 0]},
            },
            "5": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": negative_prompt, "clip": ["2", 0]},
            },
            "6": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": width, "height": height, "batch_size": 1},
            },
            "7": {
                "class_type": "KSampler",
                "inputs": {
                    "model": model_ref,
                    "positive": ["4", 0],
                    "negative": ["5", 0],
                    "latent_image": ["6", 0],
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": sampler_name,
                    "scheduler": "simple",
                    "denoise": 1.0,
                },
            },
            "8": {
                "class_type": "VAEDecode",
                "inputs": {"samples": ["7", 0], "vae": ["3", 0]},
            },
            "9": {
                "class_type": "SaveImage",
                "inputs": {"images": ["8", 0], "filename_prefix": filename_prefix},
            },
        }
    )
    return graph


def submit_and_wait_comfy(
    *,
    base_http: str,
    prompt_graph: dict,
    out_path: Path,
    timeout_s: float = 300.0,
) -> dict:
    cid = str(uuid.uuid4())
    ws_url = base_http.replace("http://", "ws://") + f"/ws?clientId={cid}"
    ws = websocket.create_connection(ws_url, timeout=30)
    ws.settimeout(2.0)

    progress_events = 0
    t0 = time.monotonic()
    try:
        resp = httpx.post(
            f"{base_http}/prompt",
            json={"prompt": prompt_graph, "client_id": cid},
            timeout=30,
        )
        resp.raise_for_status()
        prompt_id = resp.json()["prompt_id"]

        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                raw = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if isinstance(raw, bytes):
                continue
            msg = json.loads(raw)
            mtype = msg.get("type")
            data = msg.get("data", {})
            if mtype == "progress" and data.get("prompt_id") == prompt_id:
                progress_events += 1
            elif mtype == "execution_error" and data.get("prompt_id") == prompt_id:
                raise RuntimeError(f"ComfyUI execution_error: {json.dumps(data)}")
            elif mtype == "executing" and data.get("prompt_id") == prompt_id and data.get("node") is None:
                break
        else:
            raise TimeoutError(f"Timed out waiting for ComfyUI prompt {prompt_id}")
    finally:
        ws.close()

    elapsed = time.monotonic() - t0
    hist = httpx.get(f"{base_http}/history/{prompt_id}", timeout=30).json()
    outputs = hist[prompt_id]["outputs"]
    images_meta = outputs["9"]["images"]
    img_info = images_meta[0]

    view_resp = httpx.get(
        f"{base_http}/view",
        params={
            "filename": img_info["filename"],
            "subfolder": img_info.get("subfolder", ""),
            "type": img_info.get("type", "output"),
        },
        timeout=60,
    )
    view_resp.raise_for_status()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(view_resp.content)

    with Image.open(out_path) as im:
        size = im.size
        fmt = im.format

    return {
        "prompt_id": prompt_id,
        "elapsed_seconds": round(elapsed, 2),
        "ws_progress_events": progress_events,
        "image_size": list(size),
        "image_format": fmt,
        "bytes": len(view_resp.content),
        "output_path": str(out_path),
    }


def query_vram_mb(tunnel: ControlMasterTunnel) -> dict:
    res = tunnel.run_cmd(
        "nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits"
    )
    if res.returncode != 0:
        return {"error": res.stderr.strip()}
    parts = [p.strip() for p in res.stdout.strip().split(",")]
    return {
        "gpu": parts[0],
        "memory_used_mb": int(parts[1]),
        "memory_total_mb": int(parts[2]),
    }


def main() -> int:
    client, auth_mode = make_client()
    usage_before = client.get_consumption_user_info()
    print(
        f"[p0-5/6] Before: balance={usage_before.paid_compute_units_balance:.2f} CU, "
        f"assignments={usage_before.assignments_count}"
    )

    session, baseline, t_assign = assign_l4(client, "p0-5-anima")
    print(f"[p0-5/6] Assigned L4 endpoint={session.endpoint} in {t_assign:.2f}s")

    home_dir = LOCAL_DIR / "p0_5_home"
    if home_dir.exists():
        shutil.rmtree(home_dir)
    sessions_path = prepare_isolated_home(home_dir, session)

    comfy_port, wd_port = find_free_ports(2)
    socket_path = LOCAL_DIR / "cm_p0.sock"
    tunnel = ControlMasterTunnel(
        session_name=session.name,
        auth_mode=auth_mode,
        sessions_path=sessions_path,
        home_dir=home_dir,
        socket_path=socket_path,
        local_comfy_port=comfy_port,
        local_wd_port=wd_port,
    )

    report: dict = {
        "endpoint": session.endpoint,
        "assign_seconds": round(t_assign, 2),
        "passed": False,
    }

    try:
        # 1. P0-5 Clean Cold Start Bootstrap via kernel (colab exec equivalent)
        print("[p0-5] Running vm_bootstrap_p0.py inside Jupyter kernel...")
        boot_out, _ = exec_in_kernel(session, BOOTSTRAP_CODE, timeout=600.0, stream_to_stdout=True)
        boot_info = {}
        for line in boot_out.splitlines():
            if line.startswith("BOOTSTRAP_RESULT_JSON:"):
                boot_info = json.loads(line[len("BOOTSTRAP_RESULT_JSON:") :])
        if not boot_info:
            raise RuntimeError("Missing BOOTSTRAP_RESULT_JSON from bootstrap output")

        boot_info["timings"]["assign_seconds"] = round(t_assign, 2)
        boot_info["timings"]["cold_start_total_seconds"] = round(
            t_assign + boot_info["timings"]["bootstrap_total_seconds"], 2
        )
        report["p0_5_bootstrap"] = boot_info
        print(f"[p0-5] Cold start summary: {json.dumps(boot_info['timings'])}")

        # 2. P0-2a Open single ControlMaster multiplexed SSH tunnel
        t_tunnel = tunnel.start(timeout=45.0)
        base_http = f"http://127.0.0.1:{comfy_port}"
        wd_http = f"http://127.0.0.1:{wd_port}"
        stats_resp = httpx.get(f"{base_http}/system_stats", timeout=15)
        hb_resp = httpx.post(f"{wd_http}/heartbeat", timeout=15)
        vram_idle = query_vram_mb(tunnel)
        assert stats_resp.status_code == 200 and hb_resp.status_code == 200
        report["p0_2a_control_master"] = {
            "tunnel_connect_seconds": round(t_tunnel, 2),
            "comfy_stats_status": stats_resp.status_code,
            "watchdog_hb_status": hb_resp.status_code,
            "vram_before_gen": vram_idle,
        }
        print(f"[p0-2a] ControlMaster OK in {t_tunnel:.2f}s | VRAM idle={vram_idle}")

        pos = "masterpiece, best quality, 1girl, silver hair, blue eyes, standing at a sunlit train station platform, gentle wind, anime illustration"
        neg = "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts"

        # 3. P0-6a Anima Turbo (cold model load + warm second run)
        turbo_graph_1 = build_anima_prompt_graph(
            unet_name=TURBO_FILENAME,
            prompt=pos,
            negative_prompt=neg,
            steps=10,
            cfg=1.0,
            sampler_name="euler",
            seed=101,
            filename_prefix="p0_turbo_1",
        )
        res_turbo_1 = submit_and_wait_comfy(
            base_http=base_http,
            prompt_graph=turbo_graph_1,
            out_path=LOCAL_DIR / "outputs" / "anima_turbo_coldload.png",
        )
        turbo_graph_2 = build_anima_prompt_graph(
            unet_name=TURBO_FILENAME,
            prompt=pos,
            negative_prompt=neg,
            steps=10,
            cfg=1.0,
            sampler_name="euler",
            seed=102,
            filename_prefix="p0_turbo_2",
        )
        res_turbo_2 = submit_and_wait_comfy(
            base_http=base_http,
            prompt_graph=turbo_graph_2,
            out_path=LOCAL_DIR / "outputs" / "anima_turbo.png",
        )
        vram_after_turbo = query_vram_mb(tunnel)
        print(f"[p0-6a] Turbo cold_load={res_turbo_1['elapsed_seconds']}s, warm={res_turbo_2['elapsed_seconds']}s, VRAM={vram_after_turbo}")

        # 4. P0-6b On-demand download anima-aesthetic-v1.1 WITHOUT restarting ComfyUI
        t_dl0 = time.monotonic()
        dl_cmd = (
            "HF_XET_HIGH_PERFORMANCE=1 python3 -c \""
            "import os; from huggingface_hub import hf_hub_download; "
            f"p=hf_hub_download('circlestone-labs/Anima','split_files/diffusion_models/{AESTHETIC_FILENAME}',local_dir='/content/hf_stage'); "
            f"os.replace(p, '/content/ComfyUI/models/diffusion_models/{AESTHETIC_FILENAME}')\""
        )
        dl_res = tunnel.run_cmd(dl_cmd, timeout=180)
        if dl_res.returncode != 0:
            raise RuntimeError(f"Aesthetic download failed: {dl_res.stderr}")
        t_aesthetic_dl = round(time.monotonic() - t_dl0, 2)

        aes_graph = build_anima_prompt_graph(
            unet_name=AESTHETIC_FILENAME,
            prompt=pos,
            negative_prompt="worst quality, low quality, blurry, jpeg artifacts",
            steps=30,
            cfg=4.0,
            sampler_name="er_sde",
            seed=201,
            filename_prefix="p0_aesthetic",
        )
        res_aesthetic = submit_and_wait_comfy(
            base_http=base_http,
            prompt_graph=aes_graph,
            out_path=LOCAL_DIR / "outputs" / "anima_aesthetic.png",
            timeout_s=360.0,
        )
        vram_after_aesthetic = query_vram_mb(tunnel)
        print(f"[p0-6b] Aesthetic dl={t_aesthetic_dl}s, gen={res_aesthetic['elapsed_seconds']}s, VRAM={vram_after_aesthetic}")

        # 5. P0-6c Dynamic LoRA download & inference WITHOUT restarting ComfyUI
        t_lora0 = time.monotonic()
        lora_cmd = (
            "HF_XET_HIGH_PERFORMANCE=1 python3 -c \""
            "import os; from huggingface_hub import hf_hub_download; "
            "os.makedirs('/content/ComfyUI/models/loras', exist_ok=True); "
            f"p=hf_hub_download('circlestone-labs/Anima-Official-LoRAs','{LORA_FILENAME}',local_dir='/content/hf_stage_lora'); "
            f"os.replace(p, '/content/ComfyUI/models/loras/{LORA_FILENAME}')\""
        )
        lora_dl = tunnel.run_cmd(lora_cmd, timeout=120)
        if lora_dl.returncode != 0:
            raise RuntimeError(f"LoRA download failed: {lora_dl.stderr}")
        t_lora_dl = round(time.monotonic() - t_lora0, 2)

        lora_graph = build_anima_prompt_graph(
            unet_name=TURBO_FILENAME,
            prompt=pos,
            negative_prompt=neg,
            steps=10,
            cfg=1.0,
            sampler_name="euler",
            seed=301,
            filename_prefix="p0_turbo_lora",
            lora_name=LORA_FILENAME,
            lora_strength=0.8,
        )
        res_lora = submit_and_wait_comfy(
            base_http=base_http,
            prompt_graph=lora_graph,
            out_path=LOCAL_DIR / "outputs" / "anima_turbo_lora.png",
        )
        print(f"[p0-6c] LoRA dl={t_lora_dl}s, gen={res_lora['elapsed_seconds']}s (no ComfyUI restart)")

        # 6. P0-6d Tunnel drop & reconnect /history recovery
        rec_graph = build_anima_prompt_graph(
            unet_name=TURBO_FILENAME,
            prompt=pos,
            negative_prompt=neg,
            steps=10,
            cfg=1.0,
            sampler_name="euler",
            seed=401,
            filename_prefix="p0_reconnect",
        )
        sub_resp = httpx.post(
            f"{base_http}/prompt",
            json={"prompt": rec_graph, "client_id": str(uuid.uuid4())},
            timeout=30,
        )
        sub_resp.raise_for_status()
        rec_prompt_id = sub_resp.json()["prompt_id"]

        # Simulate tunnel drop
        tunnel.stop()
        time.sleep(3)
        refresh_session_token(client, session, sessions_path)
        t_reconnect = round(tunnel.start(timeout=45.0), 2)

        # Poll /history/{prompt_id} after reconnect
        rec_deadline = time.monotonic() + 90
        rec_img_info = None
        while time.monotonic() < rec_deadline:
            h = httpx.get(f"{base_http}/history/{rec_prompt_id}", timeout=15).json()
            if rec_prompt_id in h and "outputs" in h[rec_prompt_id]:
                rec_img_info = h[rec_prompt_id]["outputs"]["9"]["images"][0]
                break
            time.sleep(1.5)
        assert rec_img_info is not None, "Failed to recover prompt output from /history after reconnect"
        rec_view = httpx.get(
            f"{base_http}/view",
            params={"filename": rec_img_info["filename"], "type": "output"},
            timeout=30,
        )
        rec_view.raise_for_status()
        rec_out = LOCAL_DIR / "outputs" / "anima_reconnect.png"
        rec_out.write_bytes(rec_view.content)
        print(f"[p0-6d] Reconnect recovery PASS in {t_reconnect}s (recovered {len(rec_view.content)} bytes)")

        report["p0_6"] = {
            "turbo_coldload": res_turbo_1,
            "turbo_warm": res_turbo_2,
            "vram_after_turbo": vram_after_turbo,
            "aesthetic_download_seconds": t_aesthetic_dl,
            "aesthetic": res_aesthetic,
            "vram_after_aesthetic": vram_after_aesthetic,
            "lora_download_seconds": t_lora_dl,
            "lora": res_lora,
            "reconnect_seconds": t_reconnect,
            "reconnect_recovered_bytes": len(rec_view.content),
        }

        # 7. P0-2b Probe concurrent SSH session limit while ControlMaster (1 conn) is open
        print("[p0-2b] Probing concurrent SSH session limit...")
        limit_res = probe_ssh_concurrency_limit(
            session_name=session.name,
            auth_mode=auth_mode,
            sessions_path=sessions_path,
            home_dir=home_dir,
            existing_count=1,
            max_total=6,
        )
        report["p0_2b_ssh_limit"] = limit_res
        print(f"[p0-2b] SSH limit probe result: {json.dumps(limit_res)}")

        report["passed"] = True
    finally:
        tunnel.stop()
        unassigned = safe_unassign(client, session.endpoint, baseline)
        if unassigned:
            print(f"[p0-5/6] Cleanup: safely unassigned managed endpoint {session.endpoint}")
        usage_after = client.get_consumption_user_info()
        report["usage_after"] = {
            "balance": usage_after.paid_compute_units_balance,
            "rate": usage_after.consumption_rate_hourly,
            "assignments_count": usage_after.assignments_count,
        }
        out_file = LOCAL_DIR / "p0_2_5_6_result.json"
        out_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"[p0-5/6] Saved report to {out_file}")

    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

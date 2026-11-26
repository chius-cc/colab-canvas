"""Phase 0 - P0-4: Verify long-lived Google Drive Desktop OAuth (drive.file only).

Usage:
    spike/.venv/bin/python spike/p0_4_drive.py --client-secrets path/to/client_secret.json
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from spike.common import LOCAL_DIR

SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def _ensure_test_png(path: Path) -> Path:
    turbo = LOCAL_DIR / "outputs" / "anima_turbo.png"
    if turbo.exists():
        return turbo
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (512, 512), color=(240, 232, 224))
    img.save(path, format="PNG")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 0 P0-4 Google Drive API v3 validation")
    parser.add_argument("--client-secrets", type=Path, help="Path to Desktop OAuth client_secret.json")
    parser.add_argument(
        "--token-out",
        type=Path,
        default=LOCAL_DIR / "drive_token.json",
        help="Path to save/reuse authorized user token JSON",
    )
    args = parser.parse_args()

    token_path: Path = args.token_out
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        if not creds.valid and creds.refresh_token:
            creds.refresh(Request())
            token_path.write_text(creds.to_json(), encoding="utf-8")
    else:
        if not args.client_secrets:
            parser.error("--client-secrets is required on first run when --token-out does not exist")
        flow = InstalledAppFlow.from_client_secrets_file(str(args.client_secrets), SCOPES)
        creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
        token_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(token_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(creds.to_json())

    token_data = json.loads(token_path.read_text(encoding="utf-8"))
    print(f"[p0-4] Token saved at {token_path}")
    print(f"[p0-4] has_refresh_token={bool(creds.refresh_token)}")
    print(f"[p0-4] refresh_token_expires_in={token_data.get('refresh_token_expires_in')} (None usually indicates In-production)")

    service = build("drive", "v3", credentials=creds, cache_discovery=False)
    src_png = _ensure_test_png(LOCAL_DIR / "outputs" / "drive_synthetic_test.png")
    src_bytes = src_png.read_bytes()
    src_sha = hashlib.sha256(src_bytes).hexdigest()

    # 1. Create app-owned root folder (required under drive.file scope)
    folder = (
        service.files()
        .create(
            body={"name": "colab-canvas-spike", "mimeType": "application/vnd.google-apps.folder"},
            fields="id,name",
        )
        .execute()
    )
    folder_id = folder["id"]
    print(f"[p0-4] Created folder id={folder_id}")

    file_id = None
    try:
        t0 = time.monotonic()
        media = MediaFileUpload(str(src_png), mimetype="image/png", resumable=False)
        uploaded = (
            service.files()
            .create(
                body={"name": src_png.name, "parents": [folder_id]},
                media_body=media,
                fields="id,size",
            )
            .execute()
        )
        t_upload = time.monotonic() - t0
        file_id = uploaded["id"]
        print(f"[p0-4] Uploaded {len(src_bytes)} bytes -> file_id={file_id} in {t_upload:.2f}s")

        # 2. Range download test via AuthorizedSession
        authed = AuthorizedSession(creds)
        range_resp = authed.get(
            f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media",
            headers={"Range": "bytes=0-15"},
            timeout=30,
        )
        assert range_resp.status_code == 206 and len(range_resp.content) == 16, (
            f"Unexpected range response: {range_resp.status_code} len={len(range_resp.content)}"
        )

        # 3. Full download integrity verification
        t1 = time.monotonic()
        buf = io.BytesIO()
        downloader = MediaIoBaseDownload(buf, service.files().get_media(fileId=file_id))
        done = False
        while not done:
            _, done = downloader.next_chunk()
        t_download = time.monotonic() - t1
        dl_sha = hashlib.sha256(buf.getvalue()).hexdigest()
        assert dl_sha == src_sha, f"SHA256 mismatch: {dl_sha} != {src_sha}"
        print(f"[p0-4] Range=206 OK, Full download OK in {t_download:.2f}s, SHA256 matched.")

        result = {
            "passed": True,
            "folder_id": folder_id,
            "upload_seconds": round(t_upload, 2),
            "download_seconds": round(t_download, 2),
            "bytes": len(src_bytes),
            "refresh_token_expires_in": token_data.get("refresh_token_expires_in"),
        }
        (LOCAL_DIR / "p0_4_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    finally:
        if file_id:
            service.files().delete(fileId=file_id).execute()
        service.files().delete(fileId=folder_id).execute()
        print("[p0-4] Cleaned up Drive test file and folder.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

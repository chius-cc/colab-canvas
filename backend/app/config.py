"""Application configuration loaded from environment / .env."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    canvas_secret_key: str = Field(..., min_length=32)
    canvas_data_dir: Path = Path("./data")
    canvas_host: str = "127.0.0.1"
    canvas_port: int = 8000

    auth_mode: Literal["hybrid", "cloudflare", "local"] = "hybrid"
    cf_access_team_domain: str = ""
    cf_access_aud: str = ""
    initial_admin_email: str = ""
    initial_admin_username: str = "admin"
    initial_admin_password: str = ""
    cookie_secure: bool = False
    session_ttl_seconds: int = 7 * 86400

    storage_backend: Literal["local", "gdrive"] = "local"

    default_daily_quota: int = 50
    default_max_queued: int = 2
    max_batch_size: int = 4

    sse_heartbeat_seconds: float = 20.0
    outbox_poll_seconds: float = 5.0

    worker_idle_timeout_seconds: int = 900
    watchdog_idle_timeout_seconds: int = 1200
    watchdog_max_lifetime_seconds: int = 21600
    worker_heartbeat_interval_seconds: float = 60.0
    reconcile_interval_seconds: float = 300.0
    balance_poll_idle_seconds: float = 600.0
    balance_poll_active_seconds: float = 60.0
    allow_a100_fallback: bool = False
    civitai_api_token: str = ""
    colab_assign_retries: int = 4

    workflows_dir: Path = Path("./workflows")
    scripts_dir: Path = Path("./scripts")
    frontend_dist_dir: Path = Path("./frontend/dist")

    @property
    def db_path(self) -> Path:
        return self.canvas_data_dir / "canvas.db"

    @property
    def accounts_dir(self) -> Path:
        return self.canvas_data_dir / "accounts"

    @property
    def ssh_dir(self) -> Path:
        return self.canvas_data_dir / "ssh"

    @property
    def run_dir(self) -> Path:
        return self.canvas_data_dir / "run"

    @property
    def thumbs_dir(self) -> Path:
        return self.canvas_data_dir / "thumbs"

    @property
    def outbox_dir(self) -> Path:
        return self.canvas_data_dir / "outbox"

    @property
    def originals_dir(self) -> Path:
        return self.canvas_data_dir / "originals"

    @property
    def cf_access_configured(self) -> bool:
        return bool(self.cf_access_team_domain.strip() and self.cf_access_aud.strip())

    def ensure_data_dirs(self) -> None:
        self.canvas_data_dir.mkdir(parents=True, exist_ok=True)
        for p in (self.run_dir, self.thumbs_dir, self.outbox_dir, self.originals_dir):
            p.mkdir(parents=True, exist_ok=True)
        for private_dir in (self.accounts_dir, self.ssh_dir):
            private_dir.mkdir(parents=True, exist_ok=True)
            private_dir.chmod(0o700)

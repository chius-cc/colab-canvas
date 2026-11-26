"""FastAPI application factory and lifecycle management."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.admin import router as admin_router
from app.api.auth import router as auth_router
from app.api.events import EventBus
from app.api.events import router as events_router
from app.api.images import router as images_router
from app.api.jobs import router as jobs_router
from app.api.loras import router as loras_router
from app.api.pool import router as pool_router
from app.api.workflows import router as workflows_router
from app.auth.cf_access import CloudflareAccessVerifier
from app.auth.service import ensure_initial_admin
from app.colab.account_pool import AccountPool
from app.colab.gateway import ColabGateway
from app.colab.reconcile import Reconciler
from app.config import Settings
from app.db import Database
from app.security.crypto import SecretBox
from app.storage.gdrive import GoogleDriveStorage
from app.storage.local import LocalStorage
from app.storage.outbox import ImageStoreService, OutboxUploader
from app.worker.manager import WorkerManager
from app.workflows.registry import WorkflowRegistry


def create_app(
    settings: Settings | None = None,
    *,
    cf_verifier: CloudflareAccessVerifier | None = None,
    colab_gateway: ColabGateway | None = None,
    comfy_client_factory: Callable[[str], Any] | None = None,
    tunnel_factory: Callable[..., Any] | None = None,
    start_background_uploader: bool = True,
    start_background_workers: bool = True,
) -> FastAPI:
    cfg = settings or Settings()  # type: ignore[call-arg]

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cfg.ensure_data_dirs()

        db = Database(cfg.db_path)
        await db.connect()
        await ensure_initial_admin(db, cfg)

        crypto = SecretBox(cfg.canvas_secret_key)
        events = EventBus()

        local_storage = LocalStorage(cfg.originals_dir)
        gdrive_storage = GoogleDriveStorage(db, crypto)
        adapters = {
            local_storage.backend_name: local_storage,
            gdrive_storage.backend_name: gdrive_storage,
        }
        image_store = ImageStoreService(
            db=db,
            settings=cfg,
            adapters=adapters,
            default_backend=cfg.storage_backend,
            events=events,
        )
        uploader = OutboxUploader(
            db=db,
            store=image_store,
            events=events,
            poll_seconds=cfg.outbox_poll_seconds,
        )
        workflows = WorkflowRegistry(cfg.workflows_dir)

        gateway = colab_gateway or ColabGateway(
            ssh_dir=cfg.ssh_dir,
            assign_retries=cfg.colab_assign_retries,
        )
        account_pool = AccountPool(
            db=db,
            crypto=crypto,
            gateway=gateway,
            settings=cfg,
            events=events,
        )
        reconciler = Reconciler(
            db=db,
            account_pool=account_pool,
            gateway=gateway,
            events=events,
            idle_timeout_seconds=cfg.worker_idle_timeout_seconds,
        )
        worker_manager = WorkerManager(
            db=db,
            settings=cfg,
            gateway=gateway,
            account_pool=account_pool,
            reconciler=reconciler,
            workflows=workflows,
            image_store=image_store,
            events=events,
            comfy_client_factory=comfy_client_factory,
            tunnel_factory=tunnel_factory,
        )

        active_verifier = cf_verifier
        if active_verifier is None and cfg.cf_access_configured:
            active_verifier = CloudflareAccessVerifier(
                cfg.cf_access_team_domain, cfg.cf_access_aud
            )

        app.state.settings = cfg
        app.state.db = db
        app.state.crypto = crypto
        app.state.events = events
        app.state.storage_adapters = adapters
        app.state.image_store = image_store
        app.state.outbox_uploader = uploader
        app.state.workflows = workflows
        app.state.colab_gateway = gateway
        app.state.account_pool = account_pool
        app.state.reconciler = reconciler
        app.state.worker_manager = worker_manager
        app.state.cf_verifier = active_verifier

        if start_background_uploader:
            uploader.start()
        if start_background_workers:
            worker_manager.start()

        try:
            yield
        finally:
            await events.close()
            await worker_manager.stop()
            await uploader.stop()
            await db.close()

    app = FastAPI(title="colab-canvas", version="0.1.0", lifespan=lifespan)

    @app.get("/api/health", tags=["health"])
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": "0.1.0"}

    app.include_router(auth_router)
    app.include_router(admin_router)
    app.include_router(workflows_router)
    app.include_router(loras_router)
    app.include_router(images_router)
    app.include_router(jobs_router)
    app.include_router(pool_router)
    app.include_router(events_router)

    if cfg.frontend_dist_dir.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=cfg.frontend_dist_dir, html=True),
            name="frontend",
        )

    return app

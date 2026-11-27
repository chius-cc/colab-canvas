"""Tests for AccountPool encryption/isolation, rollover selection, and Reconciler."""

from __future__ import annotations

import json
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from app.colab.gateway import CcuSnapshot, ColabGateway, RemoteAssignment
from app.main import create_app
from tests.conftest import make_test_settings


def _sample_adc(tag: str) -> dict[str, Any]:
    return {
        "type": "authorized_user",
        "client_id": f"cid-{tag}",
        "client_secret": f"csec-{tag}",
        "refresh_token": f"rtoken-{tag}",
    }


class FakePoolGateway(ColabGateway):
    def __init__(self, ssh_dir: Path) -> None:
        super().__init__(ssh_dir=ssh_dir, assign_retries=2)
        self.emails: dict[str, str] = {}
        self.usage_by_token: dict[str, CcuSnapshot] = {}
        self.assignments_by_token: dict[str, list[RemoteAssignment]] = {}
        self.unassigned_endpoints: list[str] = []

    async def verify_adc_credentials(self, adc_json: dict[str, Any]) -> tuple[str, CcuSnapshot]:
        rt = str(adc_json["refresh_token"])
        return self.emails[rt], self.usage_by_token[rt]

    async def get_usage(self, adc_json: dict[str, Any]) -> CcuSnapshot:
        return self.usage_by_token[str(adc_json["refresh_token"])]

    async def list_assignments(self, adc_json: dict[str, Any]) -> list[RemoteAssignment]:
        return list(self.assignments_by_token.get(str(adc_json["refresh_token"]), []))

    async def unassign(self, adc_json: dict[str, Any], endpoint: str) -> None:
        del adc_json
        self.unassigned_endpoints.append(endpoint)


async def test_account_pool_encryption_isolation_and_rollover(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
    )
    gw = FakePoolGateway(ssh_dir=tmp_path / "data" / "ssh")
    gw.emails["rtoken-low"] = "low@example.com"
    gw.usage_by_token["rtoken-low"] = CcuSnapshot(balance_cu=2.5, rate_hr=0.0, assignments_count=0)
    gw.emails["rtoken-rich"] = "rich@example.com"
    gw.usage_by_token["rtoken-rich"] = CcuSnapshot(
        balance_cu=180.0, rate_hr=0.0, assignments_count=0
    )

    app = create_app(
        settings,
        colab_gateway=gw,
        start_background_uploader=False,
        start_background_workers=False,
    )

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )

        # Add low-balance account (priority 1, below min_balance 5.0) and rich account (priority 10)
        r1 = await client.post(
            "/api/pool/accounts",
            json={
                "label": "LowCU",
                "adc_json": _sample_adc("low"),
                "priority": 1,
                "min_balance_cu": 5.0,
            },
        )
        assert r1.status_code == 201
        r2 = await client.post(
            "/api/pool/accounts",
            json={
                "label": "RichCU",
                "adc_json": _sample_adc("rich"),
                "priority": 10,
                "min_balance_cu": 5.0,
            },
        )
        assert r2.status_code == 201
        rich_id = r2.json()["account"]["id"]

        # Secrets never returned in API responses
        list_resp = await client.get("/api/pool/accounts")
        assert list_resp.status_code == 200
        raw_text = list_resp.text
        assert "rtoken-low" not in raw_text
        assert "csec-rich" not in raw_text
        assert "cred_encrypted" not in raw_text

        # Isolated HOME files and 0600 permissions created
        rich_home = settings.accounts_dir / rich_id / "home"
        adc_file = rich_home / "adc.json"
        settings_file = rich_home / ".config" / "colab-cli" / "settings.json"
        assert stat.S_IMODE(adc_file.stat().st_mode) == 0o600
        assert json.loads(settings_file.read_text())["enable_update_check"] is False

        # Verify build_ssh_proxy_command isolates HOME & GOOGLE_APPLICATION_CREDENTIALS
        proxy_cmd, env = gw.build_ssh_proxy_command(
            home_dir=rich_home,
            adc_path=adc_file,
            sessions_path=rich_home / "sessions.json",
            session_name="cc-test",
        )
        assert env["HOME"] == str(rich_home)
        assert env["GOOGLE_APPLICATION_CREDENTIALS"] == str(adc_file)
        assert "--proxy-mode" in proxy_cmd and "--identity" in proxy_cmd

        # LowCU (2.5 < 5.0) must be skipped by rollover candidate selection
        candidates = await app.state.account_pool.select_candidates("L4")
        assert [c["label"] for c in candidates] == ["RichCU"]

        # Member cannot add or delete pool accounts
        inv = (await client.post("/api/admin/invites", json={"max_uses": 1})).json()["invite"][
            "code"
        ]
        await client.post("/api/auth/logout")
        await client.post(
            "/api/auth/register",
            json={
                "invite_code": inv,
                "email": "m@example.com",
                "username": "member",
                "password": "memberpassword123",
            },
        )
        assert (
            await client.post(
                "/api/pool/accounts",
                json={"label": "Nope", "adc_json": _sample_adc("low")},
            )
        ).status_code == 403


async def test_reconciler_preserves_external_sessions_and_cleans_orphans(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
        worker_idle_timeout_seconds=60,
    )
    gw = FakePoolGateway(ssh_dir=tmp_path / "data" / "ssh")
    gw.emails["rtoken-main"] = "main@example.com"
    gw.usage_by_token["rtoken-main"] = CcuSnapshot(
        balance_cu=190.0, rate_hr=1.54, assignments_count=2
    )
    expires = datetime.now(UTC) + timedelta(hours=1)
    gw.assignments_by_token["rtoken-main"] = [
        RemoteAssignment(
            endpoint="ext-manual-nb",
            accelerator="NONE",
            variant="DEFAULT",
            token="t-ext",
            url="https://ext.invalid",
            token_expires_at=expires,
        ),
        RemoteAssignment(
            endpoint="managed-orphan-l4",
            accelerator="L4",
            variant="GPU",
            token="t-orp",
            url="https://orp.invalid",
            token_expires_at=expires,
        ),
    ]

    app = create_app(
        settings,
        colab_gateway=gw,
        start_background_uploader=False,
        start_background_workers=False,
    )

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )
        acc = (
            await client.post(
                "/api/pool/accounts",
                json={"label": "Main", "adc_json": _sample_adc("main")},
            )
        ).json()["account"]

        # Seed a stale unowned managed worker + a vanished managed worker in DB
        stale_ts = (datetime.now(UTC) - timedelta(minutes=10)).isoformat()
        await app.state.db.execute(
            """
            INSERT INTO workers (
                id, account_id, endpoint, session_name, origin, gpu_type,
                status, comfy_port, watchdog_port, cached_files,
                started_at, last_heartbeat_at, last_activity_at, stopped_at
            ) VALUES (
                'w-orphan', ?, 'managed-orphan-l4', 'cc-orp', 'managed', 'L4',
                'ready', 9001, 9002, '[]', ?, ?, ?, NULL
            )
            """,
            (acc["id"], stale_ts, stale_ts, stale_ts),
        )
        await app.state.db.execute(
            """
            INSERT INTO workers (
                id, account_id, endpoint, session_name, origin, gpu_type,
                status, comfy_port, watchdog_port, cached_files,
                started_at, last_heartbeat_at, last_activity_at, stopped_at
            ) VALUES (
                'w-gone', ?, 'managed-gone-l4', 'cc-gone', 'managed', 'L4',
                'ready', 9003, 9004, '[]', ?, ?, ?, NULL
            )
            """,
            (acc["id"], stale_ts, stale_ts, stale_ts),
        )

        summary = await app.state.reconciler.reconcile_once(active_managed_endpoints=set())
        assert summary["stopped_count"] == 1
        assert summary["orphan_cleaned"] == 1
        assert summary["external_discovered"] == 1
        # Only managed-orphan-l4 was unassigned; ext-manual-nb was NEVER touched (Invariant #3)
        assert gw.unassigned_endpoints == ["managed-orphan-l4"]

        workers_resp = await client.get("/api/pool/workers")
        assert workers_resp.status_code == 200
        by_ep = {w["endpoint"]: w for w in workers_resp.json()["workers"]}
        assert by_ep["ext-manual-nb"]["origin"] == "external"
        assert by_ep["ext-manual-nb"]["status"] == "ready"
        assert by_ep["managed-orphan-l4"]["status"] == "stopped"

        # Emergency stop on external worker MUST be forbidden (403)
        ext_id = by_ep["ext-manual-nb"]["id"]
        stop_ext = await client.post(f"/api/pool/workers/{ext_id}/stop")
        assert stop_ext.status_code == 403
        assert gw.unassigned_endpoints == ["managed-orphan-l4"]

        # Members must not see Colab accounts, workers, or admin_only pool SSE events
        inv = (await client.post("/api/admin/invites", json={"max_uses": 1})).json()["invite"][
            "code"
        ]
        await client.post("/api/auth/logout")
        reg = await client.post(
            "/api/auth/register",
            json={
                "invite_code": inv,
                "email": "member@example.com",
                "username": "member",
                "password": "memberpassword123",
            },
        )
        assert reg.status_code == 201
        assert (await client.get("/api/pool/accounts")).status_code == 403
        assert (await client.get("/api/pool/workers")).status_code == 403

        member_id = reg.json()["user"]["id"]
        from app.auth.service import UserRecord

        member_rec = UserRecord(
            id=member_id,
            email="member@example.com",
            username="member",
            role="member",
            daily_quota=50,
            max_queued=2,
            allowed_gpus=("L4",),
            created_at="",
        )
        ev_id_admin = await app.state.events.publish(
            "worker.updated", {"worker_id": "w1", "status": "ready"}, admin_only=True
        )
        ev_id_public = await app.state.events.publish(
            "image.created", {"image_id": "img-1"}, user_id=member_id
        )
        chunks: list[str] = []
        sub = app.state.events.subscribe(
            member_rec, last_event_id=ev_id_admin - 1, heartbeat_seconds=0.05, max_events=1
        )
        async for ch in sub:
            chunks.append(ch)
        assert len(chunks) == 1
        assert f"id: {ev_id_public}" in chunks[0]
        assert "worker.updated" not in chunks[0]

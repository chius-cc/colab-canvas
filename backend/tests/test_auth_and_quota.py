"""Tests for local auth, invite codes, Cloudflare Access JWT, and QuotaService."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from app.auth.cf_access import CloudflareAccessVerifier
from app.auth.service import QuotaService, get_user_by_id, utc_now_iso
from app.main import create_app
from tests.conftest import make_test_settings


async def test_setup_login_invite_and_admin_flows(tmp_path) -> None:
    settings = make_test_settings(tmp_path, auth_mode="hybrid")
    app = create_app(settings, start_background_uploader=False)

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        assert (await client.get("/api/health")).json()["status"] == "ok"
        assert (await client.get("/api/auth/status")).json() == {
            "auth_mode": "hybrid",
            "needs_setup": True,
        }

        # Setup first admin
        r = await client.post(
            "/api/auth/setup",
            json={
                "email": "admin@example.com",
                "username": "boss",
                "password": "strongpassword123",
            },
        )
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "admin"

        # Second setup blocked
        r2 = await client.post(
            "/api/auth/setup",
            json={
                "email": "other@example.com",
                "username": "other",
                "password": "strongpassword123",
            },
        )
        assert r2.status_code == 409

        # Create single-use invite code
        inv = await client.post("/api/admin/invites", json={"max_uses": 1})
        assert inv.status_code == 201
        code = inv.json()["invite"]["code"]

        # Logout and login with username + wrong password
        await client.post("/api/auth/logout")
        assert (await client.get("/api/auth/me")).status_code == 401

        bad = await client.post(
            "/api/auth/login",
            json={"identifier": "boss", "password": "wrong-password"},
        )
        assert bad.status_code == 401

        ok = await client.post(
            "/api/auth/login",
            json={"identifier": "boss", "password": "strongpassword123"},
        )
        assert ok.status_code == 200

        # Also create a disabled invite and an expired invite directly
        await app.state.db.execute(
            """
            INSERT INTO invite_codes (
                code, created_by, max_uses, used_count, expires_at, disabled, created_at
            )
            VALUES (?, ?, 1, 0, ?, 0, ?)
            """,
            (
                "expired-code",
                ok.json()["user"]["id"],
                (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
                utc_now_iso(),
            ),
        )

        # Register member using valid invite code
        await client.post("/api/auth/logout")
        reg = await client.post(
            "/api/auth/register",
            json={
                "invite_code": code,
                "email": "friend@example.com",
                "username": "friend",
                "password": "friendpassword123",
            },
        )
        assert reg.status_code == 201
        assert reg.json()["user"]["role"] == "member"
        assert reg.json()["user"]["allowed_gpus"] == ["L4"]

        # Exhausted invite rejected
        await client.post("/api/auth/logout")
        reg_dup = await client.post(
            "/api/auth/register",
            json={
                "invite_code": code,
                "email": "friend2@example.com",
                "username": "friend2",
                "password": "friendpassword123",
            },
        )
        assert reg_dup.status_code == 400

        # Expired invite rejected
        reg_exp = await client.post(
            "/api/auth/register",
            json={
                "invite_code": "expired-code",
                "email": "friend3@example.com",
                "username": "friend3",
                "password": "friendpassword123",
            },
        )
        assert reg_exp.status_code == 400

        # Member cannot call admin endpoints
        await client.post(
            "/api/auth/login",
            json={"identifier": "friend@example.com", "password": "friendpassword123"},
        )
        assert (await client.post("/api/admin/invites", json={"max_uses": 1})).status_code == 403


async def test_cloudflare_access_jwt_verification_and_spoof_rejection(tmp_path) -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    verifier = CloudflareAccessVerifier(
        "team.cloudflareaccess.com",
        "test-aud-123",
        signing_key_getter=lambda _tok: public_key,
    )
    settings = make_test_settings(
        tmp_path,
        auth_mode="cloudflare",
        cf_access_team_domain="team.cloudflareaccess.com",
        cf_access_aud="test-aud-123",
    )
    app = create_app(settings, cf_verifier=verifier, start_background_uploader=False)

    now = datetime.now(UTC)
    valid_jwt = jwt.encode(
        {
            "email": "alice@example.com",
            "aud": ["test-aud-123"],
            "iss": "https://team.cloudflareaccess.com",
            "exp": now + timedelta(minutes=10),
        },
        private_key,
        algorithm="RS256",
    )
    wrong_aud_jwt = jwt.encode(
        {
            "email": "alice@example.com",
            "aud": ["other-aud"],
            "iss": "https://team.cloudflareaccess.com",
            "exp": now + timedelta(minutes=10),
        },
        private_key,
        algorithm="RS256",
    )
    forged_jwt = jwt.encode(
        {
            "email": "evil@example.com",
            "aud": ["test-aud-123"],
            "iss": "https://team.cloudflareaccess.com",
            "exp": now + timedelta(minutes=10),
        },
        wrong_key,
        algorithm="RS256",
    )

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        # Spoofed email header without JWT must be rejected
        spoof = await client.get(
            "/api/auth/me",
            headers={"Cf-Access-Authenticated-User-Email": "admin@example.com"},
        )
        assert spoof.status_code == 401

        # Wrong audience and forged signature rejected
        assert (
            await client.get("/api/auth/me", headers={"Cf-Access-Jwt-Assertion": wrong_aud_jwt})
        ).status_code == 401
        assert (
            await client.get("/api/auth/me", headers={"Cf-Access-Jwt-Assertion": forged_jwt})
        ).status_code == 401

        # Valid JWT auto-provisions first user as admin
        ok = await client.get(
            "/api/auth/me",
            headers={"Cf-Access-Jwt-Assertion": valid_jwt},
        )
        assert ok.status_code == 200
        assert ok.json()["user"]["email"] == "alice@example.com"
        assert ok.json()["user"]["role"] == "admin"


async def test_quota_and_gpu_invariants(tmp_path) -> None:
    settings = make_test_settings(
        tmp_path,
        auth_mode="local",
        initial_admin_email="admin@example.com",
        initial_admin_password="adminpassword123",
    )
    app = create_app(settings, start_background_uploader=False)

    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client,
    ):
        login_resp = await client.post(
            "/api/auth/login",
            json={"identifier": "admin@example.com", "password": "adminpassword123"},
        )
        admin_id = login_resp.json()["user"]["id"]

        # Create a member user directly
        member_id = str(uuid.uuid4())
        await app.state.db.execute(
            """
            INSERT INTO users (
                id, email, username, password_hash, role,
                daily_quota, max_queued, allowed_gpus, created_at
            )
            VALUES (?, 'm@example.com', 'member1', 'hash', 'member', 3, 2, '["L4"]', ?)
            """,
            (member_id, utc_now_iso()),
        )

        # Admin API rejects T4 GPU assignment (Invariant #8)
        patch_t4 = await client.patch(
            f"/api/admin/users/{member_id}",
            json={"allowed_gpus": ["L4", "T4"]},
        )
        assert patch_t4.status_code == 400

        member = await get_user_by_id(app.state.db, member_id)
        assert member is not None

        # Passes within limits
        await QuotaService.check_can_submit(
            app.state.db, settings, member, batch_size=2, gpu_type="L4"
        )

        # Rejects T4, unpermitted A100, and batch_size > 4
        with pytest.raises(HTTPException) as exc_t4:
            await QuotaService.check_can_submit(
                app.state.db, settings, member, batch_size=1, gpu_type="T4"
            )
        assert exc_t4.value.status_code == 400

        with pytest.raises(HTTPException) as exc_a100:
            await QuotaService.check_can_submit(
                app.state.db, settings, member, batch_size=1, gpu_type="A100"
            )
        assert exc_a100.value.status_code == 403

        with pytest.raises(HTTPException) as exc_batch:
            await QuotaService.check_can_submit(
                app.state.db, settings, member, batch_size=5, gpu_type="L4"
            )
        assert exc_batch.value.status_code == 400

        # Exceeding daily quota (3) rejects batch_size=2 after 2 images exist today
        for _ in range(2):
            await app.state.db.execute(
                """
                INSERT INTO images (
                    id, job_id, user_id, workflow_id, variant, thumb_path, outbox_path,
                    upload_state, storage_backend, width, height, seed, meta_json, created_at
                ) VALUES (
                    ?, NULL, ?, 'anima', 'turbo', 't.webp', NULL,
                    'uploaded', 'local', 1024, 1024, 1, '{}', ?
                )
                """,
                (str(uuid.uuid4()), member_id, utc_now_iso()),
            )
        with pytest.raises(HTTPException) as exc_daily:
            await QuotaService.check_can_submit(
                app.state.db, settings, member, batch_size=2, gpu_type="L4"
            )
        assert exc_daily.value.status_code == 429

        # Exceeding max_queued (2) rejects new job
        for _ in range(2):
            await app.state.db.execute(
                """
                INSERT INTO jobs (
                    id, user_id, worker_id, workflow_id, variant, params_json, status, created_at
                )
                VALUES (?, ?, NULL, 'anima', 'turbo', '{}', 'queued', ?)
                """,
                (str(uuid.uuid4()), member_id, utc_now_iso()),
            )
        admin = await get_user_by_id(app.state.db, admin_id)
        assert admin is not None
        with pytest.raises(HTTPException) as exc_q:
            await QuotaService.check_can_submit(
                app.state.db, settings, member, batch_size=1, gpu_type="L4"
            )
        assert exc_q.value.status_code == 429
        assert json.loads(json.dumps(admin.allowed_gpus)) == ["L4", "A100", "G4"]

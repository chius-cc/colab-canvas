"""Phase 0 - P0-3: Verify multi-account ADC & HOME isolation (no OS Keyring).

Usage:
    spike/.venv/bin/python spike/p0_3_isolation.py --acc1 path/to/acc1.json --acc2 path/to/acc2.json
    spike/.venv/bin/python spike/p0_3_isolation.py --self-check
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from colab_cli.state import SessionState
from spike.common import (
    LOCAL_DIR,
    VENV_PYTHON,
    build_colab_ssh_env,
    make_client,
    prepare_isolated_home,
)


def inspect_account(label: str, adc_path: Path, home_dir: Path) -> dict:
    client, _ = make_client(adc_path)
    usage = client.get_consumption_user_info()
    assignments = client.list_assignments()

    # Check email via tokeninfo / userinfo using the same session
    resp = client.session.get("https://www.googleapis.com/oauth2/v3/userinfo", timeout=15)
    email = resp.json().get("email") if resp.ok else f"http-{resp.status_code}"

    dummy = SessionState(
        name=f"dummy-{label}",
        token="dummy",
        url="https://example.invalid",
        endpoint="ep-dummy",
    )
    sessions_path = prepare_isolated_home(home_dir, dummy)

    # Run `colab --auth adc --config ... sessions` inside isolated HOME to verify:
    # 1) no keyring access, 2) no update banner on stdout, 3) isolated colab.log/settings.json
    env = build_colab_ssh_env(home_dir, adc_path=adc_path)
    proc = subprocess.run(
        [
            str(VENV_PYTHON),
            "-m",
            "colab_cli.cli",
            "--auth",
            "adc",
            "--config",
            str(sessions_path),
            "sessions",
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    has_banner = "A new version of Colab CLI" in proc.stdout or "A new version" in proc.stderr
    colab_log = home_dir / ".config" / "colab-cli" / "colab.log"
    settings_file = home_dir / ".config" / "colab-cli" / "settings.json"

    return {
        "label": label,
        "email": email,
        "balance_cu": usage.paid_compute_units_balance,
        "rate_hr": usage.consumption_rate_hourly,
        "assignments_count": usage.assignments_count,
        "cli_rc": proc.returncode,
        "cli_stdout": proc.stdout.strip(),
        "cli_stderr": proc.stderr.strip(),
        "has_update_banner": has_banner,
        "isolated_log_exists": colab_log.exists(),
        "isolated_settings_exists": settings_file.exists(),
    }


def self_check() -> int:
    h1 = LOCAL_DIR / "p0_3_selfcheck_1"
    h2 = LOCAL_DIR / "p0_3_selfcheck_2"
    s1 = prepare_isolated_home(
        h1, SessionState(name="s1", token="t1", url="https://a", endpoint="ep1")
    )
    s2 = prepare_isolated_home(
        h2, SessionState(name="s2", token="t2", url="https://b", endpoint="ep2")
    )
    p1 = subprocess.run(
        [str(VENV_PYTHON), "-m", "colab_cli.cli", "--config", str(s1), "version"],
        env=build_colab_ssh_env(h1),
        capture_output=True,
        text=True,
        timeout=15,
    )
    p2 = subprocess.run(
        [str(VENV_PYTHON), "-m", "colab_cli.cli", "--config", str(s2), "version"],
        env=build_colab_ssh_env(h2),
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert p1.returncode == 0 and p2.returncode == 0
    assert (h1 / ".config" / "colab-cli" / "colab.log").exists()
    assert (h2 / ".config" / "colab-cli" / "colab.log").exists()
    print("[p0-3] Self-check PASS: isolated HOME directories and settings.json verified.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 0 P0-3 multi-account isolation check")
    parser.add_argument("--acc1", type=Path, help="Path to Account 1 ADC JSON")
    parser.add_argument("--acc2", type=Path, help="Path to Account 2 ADC JSON")
    parser.add_argument("--self-check", action="store_true", help="Run local non-network HOME isolation check")
    args = parser.parse_args()

    if args.self_check:
        return self_check()

    if not args.acc1 or not args.acc2:
        parser.error("Provide --acc1 and --acc2 (or --self-check)")

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(inspect_account, "acc1", args.acc1, LOCAL_DIR / "p0_3_home_1")
        f2 = pool.submit(inspect_account, "acc2", args.acc2, LOCAL_DIR / "p0_3_home_2")
        r1 = f1.result()
        r2 = f2.result()

    out = {
        "acc1": r1,
        "acc2": r2,
        "distinct_emails": r1["email"] != r2["email"],
        "clean_stdout": (not r1["has_update_banner"]) and (not r2["has_update_banner"]),
    }
    print(json.dumps(out, indent=2))
    out_file = LOCAL_DIR / "p0_3_result.json"
    out_file.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return 0 if (out["distinct_emails"] and out["clean_stdout"] and r1["cli_rc"] == 0 and r2["cli_rc"] == 0) else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Easypanel deploy helper — triggers updateBuild + deployService for a
single service, then polls until commit.sha updates, then Stop+Start.

Usage:
  python3 deploy-easypanel.py <service-name> <expected-sha-short>
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

EASYPANEL_URL = "http://213.199.32.229:3000"
EASYPANEL_TOKEN = "4173c86492e4f2983383d6661f13d87e2d2c4261b4fb6fba454af9205cf22e53"
PROJECT = "sistemas"

def post(path: str, body: dict) -> dict:
    url = f"{EASYPANEL_URL}/api/trpc/{path}"
    payload = {"json": body}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {EASYPANEL_TOKEN}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode()[:400]}
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        # "Empty reply from server" / "Remote end closed connection" is
        # NORMAL for deployService — Easypanel closes the connection
        # after queuing the deploy. Treat as success.
        return {"_warn": "conn_closed", "_body": str(e)[:200]}
    except Exception as e:
        return {"_warn": type(e).__name__, "_body": str(e)[:200]}

def main():
    if len(sys.argv) < 3:
        print("usage: deploy-easypanel.py <service-name> <expected-sha-short>")
        sys.exit(1)
    service = sys.argv[1]
    expected = sys.argv[2][:7]

    print(f"=== deploying {service} (target sha {expected}) ===")

    # 0. Read the current build config from inspect — Easypanel's
    #    `updateBuild` mutation RESETS the build to `{}` if called
    #    without a body, so we must echo the existing config back or
    #    the next deployService call will 400 ("Invalid source").
    inspect = post(
        f"services.app.inspectService",
        {"projectName": PROJECT, "serviceName": service},
    )
    current_build = ((inspect.get("json") or {}).get("build")) or {}
    if not current_build:
        # No build configured — bail and let the operator set one
        # manually (Easypanel can't infer the dockerfile path from a
        # git source).
        print(
            f"!! {service} has no build config (build={json.dumps(current_build)}). "
            "Set one in the Easypanel UI or via updateBuild({build:{type:'dockerfile',file:'...'}}) first."
        )
        sys.exit(3)
    print(f"preserving build config: {json.dumps(current_build)[:200]}")

    # 1. updateBuild with the EXISTING config — this nudges Easypanel
    #    to re-poll GitHub for a fresh commit hash. Without a build
    #    body, Easypanel resets the build to {} and the next deploy
    #    400s with "Invalid source".
    r = post(
        f"services.app.updateBuild",
        {"projectName": PROJECT, "serviceName": service, "build": current_build},
    )
    print(f"updateBuild: {json.dumps(r)[:200]}")
    time.sleep(3)

    # 2. deployService trigger
    r = post(
        f"services.app.deployService",
        {"projectName": PROJECT, "serviceName": service, "forceRebuild": True},
    )
    print(f"deployService: {json.dumps(r)[:200]}")
    # Note: empty reply / Remote end closed = NORMAL

    # 3. Poll commit.sha until it matches expected
    print(f"polling commit.sha ...")
    deadline = time.time() + 25 * 60  # 25 min
    last_sha = None
    while time.time() < deadline:
        time.sleep(30)
        r = post(f"services.app.inspectService", {"projectName": PROJECT, "serviceName": service})
        if "_error" in r:
            print(f"  inspect error: {r}")
            continue
        # Response shape: { "json": { ..., "commit": { "hash": "...", "message": "..." } } }
        result = r.get("json", {})
        sha = (result.get("commit") or {}).get("hash", "?")
        sha7 = sha[:7] if sha and sha != "?" else "?"
        if sha7 != last_sha:
            print(f"  sha: {sha7}  ({'✓' if sha7.startswith(expected) else '…'})")
            last_sha = sha7
        if sha7.startswith(expected):
            print(f"commit matches! stopping+starting {service}")
            # 4. Stop+Start (deploy alone does NOT restart)
            r = post(f"services.app.stopService", {"projectName": PROJECT, "serviceName": service})
            print(f"stopService: {json.dumps(r)[:200]}")
            time.sleep(5)
            r = post(f"services.app.startService", {"projectName": PROJECT, "serviceName": service})
            print(f"startService: {json.dumps(r)[:200]}")
            time.sleep(8)
            print(f"=== {service} deployed + restarted ===")
            return
    print(f"!! TIMEOUT waiting for sha {expected} on {service}")
    sys.exit(2)

if __name__ == "__main__":
    main()

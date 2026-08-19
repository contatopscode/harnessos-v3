#!/usr/bin/env python3
"""VOLUND FORGE PR1 deploy automation.

Pattern (proven from prior RBAC deploys):
  1. disableGithubDeploy  +  enableGithubDeploy  → forces Easypanel to re-poll GitHub
  2. deployService (forceRebuild=true)          → triggers the rebuild
     NB: the response closes the connection prematurely ("Remote end closed
     connection" is NORMAL — do not retry)
  3. Poll inspectService every 30s for up to 25 min
  4. stopService + startService                 → restart container
     (updateEnv + deployService does NOT restart the container)
  5. /health/db + /api/health                   → final smoke check
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

EASYPANEL_URL = "http://213.199.32.229:3000"
PROJECT = "sistemas"
SERVICE = "harnessos-v2"
TARGET_COMMIT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TARGET_COMMIT", "")
DEPLOY_ENV = Path("/Users/paulosiqueira/Documents/PS-Code/Projetos/SistemasAgenticos/Archon/deploy.env")
TOKEN = next(
    (line.strip().split("=", 1)[1] for line in DEPLOY_ENV.read_text().splitlines() if line.startswith("EASYPANEL_TOKEN=")),
    "",
)


def trpc_call(procedure: str, payload: dict, method: str = "POST", timeout: int = 30) -> dict:
    url = f"{EASYPANEL_URL}/api/trpc/{procedure}"
    data = json.dumps({"json": payload}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "harnessos-deploy/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"error": f"HTTP {e.code}: {body[:200]}"}
    except Exception as e:
        return {"error": str(e)}


def inspect() -> dict:
    r = trpc_call("services.app.inspectService", {"projectName": PROJECT, "serviceName": SERVICE})
    return r.get("json", r)


def commit_sha() -> str:
    info = inspect()
    if "error" in info:
        return f"ERROR:{info['error']}"
    return info.get("commit", {}).get("sha", "?")[:7]


def main() -> int:
    if not TARGET_COMMIT:
        print("USAGE: deploy-forge-pr1.py <target-commit-sha>", file=sys.stderr)
        return 1
    target_short = TARGET_COMMIT[:7]
    print(f"==> target commit: {target_short}")

    print("==> step 1: force Easypanel to re-poll GitHub (disable + enable)")
    r1 = trpc_call("services.app.disableGithubDeploy", {"projectName": PROJECT, "serviceName": SERVICE})
    print("    disable:", r1)
    r2 = trpc_call("services.app.enableGithubDeploy", {"projectName": PROJECT, "serviceName": SERVICE})
    print("    enable:", r2)

    print("==> step 2: deployService (forceRebuild=true) — connection may close early, NORMAL")
    r3 = trpc_call(
        "services.app.deployService",
        {"projectName": PROJECT, "serviceName": SERVICE, "forceRebuild": True},
        timeout=10,
    )
    print("    deploy:", r3)

    print("==> step 3: poll commit every 30s, max 25 min")
    deadline = time.time() + 25 * 60
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        sha = commit_sha()
        elapsed_min = (time.time() - (deadline - 25 * 60)) / 60
        print(f"    [{attempt:02d}] {elapsed_min:5.1f}min  sha={sha}")
        if sha.startswith(target_short):
            print(f"    ✓ commit {target_short} is live")
            break
        time.sleep(30)
    else:
        print(f"    ✗ TIMEOUT — last sha={sha}")
        return 2

    print("==> step 4: stopService + startService (restart with new build)")
    r4 = trpc_call("services.app.stopService", {"projectName": PROJECT, "serviceName": SERVICE})
    print("    stop:", r4)
    time.sleep(5)
    r5 = trpc_call("services.app.startService", {"projectName": PROJECT, "serviceName": SERVICE})
    print("    start:", r5)

    print("==> step 5: health check")
    time.sleep(15)  # give it time to boot
    for url in [
        "https://harness-os.pscode.ia.br/api/health",
        "https://harness-os.pscode.ia.br/api/health/db",
    ]:
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                print(f"    {url} → {resp.status} {resp.read().decode()[:200]}")
        except Exception as e:
            print(f"    {url} → ERROR {e}")

    print("==> step 6: smoke-test FORGE endpoints (auth gate should respond)")
    for path in ["/api/forge/clients", "/api/forge/demands/board", "/api/forge/costs/summary", "/api/forge/projects"]:
        url = f"https://harness-os.pscode.ia.br{path}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "deploy-smoke/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8", errors="replace")[:150]
                print(f"    {path} → {resp.status} {body}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:150]
            print(f"    {path} → {e.code} {body}")
        except Exception as e:
            print(f"    {path} → ERROR {e}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

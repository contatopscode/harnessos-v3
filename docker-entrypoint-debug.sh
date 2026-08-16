#!/bin/bash
# TEMP DEBUG WRAPPER — runs the real docker-entrypoint.sh, but if it
# crashes BEFORE reaching `exec bun run start`, holds the container
# alive for 1h so Easypanel's runtime log has time to flush and we
# can see the actual error. Reverts to docker-entrypoint.sh once the
# deploy is green.
set -xe
echo "=== HARNESSOS DEBUG WRAPPER $(date -u +%FT%TZ) ==="
echo "id=$(id 2>&1)"
echo "uname -m=$(uname -m)"

# Run the real entrypoint. If it succeeds, it `exec`s bun and we never
# return. If it fails before exec, we fall through to the sleep.
if /usr/local/bin/docker-entrypoint.sh "$@"; then
  # never reached if entrypoint exec's bun successfully
  exit 0
else
  EXIT=$?
  echo ""
  echo "================================================================"
  echo "ENTRYPOINT FAILED with exit code ${EXIT} — sleeping 1h to"
  echo "preserve the runtime log so we can diagnose."
  echo "================================================================"
  sleep 3600
  exit "${EXIT}"
fi

#!/bin/bash
# TEMP DEBUG WRAPPER (minimal v3) — survives Easypanel log pipeline
# being broken by writing to /tmp/harnessos.log AND stdout, never
# killing the container on entrypoint crash, and dumping state into
# a file the operator can cat from the host volume.
#
# Reverts to ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"] once
# the deploy is green.

LOG=/tmp/harnessos.log
: > "$LOG"

# Duplicate everything to both stdout (for Easypanel) and the log file
# (so we have a paper trail even if Easypanel's pipeline is the issue).
exec > >(tee -a "$LOG") 2>&1

set -u
echo "=== HARNESSOS DEBUG WRAPPER v3 $(date -u +%FT%TZ) ==="
echo "id=$(id 2>&1)"
echo "uname=$(uname -a 2>&1)"
echo "which bun=$(which bun 2>&1)"
echo "bun --version: $(bun --version 2>&1 || echo MISSING)"
echo ""
echo "--- /app/.archon (top-level + 1 level) ---"
ls -la /app/.archon 2>&1
echo ""
echo "--- /.archon (where data volumes mount) ---"
ls -la /.archon 2>&1
echo ""
echo "--- /app/.claude/skills/archon/ ---"
ls -la /app/.claude/skills/archon/ 2>&1
echo ""
echo "--- /app/.claude/skills/manage-run/ ---"
ls -la /app/.claude/skills/manage-run/ 2>&1
echo ""
echo "--- /app/packages/core/src/skills/ ---"
ls -la /app/packages/core/src/skills/ 2>&1
echo ""
echo "--- df -h ---"
df -h 2>&1
echo ""
echo "--- env (filtered, redacted) ---"
env | grep -E "DATABASE_URL|MINIMAX|DEFAULT_AI|PORT=|HOSTNAME|NODE_ENV|LOG_LEVEL|ARCHON_" | sed -E 's/(KEY|PASSWORD|TOKEN|URL)=.{0,8}/\1=...REDACTED.../I' 2>&1
echo ""

# Run the real entrypoint in the background. Whatever happens to it,
# we keep the container alive and tail our log to stdout for 1h.
echo "--- launching /usr/local/bin/docker-entrypoint.sh ---"
/usr/local/bin/docker-entrypoint.sh "$@" &
REAL_PID=$!
echo "real entrypoint PID=${REAL_PID}"

# Watch it for up to 15s; if it dies, dump its exit code.
for i in $(seq 1 15); do
  sleep 1
  if ! kill -0 "$REAL_PID" 2>/dev/null; then
    wait "$REAL_PID"
    RC=$?
    echo ""
    echo "================================================================"
    echo "REAL ENTRYPOINT DIED after ${i}s with exit code ${RC}"
    echo "================================================================"
    break
  fi
done

# If still alive, that's a good sign — the bun server is running.
# Keep the container alive and tail the log so Easypanel sees output.
if kill -0 "$REAL_PID" 2>/dev/null; then
  echo "--- real entrypoint still alive after 15s; tailing log for 1h ---"
  timeout 3600 tail -n +1 -f "$LOG"
  echo "--- 1h tail window done ---"
  wait "$REAL_PID"
  echo "real entrypoint exited with $?"
else
  echo "--- holding container alive for 1h so /tmp/harnessos.log can be inspected ---"
  sleep 3600
fi

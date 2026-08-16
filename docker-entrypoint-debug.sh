#!/bin/bash
# TEMPORARY DEBUG ENTRYPOINT — replaced by docker-entrypoint.sh once the
# runtime log renders. Paulo reports the Easypanel log panel is empty,
# which usually means the container is crash-looping too fast for any
# stdout to flush. This minimal entrypoint just prints markers and
# sleeps for an hour so the log gets something to display.
set -x
echo "=== HARNESSOS DEBUG ENTRYPOINT $(date -u +%FT%TZ) ==="
echo "id=$(id 2>&1)"
echo "uname=$(uname -a)"
echo "ls -la /app/.claude/skills/archon/ (head -10):"
ls -la /app/.claude/skills/archon/ 2>&1 | head -10
echo "ls -la /app/.claude/skills/manage-run/:"
ls -la /app/.claude/skills/manage-run/ 2>&1 | head -10
echo "ls -la /app/packages/core/src/skills/:"
ls -la /app/packages/core/src/skills/ 2>&1
echo "which bun: $(which bun 2>&1)"
echo "bun --version: $(bun --version 2>&1)"
echo "ls -la /app/.archon:"
ls -la /app/.archon 2>&1 | head -10
echo "env vars related to db/minimax:"
env | grep -E "DATABASE_URL|MINIMAX|DEFAULT_AI|PORT=" | sed -E 's/(=.{0,4}).*/\1...REDACTED.../' 2>&1
echo "=== END DEBUG — sleeping for 1h so log can flush ==="
sleep 3600

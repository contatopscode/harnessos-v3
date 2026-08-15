#!/usr/bin/env bash
# =============================================================================
# HarnessOS — Postgres migration runner (Aug 2026)
# =============================================================================
#
# Applies deploy/postgres/harnessos-postgres-init.sql to a database using
# psql. Idempotent: safe to re-run. Exits non-zero on any SQL error.
#
# Usage:
#   DB_HOST=213.199.32.229 \
#   DB_PORT=5433 \
#   DB_USER=archon \
#   DB_NAME=harnessos \
#   DB_PASS=... \
#     ./deploy/postgres/migrate.sh
#
# Or with the .env.production file:
#   set -a; source .env.production; set +a
#   ./deploy/postgres/migrate.sh
#
# Requires: psql on PATH. On the Contabo VPS:
#   apt-get install -y postgresql-client
# =============================================================================

set -euo pipefail

: "${DB_HOST:?Set DB_HOST (e.g. 213.199.32.229)}"
: "${DB_PORT:=5432}"
: "${DB_USER:?Set DB_USER (e.g. archon)}"
: "${DB_NAME:?Set DB_NAME (e.g. harnessos)}"
: "${DB_PASS:?Set DB_PASS (or set PGPASSWORD env var directly)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/harnessos-postgres-init.sql"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "ERROR: $SQL_FILE not found" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not on PATH. apt-get install postgresql-client" >&2
  exit 1
fi

echo "[harnessos-migrate] target = $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
echo "[harnessos-migrate] sql    = $SQL_FILE"
echo "[harnessos-migrate] applying (idempotent — safe to re-run)…"

export PGPASSWORD="$DB_PASS"
psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -v VERBOSITY=verbose \
  -f "$SQL_FILE" \
  --single-transaction \
  --quiet

echo "[harnessos-migrate] done."
echo ""
echo "Verifying expected tables (should print 27 rows)…"
psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -tA \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'remote_agent%' ORDER BY table_name"

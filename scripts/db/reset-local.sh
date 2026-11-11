#!/usr/bin/env bash
# Recreate the local test database from scratch: Supabase shim + all
# migrations (+ optional dev seed). Never point this at a real project.
set -euo pipefail
cd "$(dirname "$0")/../.."
PGHOST="${PGHOST:-/tmp}"; PGPORT="${PGPORT:-54322}"; PGUSER="${PGUSER:-postgres}"
DB="${LOCAL_DB_NAME:-crm_test}"
export PGHOST PGPORT PGUSER
export PGCLIENTENCODING=UTF8  # SQL files are UTF-8 (Windows psql defaults to WIN1252)
case "$PGHOST" in /tmp|localhost|127.0.0.1) ;; *) echo "Refusing: PGHOST=$PGHOST is not local" >&2; exit 1;; esac
psql -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/shim/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" || { echo "FAILED: $f" >&2; exit 1; }
done
# Optional, for SCRATCH testing only: reviewed-but-not-approved migrations (supabase/migrations/*) applied on top of the committed ones, e.g.
#   EXTRA_SQL="supabase/migrations/20261104000970_kapso_production.sql" bash scripts/db/reset-local.sh
for f in ${EXTRA_SQL:-}; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" || { echo "FAILED (extra): $f" >&2; exit 1; }
done
if [ "${1:-}" = "--seed" ]; then
  # Explicit opt-in flags; the seed refuses to run without them.
  PGOPTIONS="-c app.allow_dev_seed=on -c app.seed_create_auth_users=on" \
    psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/seed/dev_seed.sql
fi
echo "Local database '$DB' ready."

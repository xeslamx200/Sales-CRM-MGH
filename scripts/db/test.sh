#!/usr/bin/env bash
# Database test suite: rebuilds the local test DB, loads helpers + fixtures,
# then runs every supabase/tests/db/[0-9]*.sql file in its own transaction
# (each file ends with ROLLBACK, so files cannot affect each other).
set -uo pipefail
cd "$(dirname "$0")/../.."
export PGHOST="${PGHOST:-/tmp}" PGPORT="${PGPORT:-54322}" PGUSER="${PGUSER:-postgres}"
export PGCLIENTENCODING=UTF8  # SQL files are UTF-8 (Windows psql defaults to WIN1252)
DB="${LOCAL_DB_NAME:-crm_test}"
bash ./scripts/db/reset-local.sh >/dev/null || exit 1
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/db/_helpers.sql -f supabase/tests/db/_fixtures.sql >/dev/null || exit 1

pass=0; fail=0; checks=0; failed_files=()
for f in supabase/tests/db/[0-9]*.sql; do
  [ -n "${1:-}" ] && [[ "$f" != *"$1"* ]] && continue
  out=$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1)
  rc=$?
  n=$(grep -c "NOTICE:  ok - " <<<"$out")
  checks=$((checks + n))
  if [ $rc -eq 0 ]; then
    pass=$((pass + 1)); echo "PASS  $f ($n checks)"
  else
    fail=$((fail + 1)); failed_files+=("$f")
    echo "FAIL  $f ($n checks passed before failure)"
    grep -E "ERROR|FAIL" <<<"$out" | head -5 | sed 's/^/      /'
  fi
  [ -n "${VERBOSE:-}" ] && grep "ok - " <<<"$out" | sed 's/.*ok - /      ok - /'
done
echo "----"
echo "files: $pass passed, $fail failed; checks passed: $checks"
[ $fail -eq 0 ]

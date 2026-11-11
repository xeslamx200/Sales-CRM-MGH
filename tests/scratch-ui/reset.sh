#!/usr/bin/env bash
# SCRATCH-ONLY: rebuild the disposable UI database (copy of the fixture DB + migration 986 + seed) and restart the disposable PostgREST container.
set -euo pipefail
export MSYS_NO_PATHCONV=1
PG=${PG_CONTAINER:-kapso-rev6-scratch-pg}; DB=${UI_DB:-kapso_ui_scratch}; TEMPLATE=${TEMPLATE_DB:-kapso_p31_full_scratch}
cd "$(dirname "$0")/../.."
docker exec "$PG" psql -U postgres -qc "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB'" >/dev/null 2>&1 || true
docker exec "$PG" psql -U postgres -qc "drop database if exists $DB" -c "create database $DB template $TEMPLATE" >/dev/null 2>&1
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" < supabase/proposed/20261104000986_booking_discount_approval.sql
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" < supabase/proposed/20261104000987_target_currency.sql
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" < supabase/proposed/20261104000988_employee_shifts.sql
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" < supabase/proposed/20261104000989_employee_daily_report.sql
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" < supabase/proposed/20261104000990_workshop_dashboard.sql
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" < supabase/proposed/20261104000991_company_ui_settings.sql
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" < supabase/proposed/20261104000992_company_branding.sql
for m in 20261104000993_kapso_bsuid_text_send 20261104000994_response_speed_indexed 20261104000995_report_turns_indexed 20261104000996_dashboard_widgets; do
  docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" < "supabase/proposed/$m.sql"
done
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q -At -d "$DB" < tests/scratch-ui/seed.sql >/dev/null
docker restart kapso-ui-postgrest >/dev/null 2>&1 || true
sleep 3
echo "ui scratch db reset"

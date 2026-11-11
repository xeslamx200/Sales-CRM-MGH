#!/usr/bin/env bash
# Proof that migration 0960 and its rollback are safe, on scratch databases of a LOCAL Postgres
# (never a hosted project): schema and data checksums with Meta data present, the refusal when
# sandbox data exists, the deliberate-purge path, and a repeatable apply/rollback cycle.
#
#   PGHOST=localhost PGPORT=54322 PGUSER=postgres ./scripts/db/rollback-proof-0960.sh
#
# Creates and drops the database "rb_base". Output files go to $PROOF_OUT (default: a temp directory).
set -uo pipefail
cd "$(dirname "$0")/../.."
export PGHOST="${PGHOST:-/tmp}" PGPORT="${PGPORT:-54322}" PGUSER="${PGUSER:-postgres}" PGCLIENTENCODING=UTF8
case "$PGHOST" in /tmp|localhost|127.0.0.1) ;; *) echo "Refusing: PGHOST=$PGHOST is not local" >&2; exit 1;; esac
OUT="${PROOF_OUT:-$(mktemp -d)}"
mkdir -p "$OUT"
M=supabase/migrations
MIG=$M/20261021000960_kapso_sandbox.sql
ROLLBACK=supabase/rollbacks/20261021000960_kapso_sandbox.rollback.sql
q() { psql -X -q -tA -d "$1" -c "$2"; }

mk() {   # mk <db> <with0960: yes|no>
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $1 with (force)" -c "create database $1" >/dev/null
  psql -X -q -v ON_ERROR_STOP=1 -d "$1" -f supabase/tests/shim/00_supabase_shim.sql >/dev/null 2>&1
  for f in $M/*.sql; do
    case "$f" in *20261021000960_kapso_sandbox.sql) [ "$2" = no ] && continue;; esac
    psql -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$f" >/dev/null 2>&1 || { echo "FAILED applying $f to $1"; exit 1; }
  done
}
seed() {  # Meta data that exists BEFORE 0960: fixtures + traffic (auto leads via 0950) + manual records + retry rows
  psql -X -q -v ON_ERROR_STOP=1 -d "$1" -f supabase/tests/db/_helpers.sql -f supabase/tests/db/_fixtures.sql >/dev/null 2>&1
  psql -X -q -v ON_ERROR_STOP=1 -d "$1" >/dev/null 2>&1 <<'SQL'
set role service_role;
select * from public.ingest_whatsapp_message('PNID_ALPHA','wamid.PRE1','97455570001','Pre One','text','hello',null,now() - interval '2 hours');
select * from public.ingest_whatsapp_message('PNID_ALPHA','wamid.PRE2','97455570002',null,'text','hi',null,now() - interval '1 hour');
select * from public.ingest_whatsapp_message('PNID_BETA','wamid.PRE3','97455570001','Pre One','text','hello beta',null,now());
select * from public.ingest_whatsapp_echo('PNID_ALPHA','wamid.PRE4','97455570001','text','echo reply',null,now());
select public.apply_whatsapp_status('wamid.PRE4','delivered',null,null);
select public.claim_webhook_event('msg:wamid.PRE1','message','PNID_ALPHA','{"kind":"message"}'::jsonb);
select public.finish_webhook_event('msg:wamid.PRE1','processed');
select public.claim_webhook_event('msg:wamid.PREFAIL','message','PNID_ALPHA',
  '{"kind":"message","phoneNumberId":"PNID_ALPHA","waMessageId":"wamid.PREFAIL","fromWaId":"97455570077","profileName":"Retry","messageType":"text","body":"retry","media":null,"sentAt":"2026-10-20T10:00:00Z"}'::jsonb);
select public.finish_webhook_event('msg:wamid.PREFAIL','failed','processing_error');
reset role;
insert into public.leads (company_id, contact_id, title, source, created_by, owner_id)
select tests.ref('alpha'), c.id, 'Manual before feature ' || c.full_name, 'phone', tests.uid('admin_a'), tests.uid('agent_a1')
from public.contacts c where c.phone_e164 in ('+97455570001', '+97455570002');
do $$
declare a uuid := tests.ref('alpha'); p uuid; sw uuid; ct uuid; a1 uuid := tests.uid('agent_a1');
begin
  perform set_config('app.actor_id', a1::text, true);
  select id into p from public.pipelines where company_id = a and kind = 'deal' and is_default;
  select id into sw from public.pipeline_stages where pipeline_id = p and stage_type = 'won';
  select id into ct from public.contacts where phone_e164 = '+97455570001';
  insert into public.deals (company_id, contact_id, pipeline_id, stage_id, title, amount, owner_id, created_by, won_at)
    values (a, ct, p, sw, 'Won before 0960', 1234, a1, a1, now() - interval '1 day');
  insert into public.tasks (company_id, title, assigned_to, created_by, due_at) values (a, 'Task before 0960', a1, a1, now() + interval '1 day');
  insert into public.activities (company_id, type, actor_id, contact_id, occurred_at) values (a, 'call', a1, ct, now() - interval '2 days');
end $$;
SQL
}
# Row checksums that ignore the columns 0960 adds, over rows that are not sandbox rows. Comparable
# across a database without 0960, with 0960, and after the rollback.
J="- 'is_sandbox' - 'provider'"
sums() {
  q "$1" "select string_agg(t || ':' || n || ':' || h, E'\n' order by t) from (
    select 'companies' t, count(*) n, md5(coalesce(string_agg((to_jsonb(x) $J)::text, '|' order by (to_jsonb(x) $J)::text), '')) h from public.companies x where not coalesce((to_jsonb(x)->>'is_sandbox')::boolean, false)
    union all select 'whatsapp_accounts', count(*), md5(coalesce(string_agg((to_jsonb(x) $J)::text, '|' order by (to_jsonb(x) $J)::text), '')) from public.whatsapp_accounts x where coalesce(x.phone_number_id, '') not like 'KAPSO%'
    union all select 'leads', count(*), md5(coalesce(string_agg((to_jsonb(x) $J)::text, '|' order by (to_jsonb(x) $J)::text), '')) from public.leads x where not coalesce((to_jsonb(x)->>'is_sandbox')::boolean, false)
    union all select 'contacts', count(*), md5(coalesce(string_agg((to_jsonb(x) $J)::text, '|' order by (to_jsonb(x) $J)::text), '')) from public.contacts x where not coalesce((to_jsonb(x)->>'is_sandbox')::boolean, false)
    union all select 'conversations', count(*), md5(coalesce(string_agg((to_jsonb(x) $J)::text, '|' order by (to_jsonb(x) $J)::text), '')) from public.conversations x where not coalesce((to_jsonb(x)->>'is_sandbox')::boolean, false)
    union all select 'messages', count(*), md5(coalesce(string_agg((to_jsonb(x) $J)::text, '|' order by (to_jsonb(x) $J)::text), '')) from public.messages x where not coalesce((to_jsonb(x)->>'is_sandbox')::boolean, false)
    union all select 'deals', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.deals x where x.company_id not in (select id from public.companies where coalesce((to_jsonb(companies)->>'is_sandbox')::boolean, false))
    union all select 'tasks', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.tasks x where x.company_id not in (select id from public.companies where coalesce((to_jsonb(companies)->>'is_sandbox')::boolean, false))
    union all select 'activities', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.activities x where x.company_id not in (select id from public.companies where coalesce((to_jsonb(companies)->>'is_sandbox')::boolean, false))
    union all select 'lead_assignments', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.lead_assignments x where x.company_id not in (select id from public.companies where coalesce((to_jsonb(companies)->>'is_sandbox')::boolean, false))
    union all select 'lead_status_history', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.lead_status_history x where x.company_id not in (select id from public.companies where coalesce((to_jsonb(companies)->>'is_sandbox')::boolean, false))
    union all select 'company_memberships', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.company_memberships x where x.company_id not in (select id from public.companies where coalesce((to_jsonb(companies)->>'is_sandbox')::boolean, false))
    union all select 'whatsapp_webhook_events', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.whatsapp_webhook_events x where x.event_key not like 'kapso:%'
    union all select 'contact_companies', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.contact_companies x where x.company_id not in (select id from public.companies where coalesce((to_jsonb(companies)->>'is_sandbox')::boolean, false))
    union all select 'audit_logs', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.audit_logs x where x.company_id is null or x.company_id not in (select id from public.companies where coalesce((to_jsonb(companies)->>'is_sandbox')::boolean, false))) s"
}
dump() { pg_dump -s --no-owner -d "$1" | grep -v '^\\\(un\)\?restrict' > "$OUT/$2.sql"; }   # -s: schema; includes GRANT/REVOKE
fdef() { q "$1" "select md5(pg_get_functiondef('$2'::regprocedure))"; }

echo "== A. baseline database WITHOUT 0960, with pre-existing Meta data"
mk rb_base no && seed rb_base && dump rb_base base && sums rb_base > "$OUT/base.sums"
echo "tables checksummed: $(wc -l < "$OUT/base.sums"); schema dump lines: $(wc -l < "$OUT/base.sql")"
BASE_RETRY=$(fdef rb_base "public.process_webhook_retries(integer,integer)")
BASE_SCOPE=$(fdef rb_base "app.report_scope()")
BASE_WORK=$(fdef rb_base "public.report_whatsapp_workload(uuid[])")

echo "== B. same database: apply 0960, then roll back immediately (no sandbox data)"
psql -X -q -v ON_ERROR_STOP=1 -d rb_base -f $MIG >/dev/null 2>&1 && echo "0960 applied"
echo "columns added: $(q rb_base "select count(*) from information_schema.columns where column_name in ('is_sandbox','provider') and table_schema='public'") (expected 7: companies, whatsapp_accounts x2, contacts, conversations, messages, leads)"
psql -X -q -v ON_ERROR_STOP=1 -d rb_base -f $ROLLBACK >/dev/null 2>&1; echo "rollback exit: $?"
dump rb_base after_rollback && sums rb_base > "$OUT/after.sums"
if diff -q "$OUT/base.sql" "$OUT/after_rollback.sql" >/dev/null; then echo "SCHEMA (incl. grants, functions, constraints, indexes, triggers, policies, types): IDENTICAL to the baseline"; else echo "SCHEMA DIFFERS:"; diff "$OUT/base.sql" "$OUT/after_rollback.sql" | head -30; fi
if diff -q "$OUT/base.sums" "$OUT/after.sums" >/dev/null; then echo "DATA (row checksums of $(wc -l < "$OUT/base.sums") tables): IDENTICAL before and after apply+rollback"; else echo "DATA DIFFERS:"; diff "$OUT/base.sums" "$OUT/after.sums"; fi
[ "$(fdef rb_base "public.process_webhook_retries(integer,integer)")" = "$BASE_RETRY" ] && echo "process_webhook_retries: byte-identical to the baseline definition"
[ "$(fdef rb_base "app.report_scope()")" = "$BASE_SCOPE" ] && echo "app.report_scope: byte-identical to the baseline definition"
[ "$(fdef rb_base "public.report_whatsapp_workload(uuid[])")" = "$BASE_WORK" ] && echo "report_whatsapp_workload: byte-identical to the baseline definition"
echo "Meta intake still works after the rollback:"
psql -X -q -d rb_base >/dev/null 2>&1 <<'SQL'
set role service_role;
select * from public.ingest_whatsapp_message('PNID_ALPHA','wamid.POST1','97455570055','Post','text','after rollback',null,now());
select public.apply_whatsapp_status('wamid.PRE4','read',null,null);
SQL
echo "  new message stored: $(q rb_base "select count(*) from public.messages where wa_message_id='wamid.POST1'") | status moved to read: $(q rb_base "select status from public.messages where wa_message_id='wamid.PRE4'")"
echo "  retry job re-processes the failed Meta event: $(psql -X -q -tA -d rb_base -c "set role service_role" -c "select public.process_webhook_retries()" | tail -1)"
echo "  failed Meta event now: $(q rb_base "select status from public.whatsapp_webhook_events where event_key='msg:wamid.PREFAIL'")"

sums rb_base > "$OUT/base2.sums"   # baseline now includes the Meta traffic created after the rollback
echo "== C. re-apply 0960 after the rollback (the cycle is repeatable), create SANDBOX data, run the rollback: it must stop"
psql -X -q -v ON_ERROR_STOP=1 -d rb_base -f $MIG >/dev/null 2>&1 && echo "0960 re-applied"
echo "-- C0. EMPTY sandbox: only a sandbox company exists (no account, no rows)"
psql -X -q -v ON_ERROR_STOP=1 -d rb_base -c "insert into public.companies (name, slug, timezone, currency, is_sandbox) values ('Sandbox Co', 'sandbox-co', 'Asia/Qatar', 'QAR', true)" >/dev/null 2>&1
rows0=$(q rb_base "select count(*) from public.companies")
psql -X -q -v ON_ERROR_STOP=1 -d rb_base -f $ROLLBACK 2>&1 | grep -E "ERROR|sandbox companies" | sed 's/^psql:[^ ]* //' | head -2
[ "$(q rb_base "select count(*) from public.companies")" = "$rows0" ] && echo "empty sandbox: Part 2 refused, company kept, nothing deleted"
psql -X -q -v ON_ERROR_STOP=1 -d rb_base >/dev/null 2>&1 <<'SQL'
insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status)
select id, 'Kapso Sandbox', '+15550000001', 'KAPSO_PNID_1', 'kapso', true, 'test' from public.companies where slug = 'sandbox-co';
set role service_role;
select * from public.ingest_kapso_message('KAPSO_PNID_1','wamid.SB1','97455580001','Sandy','text','hi sandbox',null,now());
select public.apply_kapso_status('KAPSO_PNID_1','wamid.SB2','sent',null,null,'97455580001','text','out',null,now());
SQL
sums rb_base > "$OUT/with_sandbox.sums"
echo "sandbox rows: companies=$(q rb_base "select count(*) from companies where is_sandbox") accounts=$(q rb_base "select count(*) from whatsapp_accounts where is_sandbox") contacts=$(q rb_base "select count(*) from contacts where is_sandbox") conversations=$(q rb_base "select count(*) from conversations where is_sandbox") messages=$(q rb_base "select count(*) from messages where is_sandbox") leads=$(q rb_base "select count(*) from leads where is_sandbox")"
rowsb=$(q rb_base "select (select count(*) from public.leads)||'/'||(select count(*) from public.contacts)||'/'||(select count(*) from public.conversations)||'/'||(select count(*) from public.messages)||'/'||(select count(*) from public.audit_logs)||'/'||(select count(*) from public.companies)")
psql -X -q -v ON_ERROR_STOP=1 -d rb_base -f $ROLLBACK 2>&1 | grep -E "ERROR|sandbox|Kapso|Decide" | sed 's/^psql:[^ ]* //' | head -9
rowsa=$(q rb_base "select (select count(*) from public.leads)||'/'||(select count(*) from public.contacts)||'/'||(select count(*) from public.conversations)||'/'||(select count(*) from public.messages)||'/'||(select count(*) from public.audit_logs)||'/'||(select count(*) from public.companies)")
echo "rows (leads/contacts/conversations/messages/audit/companies) before -> after: $rowsb -> $rowsa"
[ "$rowsb" = "$rowsa" ] && echo "NOTHING deleted by the refused rollback"
echo "schema kept (is_sandbox column present): $(q rb_base "select count(*)=1 from information_schema.columns where table_name='leads' and column_name='is_sandbox'")"
echo "metric exclusion kept while sandbox data exists: report_scope references app.company_is_sandbox = $(q rb_base "select pg_get_functiondef('app.report_scope()'::regprocedure) like '%company_is_sandbox%'") ; workload = $(q rb_base "select pg_get_functiondef('public.report_whatsapp_workload(uuid[])'::regprocedure) like '%company_is_sandbox%'")"
[ "$(fdef rb_base "public.process_webhook_retries(integer,integer)")" = "$BASE_RETRY" ] && echo "Part 1 applied: process_webhook_retries is the baseline definition again"
sums rb_base > "$OUT/with_sandbox_after.sums"
if diff -q "$OUT/with_sandbox.sums" "$OUT/with_sandbox_after.sums" >/dev/null; then echo "all non-sandbox row checksums unchanged by the refused rollback"; else diff "$OUT/with_sandbox.sums" "$OUT/with_sandbox_after.sums"; fi
if diff -q "$OUT/base2.sums" "$OUT/with_sandbox.sums" >/dev/null; then echo "Meta data checksums with sandbox traffic present == baseline (after the post-rollback Meta traffic) (sandbox traffic never touched a Meta row)"; else echo "Meta checksums differ from the baseline:"; diff "$OUT/base2.sums" "$OUT/with_sandbox.sums"; fi

echo "== D. deliberate purge of the sandbox test data (test database only), then the rollback completes"
psql -X -q -v ON_ERROR_STOP=1 -d rb_base >/dev/null 2>&1 <<'SQL'
set session_replication_role = replica;
do $$
declare s uuid; t record;
begin
  select id into s from public.companies where is_sandbox;
  delete from public.messages where conversation_id in (select id from public.conversations where company_id = s);
  for t in select c.table_name from information_schema.columns c join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
           where c.table_schema = 'public' and c.column_name = 'company_id' and tb.table_type = 'BASE TABLE' and c.table_name <> 'companies'
  loop
    execute format('delete from public.%I where company_id = $1', t.table_name) using s;
  end loop;
  delete from public.contacts where is_sandbox;
  delete from public.whatsapp_accounts where default_company_id = s;
  delete from public.companies where id = s;
  delete from public.whatsapp_webhook_events where event_key like 'kapso:%';
end $$;
SQL
echo "sandbox rows left: $(q rb_base "select (select count(*) from companies where is_sandbox)+(select count(*) from whatsapp_accounts where provider<>'meta')+(select count(*) from contacts where is_sandbox)+(select count(*) from conversations where is_sandbox)+(select count(*) from messages where is_sandbox)+(select count(*) from leads where is_sandbox)")"
psql -X -q -v ON_ERROR_STOP=1 -d rb_base -f $ROLLBACK >/dev/null 2>&1; echo "rollback exit: $?"
dump rb_base after_purge_rollback && sums rb_base > "$OUT/final.sums"
if diff -q "$OUT/base.sql" "$OUT/after_purge_rollback.sql" >/dev/null; then echo "SCHEMA after the full cycle: IDENTICAL to the baseline"; else echo "SCHEMA DIFFERS:"; diff "$OUT/base.sql" "$OUT/after_purge_rollback.sql" | head -30; fi
if diff -q "$OUT/base2.sums" "$OUT/final.sums" >/dev/null; then echo "DATA after the full cycle: IDENTICAL to the baseline"; else echo "DATA differs from the baseline:"; diff "$OUT/base2.sums" "$OUT/final.sums"; fi

echo "== E. grants of the restored functions equal the baseline"
for fn in "public.process_webhook_retries(integer,integer)" "app.report_scope()" "public.report_whatsapp_workload(uuid[])"; do
  echo "$fn ACL: $(q rb_base "select coalesce(proacl::text,'default') from pg_proc where oid='$fn'::regprocedure")"
done
psql -X -q -d postgres -c "drop database if exists rb_base with (force)" >/dev/null

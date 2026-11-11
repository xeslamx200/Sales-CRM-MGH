#!/usr/bin/env bash
# SCRATCH ONLY. Rollback scenarios on disposable clones of the post-Rev6 scratch DB. Each refusal scenario runs inside a transaction that is
# ALWAYS rolled back by this script; the committed "refusal leaves everything unchanged" proof is done separately (rb2).
set -u
export PGPORT=5432 PGUSER=postgres
: "${PGHOST:?}"; DB=${DB:-kapso_rev6_rb2_scratch}
case "$DB" in *scratch*) ;; *) echo "refusing: not a scratch database"; exit 3;; esac
RB=${ROLLBACK_SQL:?path of the rollback .sql visible to the psql client}
PRE="insert into public.companies (name, slug, timezone, currency) values ('R','rb-real','Asia/Qatar','QAR');
insert into public.companies (name, slug, timezone, currency, is_sandbox) values ('S','rb-sbx','Asia/Qatar','QAR',true);"
run() {  # run LABEL SETUP_SQL EXPECT_REGEX
  local out; out=$(printf 'begin;\n%s\n%s\n\\i %s\nrollback;\n' "$PRE" "$2" "$RB" | psql -X -q -v ON_ERROR_STOP=1 -d "$DB" 2>&1)
  if [ "$3" = OK ]; then if ! grep -q ERROR <<<"$out"; then echo "PASS  $1  -> the rollback ran to completion inside the (rolled-back) test transaction"; else echo "FAIL  $1  -> $(echo "$out" | grep ERROR | head -2 | cut -c1-300)"; fi; return; fi
  if grep -qE "$3" <<<"$out"; then echo "PASS  $1  -> $(grep -oE "rollback\.blocked[^\n]*" <<<"$out" | head -1 | cut -c1-330)"; else echo "FAIL  $1  -> expected /$3/ got: $(echo "$out" | tail -3 | tr '\n' ' ' | cut -c1-400)"; fi
}
SBXACC="insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status) select id,'sb','+15559990001','RBSBX','kapso',true,'test' from public.companies where slug='rb-sbx';"
run "R1 a Kapso PRODUCTION account exists" "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status) select id,'p','+15559990002','RBPROD','kapso','production','coexistence','test' from public.companies where slug='rb-real';" 'rollback.blocked: .*kapso production accounts=1'
run "R2 a production account with outbound enabled" "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status) select id,'p','+15559990003','RBPROD2','kapso','production','coexistence','active' from public.companies where slug='rb-real'; update public.whatsapp_accounts set outbound_enabled=true where phone_number_id='RBPROD2';" 'outbound-enabled accounts=1'
run "R3 a bsuid identity (created through the sandbox bsuid path)" "$SBXACC select count(*) from public.ingest_kapso_inbound('RBSBX','wamid.rb.1',null,'BS-RB-1',null,'x','text','x',null,now());" 'bsuid identities=1, conversations without phone=1, conversations with bsuid=1'
run "R4 a pending/failed event of kind kapso_inbound_v2" "insert into public.whatsapp_webhook_events (event_key,event_kind,phone_number_id,payload,status) values ('k1','message','x','{\"kind\":\"kapso_inbound_v2\"}','pending');" 'events=1'
run "R5 a failed quarantined event" "insert into public.whatsapp_webhook_events (event_key,event_kind,phone_number_id,payload,status) values ('k2','message','x','{\"kind\":\"kapso_quarantined\"}','failed');" 'events=1'
run "R6 a message that carries provider_origin" "$SBXACC select count(*) from public.ingest_kapso_message('RBSBX','wamid.rb.2','20100000999','x','text','x',null,now()); update public.messages set provider_origin='cloud_api';" 'messages with provider_origin=1'
run "R7 an unconfirmed outbound message" "$SBXACC select count(*) from public.ingest_kapso_message('RBSBX','wamid.rb.3','20100000998','x','text','x',null,now()); insert into public.messages (conversation_id, direction, message_type, body, status, error_code, sent_at) select id,'outbound','text','u','queued','send.unconfirmed',now() from public.conversations limit 1;" 'unconfirmed outbound=1'
run "R8 a sandbox conversation created by the OLD phone path only (no new-model data) -> NOT blocked" "$SBXACC select count(*) from public.ingest_kapso_inbound('RBSBX','wamid.rb.4','20100000997',null,null,'x','text','x',null,now());" OK

#!/usr/bin/env bash
# DISPOSABLE DATABASES ONLY, from a separate client container (see README.md). Webhook event lifecycle of patch 978
# (supabase/proposed/20261104000978_kapso_event_lifecycle.sql): claim / finish / held records, the retry job (quarantine exclusion,
# stale-pending sweep, attempt bound, permanent failures, concurrent runs), crash windows, protocol classification, and that the retry
# job cannot send anything. Deterministic: every interleaving is driven by pg_blocking_pids / session output, never by sleeps alone.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
SVC="select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);"
sq() { psql -X -q -tA -c "$SVC" -c "$1" 2>&1 | tail -n +1 | grep -v '^{"role"' | head -${2:-1}; }   # as the service role
st() { q "select status||'/'||attempts||'/'||coalesce(last_error,'-')||'/'||coalesce(payload->>'kind','-') from public.whatsapp_webhook_events where event_key='$1'"; }
inb() {  # v2 retry payload for an inbound customer message: inb PNID WAMID PHONE
  echo "jsonb_build_object('kind','kapso_inbound_v2','eventKey','kapso:msg:$2','phoneNumberId','$1','waMessageId','$2','fromWaId','$3','fromBsuid',null,'origin',null,'profileName','T','messageType','text','body','hi','media',null,'sentAt',now()::text)"
}
qpay() { echo "jsonb_build_object('kind','kapso_quarantined','reason','$1')"; }

claim_finish() {
  local a P k n; a=$(mkacct); P=${a##*|}; n=$(next); k="kapso:msg:wamid.lc1.$n"
  check "T-LC-1a claim_kapso_event: first delivery is new" "$(sq "select public.claim_kapso_event('$k','message','$P',$(inb $P wamid.lc1.$n 2010$(printf %09d $n)))")" "new"
  check "T-LC-1b a failed row is claimed again as retry" "$(sq "select public.finish_kapso_event('$k','failed','kapso.unknown_account'); select public.claim_kapso_event('$k','message','$P',$(inb $P wamid.lc1.$n 2011$(printf %09d $n)))" 2 | tail -1)" "retry"
  check "T-LC-1c ...and gets the NEW payload (a fresh parse replaces what was stored)" "$(q "select payload->>'fromWaId' from public.whatsapp_webhook_events where event_key='$k'")" "2011$(printf %09d $n)"
  check "T-LC-1d processed -> duplicate" "$(sq "select public.finish_kapso_event('$k','processed'); select public.claim_kapso_event('$k','message','$P',$(inb $P wamid.lc1.$n 2010$(printf %09d $n)))" 2 | tail -1)" "duplicate"
  check "T-LC-1e a processed row keeps no payload" "$(q "select payload::text from public.whatsapp_webhook_events where event_key='$k'")" "{}"
  check "T-LC-2a a late 'failed' finish never downgrades a processed row" "$(sq "select public.finish_kapso_event('$k','failed','processing_error')")|$(st $k)" "already_final|processed/2/-/-"
  check "T-LC-2b finishing a row that does not exist raises (never a silent no-op)" "$(sq "select public.finish_kapso_event('kapso:msg:nope.$n','processed')" | grep -o 'webhook.event_not_found')" "webhook.event_not_found"
  local k2="kapso:msg:wamid.lc2.$n"
  sq "select public.claim_kapso_event('$k2','message','$P',$(inb $P wamid.lc2.$n 2012$(printf %09d $n)))" >/dev/null
  sq "select public.finish_kapso_event('$k2','failed','duplicate key (+201234) contacts_phone_key')" >/dev/null
  check "T-LC-2c a stored error is a stable code, never free text" "$(q "select last_error from public.whatsapp_webhook_events where event_key='$k2'")" "processing_error"
  check "T-LC-1f claim refuses a non-v2 payload kind and a foreign key prefix" "$(sq "select public.claim_kapso_event('kapso:msg:x$n','message','$P',$(qpay x))" | grep -o 'webhook.invalid_payload_kind')|$(sq "select public.claim_kapso_event('meta:x$n','message','$P',$(inb $P x$n 2010000000))" | grep -o 'webhook.invalid_event_key')" "webhook.invalid_payload_kind|webhook.invalid_event_key"
  check "T-LC-1g only the service role may call the lifecycle functions" "$(q "select has_function_privilege('authenticated','public.claim_kapso_event(text,text,text,jsonb)','execute')::text||has_function_privilege('anon','public.record_kapso_held_event(text,text,text,jsonb,text,text)','execute')::text||has_function_privilege('authenticated','public.list_kapso_quarantined(text,int)','execute')::text")" "falsefalsefalse"
}

held() {
  local n k P; n=$(next); P="PN_HELD_$n"; k="kapso:invalid:$(printf %064d $n)"
  check "T-LC-3a a quarantine record is ONE atomic write: failed + reason + kind kapso_quarantined" "$(sq "select public.record_kapso_held_event('$k','message','$P',$(qpay invalid.missing_message),'failed','invalid.missing_message')")|$(st $k)" "recorded|failed/1/invalid.missing_message/kapso_quarantined"
  check "T-LC-3b redelivery of the same item updates the same row (no duplicate record)" "$(sq "select public.record_kapso_held_event('$k','message','$P',$(qpay invalid.missing_message),'failed','invalid.missing_message')")|$(q "select count(*) from public.whatsapp_webhook_events where event_key='$k'")|$(st $k)" "recorded|1|failed/2/invalid.missing_message/kapso_quarantined"
  local kh="kapso:msg:wamid.hist.$n"
  check "T-LC-3c an ignored (history_sync) record keeps no payload and is final" "$(sq "select public.record_kapso_held_event('$kh','message','$P',$(qpay history_sync),'ignored','history_sync')")|$(st $kh)|$(q "select payload::text from public.whatsapp_webhook_events where event_key='$kh'")" "recorded|ignored/1/-/-|{}"
  check "T-LC-3d a held record never touches a final row" "$(sq "select public.record_kapso_held_event('$kh','message','$P',$(qpay origin.unknown),'failed','origin.unknown')")|$(st $kh)" "duplicate|ignored/1/-/-"
  local kr="kapso:msg:wamid.work.$n"
  sq "select public.claim_kapso_event('$kr','message','$P',$(inb $P wamid.work.$n 2013$(printf %09d $n))); select public.finish_kapso_event('$kr','failed','kapso.unknown_account')" >/dev/null
  check "T-LC-3e a held record never replaces processable retry work" "$(sq "select public.record_kapso_held_event('$kr','message','$P',$(qpay invalid.missing_customer_identity),'failed','invalid.missing_customer_identity')")|$(st $kr)" "duplicate|failed/1/kapso.unknown_account/kapso_inbound_v2"
  check "T-LC-3f a failed held row must be a quarantine payload (never retry work)" "$(sq "select public.record_kapso_held_event('kapso:invalid:x$n','message','$P',$(inb $P x$n 2010000000),'failed','origin.unknown')" | grep -o 'webhook.invalid_payload_kind')" "webhook.invalid_payload_kind"
  check "T-LC-3g reason and size are validated" "$(sq "select public.record_kapso_held_event('kapso:invalid:y$n','other',null,$(qpay x),'failed','Free Text!')" | grep -o 'webhook.invalid_reason')|$(sq "select public.record_kapso_held_event('kapso:invalid:z$n','other',null,jsonb_build_object('kind','kapso_quarantined','big',repeat(md5(random()::text),5000)),'failed','origin.unknown')" | grep -o 'webhook.payload_too_large')" "webhook.invalid_reason|webhook.payload_too_large"
}

retries() {
  local a ACC P n kq ks kf kx kp km pend_meta
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next)
  kq="kapso:msg:wamid.q.$n"; ks="kapso:msg:wamid.stale.$n"; kf="kapso:msg:wamid.fresh.$n"; kx="kapso:msg:wamid.exh.$n"; kp="kapso:msg:wamid.perm.$n"; km="meta:pending.$n"
  sq "select public.record_kapso_held_event('$kq','message','$P',$(qpay origin.unknown),'failed','origin.unknown')" >/dev/null
  # a webhook request that died between claim and finish: 'pending' for 20 minutes
  sq "select public.claim_kapso_event('$ks','message','$P',$(inb $P wamid.stale.$n 2014$(printf %09d $n)))" >/dev/null
  qa "update public.whatsapp_webhook_events set received_at = now() - interval '20 minutes' where event_key='$ks'" >/dev/null
  sq "select public.claim_kapso_event('$kf','message','$P',$(inb $P wamid.fresh.$n 2015$(printf %09d $n)))" >/dev/null
  # exhausted (8 attempts) and permanently failing (unknown account) events
  sq "select public.claim_kapso_event('$kx','message','$P',$(inb $P wamid.exh.$n 2016$(printf %09d $n))); select public.finish_kapso_event('$kx','failed','kapso.unknown_account')" >/dev/null
  qa "update public.whatsapp_webhook_events set attempts = 8 where event_key='$kx'" >/dev/null
  sq "select public.claim_kapso_event('$kp','message','PN_UNKNOWN_$n',$(inb PN_UNKNOWN_$n wamid.perm.$n 2017$(printf %09d $n))); select public.finish_kapso_event('$kp','failed','kapso.unknown_account')" >/dev/null
  # a Meta row stuck in pending: the sweep is for v2 kinds only (Meta behaviour unchanged)
  qa "insert into public.whatsapp_webhook_events (event_key, event_kind, phone_number_id, payload, attempts, received_at) values ('$km','message','PNID_ALPHA','{\"kind\":\"message\"}',1, now() - interval '1 hour')" >/dev/null
  local r; r=$(sq "select public.process_webhook_retries(100, 8)")
  info "T-LC-4 retry job result: $r"
  check "T-LC-4a a quarantine row is never selected (status, attempts, reason unchanged)" "$(st $kq)" "failed/1/origin.unknown/kapso_quarantined"
  check "T-LC-4b a v2 row left 'pending' by a crashed request is recovered by the job (15 min)" "$(st $ks)" "processed/2/-/-"
  check "T-LC-4c ...and its message exists exactly once, in the account's conversation" "$(q "select count(*) from public.messages m join public.conversations c on c.id=m.conversation_id where m.wa_message_id='wamid.stale.$n' and c.whatsapp_account_id='$ACC'")" "1"
  check "T-LC-4d a FRESH pending row (request possibly still running) is not touched" "$(st $kf)" "pending/1/-/kapso_inbound_v2"
  check "T-LC-4e an exhausted row (8 attempts) is not retried again" "$(st $kx)" "failed/8/kapso.unknown_account/kapso_inbound_v2"
  check "T-LC-4f a permanent failure is retried with a bound and keeps its stable code" "$(st $kp)" "failed/2/kapso.unknown_account/kapso_inbound_v2"
  for i in 3 4 5 6 7 8 9; do sq "select public.process_webhook_retries(100, 8)" >/dev/null; done
  check "T-LC-4g ...after more runs it stops at the bound (8) and stays a dead letter" "$(st $kp)" "failed/8/kapso.unknown_account/kapso_inbound_v2"
  check "T-LC-4h no conversation/contact was created for the unknown account" "$(q "select count(*) from public.messages where wa_message_id='wamid.perm.$n'")" "0"
  check "T-LC-4i a stale Meta pending row is not swept (Meta behaviour unchanged)" "$(q "select status||'/'||attempts from public.whatsapp_webhook_events where event_key='$km'")" "pending/1"
  check "T-LC-4j the retry job has no outbound path (no send/queue/http call in its body)" "$(q "select (prosrc ~* 'queue_outbound|record_outbound_result|http_(get|post)|net\.http') ::text from pg_proc where proname='process_webhook_retries'")" "false"
}

concurrent_jobs() {
  local a ACC P n i keys=""
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next)
  for i in 1 2 3 4 5 6; do
    sq "select public.claim_kapso_event('kapso:msg:wamid.cj.$n.$i','message','$P',$(inb $P wamid.cj.$n.$i 2018$(printf %07d $n)$i$i)); select public.finish_kapso_event('kapso:msg:wamid.cj.$n.$i','failed','processing_error')" >/dev/null
  done
  sess J1; sess J2
  send J1 "$SVC"; send J2 "$SVC"
  send J1 "begin; select 'J1:'||public.process_webhook_retries(100, 8)::text; select 'J1_DONE';"
  wait_out J1 J1_DONE
  send J2 "select 'J2:'||public.process_webhook_retries(100, 8)::text; select 'J2_DONE';"
  wait_out J2 J2_DONE && pass "T-LC-5a a second, concurrent job run does not wait for the first (SKIP LOCKED)" || fail "T-LC-5a" "second job blocked"
  check "T-LC-5b ...and takes none of the events the first run holds" "$(grep -o 'J2:{[^}]*}' $D/J2.out | grep -o '"processed": [0-9]*')" '"processed": 0'
  send J1 "commit;"; sleep 0.5; endsess J1; endsess J2
  check "T-LC-5c every event was attempted exactly once and processed" "$(q "select string_agg(distinct status||'/'||attempts, ',') from public.whatsapp_webhook_events where event_key like 'kapso:msg:wamid.cj.$n.%'")" "processed/2"
  check "T-LC-5d one message per event (no duplicates)" "$(q "select count(*)||'/'||count(distinct wa_message_id) from public.messages where wa_message_id like 'wamid.cj.$n.%'")" "6/6"
}

crash_windows() {
  local a ACC P n k; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next); k="kapso:msg:wamid.cw.$n"
  # 1. claimed, then the request died (no ingest, no finish) -> the redelivery claims 'retry' and completes it
  sq "select public.claim_kapso_event('$k','message','$P',$(inb $P wamid.cw.$n 2019$(printf %09d $n)))" >/dev/null
  check "T-LC-6a crash after claim leaves a pending row (nothing is lost)" "$(st $k)" "pending/1/-/kapso_inbound_v2"
  check "T-LC-6b the provider's redelivery claims it again" "$(sq "select public.claim_kapso_event('$k','message','$P',$(inb $P wamid.cw.$n 2019$(printf %09d $n)))")" "retry"
  # 2. ingested, then the request died before finish -> a second ingest is a duplicate, not a second message
  sq "select * from public.ingest_kapso_inbound('$P','wamid.cw.$n','2019$(printf %09d $n)',null,null,'T','text','hi',null,now())" >/dev/null
  sq "select * from public.ingest_kapso_inbound('$P','wamid.cw.$n','2019$(printf %09d $n)',null,null,'T','text','hi',null,now())" >/dev/null
  sq "select public.finish_kapso_event('$k','processed')" >/dev/null
  check "T-LC-6c crash between ingest and finish: re-ingest is a duplicate (one message, one lead)" "$(q "select (select count(*) from public.messages where wa_message_id='wamid.cw.$n')||'/'||(select count(*) from public.leads l join public.conversations c on c.contact_id=l.contact_id where c.whatsapp_account_id='$ACC')")" "1/1"
  # 3. the ingestion transaction fails -> nothing it created survives
  local before; before=$(q "select count(*) from public.contacts")
  sq "select * from public.ingest_kapso_inbound('PN_NONE_$n','wamid.cw2.$n','2020$(printf %09d $n)',null,null,'T','text','hi',null,now())" >/dev/null
  check "T-LC-6d a failed ingestion transaction leaves no contact, conversation or message" "$(( $(q "select count(*) from public.contacts") - before ))/$(q "select count(*) from public.messages where wa_message_id='wamid.cw2.$n'")" "0/0"
}

protocol() {
  local a P n sb sbacc
  a=$(mkacct); P=${a##*|}; n=$(next)
  check "T-LC-7a production account -> production" "$(sq "select public.kapso_account_protocol('$P')")" "production"
  check "T-LC-7b unknown phone_number_id -> NULL (the ingest wrapper then refuses it)" "$(sq "select coalesce(public.kapso_account_protocol('PN_NONE_$n'),'null')")" "null"
  check "T-LC-7c a Meta account is not a Kapso account -> NULL" "$(sq "select coalesce(public.kapso_account_protocol('PNID_ALPHA'),'null')")" "null"
  sb=$(q "insert into public.companies (name, slug, is_sandbox) values ('Sandbox $n','sandbox-$n',true) returning id" 2>&1)
  if [[ "$sb" =~ ^[0-9a-f-]{36}$ ]]; then
    sbacc=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status) values ('$sb','SB$n','+1556$(printf %07d $n)','SB_$n','kapso','sandbox','sandbox','test') returning id" 2>&1)
    check "T-LC-7d sandbox account in a sandbox company -> sandbox" "$(sq "select public.kapso_account_protocol('SB_$n')")" "sandbox"
    local bad; bad=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status) values ('$sb','BAD$n','+1557$(printf %07d $n)','BAD_$n','kapso','production','cloud_api','test') returning id" 2>&1)
    if [[ "$bad" =~ ^[0-9a-f-]{36}$ ]]; then check "T-LC-7e a production account mapped to a sandbox company -> misconfigured" "$(sq "select public.kapso_account_protocol('BAD_$n')")" "misconfigured"
    else info "T-LC-7e a production account in a sandbox company cannot even be created (constraint/trigger): $(echo "$bad" | grep -o 'ERROR: *[a-z_.]*' | head -1)"; fi
  else info "T-LC-7d sandbox company fixture could not be created: $(echo "$sb" | head -c 160)"; fi
  qa "update public.whatsapp_accounts set status='disabled' where phone_number_id='$P'" >/dev/null 2>&1
  check "T-LC-7f an inactive account -> NULL" "$(sq "select coalesce(public.kapso_account_protocol('$P'),'null')")" "null"
}

# ------------------------------------------------------------------------------------------------ 978 revision (event overwrite /
# terminal states). rowsig = the WHOLE row (every column: id, kind, phone_number_id, payload, status, attempts, last_error,
# received_at, processed_at), so "unchanged" means byte-for-byte unchanged.
rowsig() { q "select md5(row(e.*)::text) from public.whatsapp_webhook_events e where event_key='$1'"; }
stv() {  # status/attempts/last_error/payload-kind/processed_at-set/payload
  q "select status||'|'||attempts||'|'||coalesce(last_error,'-')||'|'||coalesce(payload->>'kind','-')||'|'||(processed_at is not null)::text||'|'||payload::text from public.whatsapp_webhook_events where event_key='$1'"
}
stp() {  # v2 status-event payload: stp PNID WAMID
  echo "jsonb_build_object('kind','kapso_status_v2','eventKey','kapso:status:$2:sent','phoneNumberId','$1','waMessageId','$2','status','sent','toWaId',null,'toBsuid',null,'origin',null,'messageType','text','body','x','sentAt',now()::text,'errorCode',null,'errorMessage',null,'media',null)"
}
# make a row in a given state through the real functions: mk STATE KEY KIND PNID PAYLOAD
mk() {
  sq "select public.claim_kapso_event('$2','$3','$4',$5)" >/dev/null
  case "$1" in
    failed) sq "select public.finish_kapso_event('$2','failed','kapso.unknown_account')" >/dev/null;;
    processed|ignored) sq "select public.finish_kapso_event('$2','$1')" >/dev/null;;
  esac
  qa "update public.whatsapp_webhook_events set received_at = received_at - interval '3 minutes' where event_key='$2'" >/dev/null   # distinct timestamps
}

protect() {
  local a P n k sig r st
  a=$(mkacct); P=${a##*|}; n=$(next)
  for st in pending failed processed ignored; do
    for kind in inbound status; do
      if [ $kind = inbound ]; then k="kapso:msg:wamid.pr.$st.$n"; mk $st "$k" message "$P" "$(inb $P wamid.pr.$st.$n 2021$(printf %09d $n))"
      else k="kapso:status:wamid.prs.$st.$n:sent"; mk $st "$k" status "$P" "$(stp $P wamid.prs.$st.$n)"; fi
      sig=$(rowsig "$k")
      r=$(sq "select public.record_kapso_held_event('$k','message','OTHER_PN_$n',$(qpay invalid.missing_customer_identity),'failed','invalid.missing_customer_identity')")
      check "T-978-A $st $kind event + quarantine write -> duplicate, row byte-for-byte unchanged (payload, kind, status, attempts, error, timestamps, account)" "$r|$(rowsig "$k")" "duplicate|$sig"
      r=$(sq "select public.record_kapso_held_event('$k','message','OTHER_PN_$n',$(qpay history_sync),'ignored','history_sync')")
      check "T-978-A $st $kind event + IGNORED (history_sync) write -> duplicate, unchanged" "$r|$(rowsig "$k")" "duplicate|$sig"
    done
  done
  # a replaceable quarantine record IS refreshed by a redelivery (payload, reason, attempts), and an ignored-write can settle it
  k="kapso:msg:wamid.prq.$n"
  sq "select public.record_kapso_held_event('$k','message','$P',$(qpay origin.unknown),'failed','origin.unknown')" >/dev/null
  r=$(sq "select public.record_kapso_held_event('$k','message','$P',jsonb_build_object('kind','kapso_quarantined','reason','origin.direction_conflict','v',2),'failed','origin.direction_conflict')")
  check "T-978-A7 an existing quarantine record is refreshed: recorded, new payload and reason, attempts+1" "$r|$(q "select status||'/'||attempts||'/'||last_error||'/'||(payload->>'v') from public.whatsapp_webhook_events where event_key='$k'")" "recorded|failed/2/origin.direction_conflict/2"
  # a pending quarantine record (v1 two-step write interrupted) is replaceable too
  k="kapso:invalid:$(printf %064d $n)"
  qa "insert into public.whatsapp_webhook_events (event_key, event_kind, payload, attempts) values ('$k','other','{\"kind\":\"kapso_quarantined\",\"reason\":\"x\"}', 1)" >/dev/null
  check "T-978-A8 a PENDING quarantine record (interrupted two-step write) is completed by a redelivery" "$(sq "select public.record_kapso_held_event('$k','other',null,$(qpay invalid.missing_message),'failed','invalid.missing_message')")|$(st $k)" "recorded|failed/2/invalid.missing_message/kapso_quarantined"
}

terminal() {
  local a P n ex rq k sig r
  a=$(mkacct); P=${a##*|}; n=$(next)
  for ex in processed ignored failed pending; do
    for rq in failed ignored processed; do
      k="kapso:msg:wamid.tm.$ex.$rq.$n"; mk $ex "$k" message "$P" "$(inb $P wamid.tm.$ex.$rq.$n 2022$(printf %09d $n))"
      sig=$(rowsig "$k"); local att; att=$(q "select attempts from public.whatsapp_webhook_events where event_key='$k'")
      r=$(sq "select public.finish_kapso_event('$k','$rq','status.message_not_found')")
      case "$ex" in
        processed|ignored)
          check "T-978-B $ex -> $rq: already_final, row byte-for-byte unchanged" "$r|$(rowsig "$k")" "already_final|$sig";;
        *)
          case "$rq" in
            failed) check "T-978-B $ex -> failed: finished; failed, error recorded, payload KEPT, not final, attempts unchanged" "$r|$(stv "$k")" "finished|failed|$att|status.message_not_found|kapso_inbound_v2|false|$(q "select payload::text from public.whatsapp_webhook_events where event_key='$k'")";;
            *) check "T-978-B $ex -> $rq: finished; final, payload dropped, no error, processed_at set, attempts unchanged" "$r|$(stv "$k")" "finished|$rq|$att|-|-|true|{}";;
          esac;;
      esac
    done
  done
}

races() {
  local a ACC P n k ph
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next)
  # C1: worker A's claim INSERT is not committed yet; B's quarantine write for the same key must wait for it, then must not replace it
  k="kapso:msg:wamid.rc1.$n"; ph="2023$(printf %09d $n)"
  sess RA1; sess RB1
  send RA1 "begin; select 'A:'||public.claim_kapso_event('$k','message','$P',$(inb $P wamid.rc1.$n $ph));"; wait_out RA1 "A:new"
  send RB1 "select 'B:'||public.record_kapso_held_event('$k','message','$P',$(qpay invalid.missing_customer_identity),'failed','invalid.missing_customer_identity');"
  wait_blocked RB1 && check "T-978-C1a B's quarantine write waits for A's uncommitted claim (unique index), in another session" "$(blockers RB1)" "$(pid_of RA1)" || fail "T-978-C1a" "B not blocked"
  send RA1 "commit;"; wait_out RB1 "B:"
  check "T-978-C1b ...after A commits, B gets duplicate and A's processable payload stays" "$(grep -o 'B:[a-z_]*' $D/RB1.out)|$(st $k)" "B:duplicate|pending/1/-/kapso_inbound_v2"
  sq "select * from public.ingest_kapso_inbound('$P','wamid.rc1.$n','$ph',null,null,'T','text','hi',null,now())" >/dev/null
  check "T-978-C1c A finishes normally: processed, exactly one message" "$(sq "select public.finish_kapso_event('$k','processed')")|$(st $k)|$(q "select count(*) from public.messages where wa_message_id='wamid.rc1.$n'")" "finished|processed/1/-/-|1"
  endsess RA1; endsess RB1
  # C2: A's FAILED mark is in flight (row locked, uncommitted); B's quarantine write waits, then must leave the retry work intact
  k="kapso:msg:wamid.rc2.$n"; ph="2024$(printf %09d $n)"
  sq "select public.claim_kapso_event('$k','message','$P',$(inb $P wamid.rc2.$n $ph))" >/dev/null
  sess RA2; sess RB2
  send RA2 "begin; select 'A:'||public.finish_kapso_event('$k','failed','kapso.identity_conflict');"; wait_out RA2 "A:finished"
  send RB2 "select 'B:'||public.record_kapso_held_event('$k','message','$P',$(qpay origin.unknown),'failed','origin.unknown');"
  wait_blocked RB2 && check "T-978-C2a B's quarantine write waits on the row lock of A's failure mark" "$(blockers RB2)" "$(pid_of RA2)" || fail "T-978-C2a" "B not blocked"
  send RA2 "commit;"; wait_out RB2 "B:"
  check "T-978-C2b ...B gets duplicate; the event stays recoverable retry work with A's error and the ORIGINAL payload" "$(grep -o 'B:[a-z_]*' $D/RB2.out)|$(st $k)|$(q "select payload->>'fromWaId' from public.whatsapp_webhook_events where event_key='$k'")" "B:duplicate|failed/1/kapso.identity_conflict/kapso_inbound_v2|$ph"
  endsess RA2; endsess RB2
  sq "select public.process_webhook_retries(100, 8)" >/dev/null
  check "T-978-C2c the retry job processes the ORIGINAL payload: processed, one message for the original customer" "$(st $k)|$(q "select count(*) from public.messages m join public.conversations c on c.id=m.conversation_id where m.wa_message_id='wamid.rc2.$n' and c.customer_wa_id='$ph' and c.whatsapp_account_id='$ACC'")" "processed/2/-/-|1"
  # C3/C4: two workers race to conflicting terminal states; the first commit wins, the second is refused
  for pair in "processed ignored" "ignored processed"; do
    set -- $pair; local first=$1 second=$2
    k="kapso:msg:wamid.rc3.$first.$n"
    sq "select public.claim_kapso_event('$k','message','$P',$(inb $P wamid.rc3.$first.$n 2025$(printf %09d $n)))" >/dev/null
    sess "WA$first"; sess "WB$first"
    send "WA$first" "begin; select 'A:'||public.finish_kapso_event('$k','$first');"; wait_out "WA$first" "A:finished"
    send "WB$first" "select 'B:'||public.finish_kapso_event('$k','$second');"
    wait_blocked "WB$first" && check "T-978-C3 [$first vs $second] the second finish waits for the first (row lock)" "$(blockers "WB$first")" "$(pid_of "WA$first")" || fail "T-978-C3" "not blocked"
    send "WA$first" "commit;"; wait_out "WB$first" "B:"
    check "T-978-C3 [$first vs $second] after the first commits, the second is already_final and the state stays $first" "$(grep -o 'B:[a-z_]*' "$D/WB$first.out")|$(stv "$k")" "B:already_final|$first|1|-|-|true|{}"
    endsess "WA$first"; endsess "WB$first"
  done
  # C5: a quarantine write racing a PROCESSED mark in flight
  k="kapso:msg:wamid.rc5.$n"
  sq "select public.claim_kapso_event('$k','message','$P',$(inb $P wamid.rc5.$n 2026$(printf %09d $n)))" >/dev/null
  sess RA5; sess RB5
  send RA5 "begin; select 'A:'||public.finish_kapso_event('$k','processed');"; wait_out RA5 "A:finished"
  send RB5 "select 'B:'||public.record_kapso_held_event('$k','message','$P',$(qpay origin.unknown),'failed','origin.unknown');"
  wait_blocked RB5 || fail "T-978-C5a" "B not blocked"
  send RA5 "commit;"; wait_out RB5 "B:"
  check "T-978-C5 a quarantine write that waited for a processed mark gets duplicate; processed stays processed" "$(grep -o 'B:[a-z_]*' $D/RB5.out)|$(st $k)" "B:duplicate|processed/1/-/-"
  endsess RA5; endsess RB5
}

retry978() {
  local a ACC P n kq kp ki kf sq_ sp si
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next)
  kq="kapso:msg:wamid.rt.q.$n"; kp="kapso:msg:wamid.rt.p.$n"; ki="kapso:msg:wamid.rt.i.$n"; kf="kapso:msg:wamid.rt.f.$n"
  sq "select public.record_kapso_held_event('$kq','message','$P',jsonb_build_object('kind','kapso_quarantined','reason','x','rawItem',jsonb_build_object('message',jsonb_build_object('id','wamid.rt.q.$n'))),'failed','invalid.missing_customer_identity')" >/dev/null
  mk processed "$kp" message "$P" "$(inb $P wamid.rt.p.$n 2027$(printf %09d $n))"
  mk ignored "$ki" message "$P" "$(inb $P wamid.rt.i.$n 2028$(printf %09d $n))"
  mk failed "$kf" message "$P" "$(inb $P wamid.rt.f.$n 2029$(printf %09d $n))"
  sq_=$(rowsig "$kq"); sp=$(rowsig "$kp"); si=$(rowsig "$ki")
  # every way back into work is refused for terminal rows
  check "T-978-D1 a terminal row cannot be reopened: claim -> duplicate, quarantine -> duplicate, finish failed -> already_final" \
    "$(sq "select public.claim_kapso_event('$kp','message','$P',$(inb $P wamid.rt.p.$n 2027$(printf %09d $n)))")|$(sq "select public.record_kapso_held_event('$ki','message','$P',$(qpay origin.unknown),'failed','origin.unknown')")|$(sq "select public.finish_kapso_event('$kp','failed','processing_error')")" \
    "duplicate|duplicate|already_final"
  sq "select public.process_webhook_retries(100, 8)" >/dev/null; sq "select public.process_webhook_retries(100, 8)" >/dev/null
  check "T-978-D2 the retry job processed the failed event's ORIGINAL payload (one message)" "$(st $kf)|$(q "select count(*) from public.messages where wa_message_id='wamid.rt.f.$n'")" "processed/2/-/-|1"
  check "T-978-D3 the quarantine record was not processed, the processed and ignored rows were not retried (all byte-for-byte unchanged)" "$(rowsig "$kq")|$(rowsig "$kp")|$(rowsig "$ki")|$(q "select count(*) from public.messages where wa_message_id in ('wamid.rt.q.$n','wamid.rt.i.$n')")" "$sq_|$sp|$si|0"
}

# ------------------------------------------------------------------------------------------------ retry worker vs webhook worker
# The retry job (one transaction, rows taken FOR UPDATE SKIP LOCKED) races a webhook worker on the SAME v2 event. Independent sessions;
# the job transaction is held open (begin ... job ... commit) so the interleaving is decided by pg_blocking_pids, not by timing.
jobrace() {
  local a ACC P n k ph j
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next)
  check "T-978-J0 the retry job finishes v2 kinds through finish_kapso_event and legacy kinds through finish_webhook_event" \
    "$(q "select (prosrc ~ 'if v_v2 then\s+--[^\n]*\n(\s+--[^\n]*\n)*\s+if public.finish_kapso_event')::text||'/'||(regexp_count(prosrc, 'public\.finish_kapso_event\('))||'/'||(regexp_count(prosrc, 'public\.finish_webhook_event\(')) from pg_proc where proname='process_webhook_retries'")" "true/2/4"   # 2 v2 call sites (finish + exception), 4 legacy ones (as in 970)
  # J1/J2: the job holds the row; a webhook worker's late finish (failed, then processed) waits and is then refused
  for req in failed processed; do
    k="kapso:msg:wamid.jr1.$req.$n"; ph="2030$(printf %08d $n)${#req}"
    mk failed "$k" message "$P" "$(inb $P wamid.jr1.$req.$n $ph)"
    sess "JJ$req"; sess "JW$req"
    send "JJ$req" "$SVC"; send "JJ$req" "begin; select 'J:'||public.process_webhook_retries(100, 8)::text; select 'J_HELD';"; wait_out "JJ$req" J_HELD
    send "JW$req" "$SVC"; send "JW$req" "select 'W:'||public.finish_kapso_event('$k','$req','kapso.identity_conflict');"
    wait_blocked "JW$req" && check "T-978-J1 [$req] the webhook's finish waits for the retry job's row lock (other session)" "$(blockers "JW$req")" "$(pid_of "JJ$req")" || fail "T-978-J1 [$req]" "webhook not blocked"
    send "JJ$req" "commit;"; wait_out "JW$req" "W:"
    check "T-978-J2 [$req] after the job commits: the webhook gets already_final; the job's processed state stands; one message" \
      "$(grep -o 'W:[a-z_]*' "$D/JW$req.out")|$(st $k)|$(q "select count(*) from public.messages where wa_message_id='wamid.jr1.$req.$n'")" "W:already_final|processed/2/-/-|1"
    check "T-978-J2b [$req] the job's JSON answer keeps its keys and counted processed work" \
      "$(grep -o 'J:{[^}]*}' "$D/JJ$req.out" | grep -o '"[a-z_]*":' | sort | paste -sd ' ')|$(grep -o 'J:{[^}]*}' "$D/JJ$req.out" | grep -c '"processed": [1-9]')" \
      '"failed": "ignored": "processed": "unconfirmed_expired":|1'
    endsess "JJ$req"; endsess "JW$req"
  done
  # J3: the webhook worker holds the row (its processed mark in flight); the job does NOT wait (SKIP LOCKED) and does not touch it
  k="kapso:msg:wamid.jr3.$n"; ph="2031$(printf %09d $n)"
  mk failed "$k" message "$P" "$(inb $P wamid.jr3.$n $ph)"
  sq "select * from public.ingest_kapso_inbound('$P','wamid.jr3.$n','$ph',null,null,'T','text','hi',null,now())" >/dev/null   # the webhook's own ingest
  sess JW3; sess JJ3
  send JW3 "begin; select 'W:'||public.finish_kapso_event('$k','processed');"; wait_out JW3 "W:finished"
  send JJ3 "$SVC"; send JJ3 "select 'J:'||public.process_webhook_retries(100, 8)::text; select 'J_DONE';"
  wait_out JJ3 J_DONE && pass "T-978-J3 the retry job does not wait for a row a webhook worker holds (SKIP LOCKED)" || fail "T-978-J3" "job blocked"
  check "T-978-J3b ...it did not attempt that row (attempts unchanged while the webhook holds it)" "$(q "select attempts from public.whatsapp_webhook_events where event_key='$k'")" "1"
  send JW3 "commit;"; sleep 0.3; endsess JW3; endsess JJ3
  sq "select public.process_webhook_retries(100, 8)" >/dev/null
  check "T-978-J3c after the webhook commits, the event is processed once and a later job run leaves it alone" "$(st $k)|$(q "select count(*) from public.messages where wa_message_id='wamid.jr3.$n'")" "processed/1/-/-|1"
  # J4: the job holds the row; a webhook redelivery's CLAIM waits, then sees the terminal row and answers duplicate
  k="kapso:msg:wamid.jr4.$n"; ph="2032$(printf %09d $n)"
  mk failed "$k" message "$P" "$(inb $P wamid.jr4.$n $ph)"
  sess JJ4; sess JW4
  send JJ4 "$SVC"; send JJ4 "begin; select 'J:'||public.process_webhook_retries(100, 8)::text; select 'J_HELD';"; wait_out JJ4 J_HELD
  send JW4 "select 'W:'||public.claim_kapso_event('$k','message','$P',$(inb $P wamid.jr4.$n $ph));"
  wait_blocked JW4 || fail "T-978-J4a" "claim not blocked"
  send JJ4 "commit;"; wait_out JW4 "W:"
  check "T-978-J4 a webhook claim that waited for the job gets duplicate; the event is processed exactly once" "$(grep -o 'W:[a-z_]*' $D/JW4.out)|$(st $k)|$(q "select count(*) from public.messages where wa_message_id='wamid.jr4.$n'")" "W:duplicate|processed/2/-/-|1"
  endsess JJ4; endsess JW4
  # J5: the job's v2 FAILURE path (finish_kapso_event) and a legacy kind (finish_webhook_event) behave as before
  local kv="kapso:msg:wamid.jr5.$n" km="meta:status.jr5.$n"
  sq "select public.claim_kapso_event('$kv','message','PN_NONE_$n',$(inb PN_NONE_$n wamid.jr5.$n 2033$(printf %09d $n))); select public.finish_kapso_event('$kv','failed','processing_error')" >/dev/null
  qa "insert into public.whatsapp_webhook_events (event_key, event_kind, phone_number_id, payload, status, attempts, last_error) values ('$km','status','PNID_ALPHA', jsonb_build_object('kind','status','waMessageId','wamid.none.$n','status','delivered','errorCode',null,'errorMessage',null), 'failed', 1, 'status.message_not_found')" >/dev/null
  sq "select public.process_webhook_retries(100, 8)" >/dev/null
  check "T-978-J5 v2 failure through the job: failed, stable code, payload kept; legacy Meta status: failed status.message_not_found (unchanged)" \
    "$(st $kv)|$(st $km)" "failed/2/kapso.unknown_account/kapso_inbound_v2|failed/2/status.message_not_found/status"
}

for t in "$@"; do case "$t" in claim) claim_finish;; held) held;; retries) retries;; jobs) concurrent_jobs;; crash) crash_windows;; protocol) protocol;;
  protect) protect;; terminal) terminal;; races) races;; retry978) retry978;; jobrace) jobrace;; esac; done
check "T-LOCK-7 invariant" "$(inv_company)" "0"
echo "---- summary: $(grep -c '^PASS' $RES) PASS, $(grep -c '^FAIL' $RES) FAIL, $(grep -c '^INFO' $RES) INFO"

#!/usr/bin/env bash
# DISPOSABLE DATABASES ONLY, from a separate client container (see README.md). Patch 979
# (supabase/proposed/20261104000979_kapso_echo_attribution_bsuid_send_guard.sql) and the BSUID database behaviour:
#   unknown   echoes of unknown customers (each origin separately, phone / BSUID / both, cloud_api retry) create NOTHING
#   known     echoes of known customers attach to the existing conversation: no contact / conversation / lead / identity change
#   bsuidconv echoes to a BSUID-only conversation (no promotion, no phone invented)
#   conflict  phone and BSUID point to different conversations, or a different value is already stored -> echo_identity_conflict
#   dup       duplicate echo deliveries and known-wamid status updates
#   cross     the same phone on another account is never used
#   retry     the retry job keeps an unattributed echo failed (stable code) and attaches it once the inbound exists
#   conc      concurrency: echo vs uncommitted inbound, two deliveries of one echo, a mixed burst
#   bsuid     BSUID intake (BSUID-only, BSUID+E.164, repeat, two accounts, duplicate, missing / malformed / conflicting identity,
#             unknown conversation) and the BSUID-only send refusal (direct insert, queue_outbound, controls)
#   sandbox   characterisation only: the sandbox (0960) echo path is unchanged by 979
# Deterministic: interleavings are driven by pg_stat_activity lock waits / session output, never by sleeps alone.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
SVC="select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);"
sq() { psql -X -q -tA -c "$SVC" -c "$1" 2>&1 | grep -v '^{"role"' | head -${2:-1}; }
L() { if [ -z "$1" ]; then echo null; else echo "'$1'"; fi; }
# run one statement; print its (first) value, or the stable error code it raised
r() { local o c; o=$(psql -X -q -tA -c "$1" 2>&1); c=$(printf '%s' "$o" | grep -oE 'ERROR: +(kapso|whatsapp|auth|conversation|message)\.[a-z_]+' | head -1 | sed 's/ERROR: *//');
      if [ -n "$c" ]; then echo "$c"; elif printf '%s' "$o" | grep -q ERROR; then printf '%s' "$o" | grep ERROR | head -1 | cut -c1-120; else printf '%s' "$o" | head -1; fi; }
# echo / status: ev PNID WAMID PHONE BSUID ORIGIN [RETRY] [STATUS]
ev() { echo "select public.apply_kapso_status_v2('$1','$2','${7:-sent}',null,null,$(L "$3"),$(L "$4"),'$5','text','echo body',null,now(),${6:-false});"; }
# inbound: ib PNID WAMID PHONE BSUID   -> prints o_duplicate
ib() { echo "select o_duplicate from public.ingest_kapso_inbound('$1','$2',$(L "$3"),$(L "$4"),null,'T','text','hi',null,now());"; }
bs() { echo "US.$(printf %020d $(next))"; }
snap() { q "select (select count(*) from public.contacts)||'/'||(select count(*) from public.conversations)||'/'||(select count(*) from public.contact_identities)||'/'||(select count(*) from public.contact_companies)||'/'||(select count(*) from public.leads)||'/'||(select count(*) from public.messages)||'/'||(select count(*) from public.audit_logs)"; }
msgs() { q "select count(*) from public.messages where wa_message_id='$1'"; }
conv_of() { q "select c.id from public.conversations c join public.whatsapp_accounts a on a.id=c.whatsapp_account_id where a.phone_number_id='$1' and ${3:-customer_wa_id}='$2'"; }
w() { echo "wamid.t8.$1.$(next)"; }

unknown() {
  local a P ph b s0 o wm
  for o in business_app other_app meta_business_agent; do
    a=$(mkacct); P=${a##*|}; ph=$(phone); b=$(bs); s0=$(snap)
    wm=$(w u); check "T-979-U1-$o unknown phone -> kapso.echo_unattributed" "$(r "$(ev $P $wm $ph '' $o)")" "kapso.echo_unattributed"
    check "T-979-U1-$o ...no contact / conversation / identity / link / lead / message / audit row" "$(snap)|$(msgs $wm)" "$s0|0"
    wm=$(w u); check "T-979-U2-$o unknown BSUID only -> unattributed, nothing written" "$(r "$(ev $P $wm '' $b $o)")|$(snap)" "kapso.echo_unattributed|$s0"
    wm=$(w u); check "T-979-U3-$o unknown phone + BSUID -> unattributed, nothing written" "$(r "$(ev $P $wm $ph $b $o)")|$(snap)" "kapso.echo_unattributed|$s0"
    check "T-979-U4-$o the account has no conversation at all" "$(q "select count(*) from public.conversations c join public.whatsapp_accounts a on a.id=c.whatsapp_account_id where a.phone_number_id='$P'")" "0"
  done
  a=$(mkacct); P=${a##*|}; ph=$(phone); s0=$(snap)
  wm=$(w u); check "T-979-U5 cloud_api first delivery, unknown wamid: false (unchanged, the API answer may be in flight)" "$(r "$(ev $P $wm $ph '' cloud_api false)")|$(snap)" "f|$s0"
  check "T-979-U6 cloud_api retry with no candidate, unknown customer -> unattributed, nothing written" "$(r "$(ev $P $wm $ph '' cloud_api true)")|$(snap)" "kapso.echo_unattributed|$s0"
  check "T-979-U7 no identity at all: false (unchanged)" "$(r "$(ev $P $(w u) '' '' business_app)")|$(snap)" "f|$s0"
}

known() {
  local a P ph c s0 o wm n0 l0
  a=$(mkacct); P=${a##*|}; ph=$(phone)
  r "$(ib $P $(w k) $ph '')" >/dev/null
  c=$(conv_of $P $ph); l0=$(q "select count(*) from public.leads where conversation_id='$c'")
  s0=$(snap); n0=$(q "select count(*) from public.messages where conversation_id='$c'")
  for o in business_app other_app meta_business_agent; do
    wm=$(w k)
    check "T-979-K1-$o known phone: applied" "$(r "$(ev $P $wm $ph '' $o)")" "t"
    check "T-979-K1-$o ...in THAT conversation, outbound, no employee, origin kept, status sent" \
      "$(q "select (conversation_id='$c')::text||'/'||direction||'/'||coalesce(sent_by::text,'null')||'/'||provider_origin||'/'||status from public.messages where wa_message_id='$wm'")" "true/outbound/null/$o/sent"
  done
  check "T-979-K2 only the 3 messages were added: no contact, conversation, identity, link, lead or audit row" "$(snap)" "$(echo "$s0" | awk -F/ -v OFS=/ '{$6=$6+3; print}')"
  check "T-979-K3 the conversation still has exactly its one lead" "$(q "select count(*) from public.leads where conversation_id='$c'")" "$l0"
  local b; b=$(bs); wm=$(w k)
  check "T-979-K4 known phone + a NEW BSUID: applied to the phone conversation" "$(r "$(ev $P $wm $ph $b business_app)")|$(q "select (conversation_id='$c')::text from public.messages where wa_message_id='$wm'")" "t|true"
  check "T-979-K4 ...the BSUID is NOT attached by an echo (no identity row, column stays NULL)" "$(q "select coalesce(customer_bsuid,'null') from public.conversations where id='$c'")|$(q "select count(*) from public.contact_identities where value='$b'")" "null|0"
  wm=$(w k); check "T-979-K5 cloud_api retry without a CRM candidate, known customer: recorded as an external send" \
    "$(r "$(ev $P $wm $ph '' cloud_api true)")|$(q "select provider_origin||'/'||coalesce(sent_by::text,'null') from public.messages where wa_message_id='$wm'")" "t|cloud_api/null"
}

bsuidconv() {
  local a P b c ph s0 wm
  a=$(mkacct); P=${a##*|}; b=$(bs); r "$(ib $P $(w b) '' $b)" >/dev/null; c=$(conv_of $P $b customer_bsuid)
  s0=$(snap)
  wm=$(w b); check "T-979-B1 BSUID-only conversation, echo with that BSUID: applied there" "$(r "$(ev $P $wm '' $b business_app)")|$(q "select (conversation_id='$c')::text from public.messages where wa_message_id='$wm'")" "t|true"
  ph=$(phone); wm=$(w b)
  check "T-979-B2 echo with that BSUID + a phone: applied to the BSUID conversation" "$(r "$(ev $P $wm $ph $b other_app)")|$(q "select (conversation_id='$c')::text from public.messages where wa_message_id='$wm'")" "t|true"
  check "T-979-B2 ...no promotion by an echo: customer_wa_id stays NULL, contact phone stays NULL" \
    "$(q "select coalesce(c.customer_wa_id,'null')||'/'||coalesce(k.phone_e164,'null') from public.conversations c join public.contacts k on k.id=c.contact_id where c.id='$c'")" "null/null"
  check "T-979-B3 the same phone alone is unknown to this account -> unattributed" "$(r "$(ev $P $(w b) $ph '' business_app)")" "kapso.echo_unattributed"
  check "T-979-B4 only 2 messages added" "$(snap)" "$(echo "$s0" | awk -F/ -v OFS=/ '{$6=$6+2; print}')"
}

conflict() {
  local a P p1 b1 p2 b2 b3 b4 p4 p5 s0
  a=$(mkacct); P=${a##*|}; p1=$(phone); b1=$(bs)
  r "$(ib $P $(w c) $p1 '')" >/dev/null; r "$(ib $P $(w c) '' $b1)" >/dev/null
  s0=$(snap)
  check "T-979-C1 phone -> conversation X, BSUID -> conversation Y: kapso.echo_identity_conflict, nothing written" "$(r "$(ev $P $(w c) $p1 $b1 business_app)")|$(snap)" "kapso.echo_identity_conflict|$s0"
  p2=$(phone); b2=$(bs); b3=$(bs); r "$(ib $P $(w c) $p2 $b2)" >/dev/null; s0=$(snap)
  check "T-979-C2 phone conversation already carries a DIFFERENT BSUID: conflict, nothing written" "$(r "$(ev $P $(w c) $p2 $b3 meta_business_agent)")|$(snap)" "kapso.echo_identity_conflict|$s0"
  check "T-979-C3 the same phone with the stored BSUID is fine" "$(r "$(ev $P $(w c) $p2 $b2 business_app)")" "t"
  b4=$(bs); p4=$(phone); p5=$(phone)
  r "$(ib $P $(w c) '' $b4)" >/dev/null; r "$(ib $P $(w c) $p4 $b4)" >/dev/null   # promotion: the BSUID conversation now has phone p4
  s0=$(snap)
  check "T-979-C4 BSUID conversation already carries a DIFFERENT phone: conflict, nothing written" "$(r "$(ev $P $(w c) $p5 $b4 other_app)")|$(snap)" "kapso.echo_identity_conflict|$s0"
}

dup() {
  local a P ph wm c
  a=$(mkacct); P=${a##*|}; ph=$(phone); r "$(ib $P $(w d) $ph '')" >/dev/null; wm=$(w d)
  check "T-979-D1 duplicate delivery of one echo: both applied, one message" "$(r "$(ev $P $wm $ph '' business_app)")|$(r "$(ev $P $wm $ph '' business_app)")|$(msgs $wm)" "t|t|1"
  check "T-979-D2 later statuses of a known wamid apply (identity no longer needed)" \
    "$(r "$(ev $P $wm '' '' business_app false delivered)")|$(r "$(ev $P $wm '' '' business_app false read)")|$(q "select status from public.messages where wa_message_id='$wm'")" "t|t|read"
  check "T-979-D3 ...a status of a known wamid from an UNKNOWN identity still applies (looked up by wamid first)" "$(r "$(ev $P $wm $(phone) '' cloud_api false read)")" "t"
}

cross() {
  local a b PA PB ph wm cA n0
  a=$(mkacct); PA=${a##*|}; b=$(mkacct); PB=${b##*|}; ph=$(phone)
  r "$(ib $PA $(w x) $ph '')" >/dev/null; cA=$(conv_of $PA $ph); n0=$(q "select count(*) from public.messages where conversation_id='$cA'")
  wm=$(w x)
  check "T-979-X1 phone known only on account A, echo on account B: unattributed" "$(r "$(ev $PB $wm $ph '' business_app)")" "kapso.echo_unattributed"
  check "T-979-X1 ...account B has no conversation, A's conversation is untouched" "$(q "select count(*) from public.conversations c join public.whatsapp_accounts x on x.id=c.whatsapp_account_id where x.phone_number_id='$PB'")|$(q "select count(*) from public.messages where conversation_id='$cA'")|$(msgs $wm)" "0|$n0|0"
}

retry() {
  local a P ph wm k s0
  a=$(mkacct); P=${a##*|}; ph=$(phone); wm=$(w r); k="kapso:status:$wm:sent"
  local pay="jsonb_build_object('kind','kapso_status_v2','eventKey','$k','phoneNumberId','$P','waMessageId','$wm','status','sent','toWaId','$ph','toBsuid',null,'origin','business_app','messageType','text','body','x','sentAt',now()::text,'errorCode',null,'errorMessage',null,'media',null)"
  sq "select public.claim_kapso_event('$k','status','$P',$pay); select public.finish_kapso_event('$k','failed','kapso.echo_unattributed')" >/dev/null
  s0=$(snap)
  sq "select public.process_webhook_retries(500, 8)" >/dev/null
  check "T-979-R1 retry job: unknown echo stays failed with the stable code, attempt counted, payload kept" \
    "$(q "select status||'/'||attempts||'/'||last_error||'/'||(payload->>'kind') from public.whatsapp_webhook_events where event_key='$k'")" "failed/2/kapso.echo_unattributed/kapso_status_v2"
  check "T-979-R1 ...and nothing was created" "$(snap)|$(msgs $wm)" "$s0|0"
  r "$(ib $P $(w r) $ph '')" >/dev/null
  sq "select public.process_webhook_retries(500, 8)" >/dev/null
  check "T-979-R2 once the customer's inbound exists, the retry attaches the echo there" \
    "$(q "select status from public.whatsapp_webhook_events where event_key='$k'")|$(q "select (m.conversation_id='$(conv_of $P $ph)')::text||'/'||m.provider_origin from public.messages m where m.wa_message_id='$wm'")" "processed|true/business_app"
  # attempt bound: an echo that never becomes attributable ends as a dead letter (failed, not selected again)
  local wm2 k2; wm2=$(w r); k2="kapso:status:$wm2:sent"
  sq "select public.claim_kapso_event('$k2','status','$P',$(echo "$pay" | sed "s/$wm/$wm2/g; s/'toWaId','$ph'/'toWaId','$(phone)'/")); select public.finish_kapso_event('$k2','failed','kapso.echo_unattributed')" >/dev/null
  q "update public.whatsapp_webhook_events set attempts=8 where event_key='$k2'" >/dev/null
  sq "select public.process_webhook_retries(500, 8)" >/dev/null
  check "T-979-R3 at the attempt bound the event is left alone (dead letter, retention deletes it after 30 days)" "$(q "select status||'/'||attempts||'/'||last_error from public.whatsapp_webhook_events where event_key='$k2'")" "failed/8/kapso.echo_unattributed"
}

conc() {
  local a P ph wm c s0
  # C1: an echo while the customer's FIRST inbound is still uncommitted: no wait, no creation; after the commit the echo attaches
  a=$(mkacct); P=${a##*|}; ph=$(phone)
  sess A; send A "begin; $(ib $P $(w cc) $ph '') select 'A-in';"; wait_out A "A-in" || fail "T-979-CC1" "A did not ingest"
  wm=$(w cc)
  check "T-979-CC1 echo during the uncommitted inbound: unattributed immediately (never blocked, nothing created)" "$(r "$(ev $P $wm $ph '' business_app)")|$(msgs $wm)" "kapso.echo_unattributed|0"
  send A "commit; select 'A-done';"; wait_out A "A-done"; endsess A
  check "T-979-CC1 ...after the commit the redelivered echo attaches; still exactly one conversation for the phone" \
    "$(r "$(ev $P $wm $ph '' business_app)")|$(q "select count(*) from public.conversations c join public.whatsapp_accounts x on x.id=c.whatsapp_account_id where x.phone_number_id='$P' and c.customer_wa_id='$ph'")|$(msgs $wm)" "t|1|1"
  # C2: two deliveries of the same echo at once for a known customer: the second waits on the wamid, then is a no-op
  ph=$(phone); r "$(ib $P $(w cc) $ph '')" >/dev/null; wm=$(w cc)
  sess E1; sess E2
  send E1 "begin; $(ev $P $wm $ph '' business_app) select 'E1-in';"; wait_out E1 "E1-in" || fail "T-979-CC2" "E1 did not run"
  send E2 "$(ev $P $wm $ph '' business_app) select 'E2-done';"
  if wait_blocked E2; then pass "T-979-CC2 the concurrent duplicate waits behind the first insert of the wamid"; else fail "T-979-CC2" "E2 not blocked"; fi
  send E1 "commit; select 'E1-done';"; wait_out E1 "E1-done"; wait_out E2 "E2-done"
  endsess E1; endsess E2
  check "T-979-CC2 ...then both applied, exactly one message, no error" "$(grep -cE '^ *t *$' $D/E2.out)|$(msgs $wm)|$(grep -c ERROR $D/E1.out $D/E2.out | awk -F: '{s+=$2} END {print s}')" "1|1|0"
  # C3: mixed burst on one account: 10 new customers write in while 30 echoes run (10 to known, 10 to unknown, 10 to the arriving customers)
  a=$(mkacct); P=${a##*|}
  local known=() news=() unk=() i
  for i in $(seq 1 10); do ph=$(phone); r "$(ib $P $(w cc) $ph '')" >/dev/null; known+=("$ph"); news+=("$(phone)"); unk+=("$(phone)"); done
  s0=$(snap)
  local f="$D/burst.sql"; : > "$f"
  for i in $(seq 0 9); do
    echo "$(ib $P wamid.t8.burst.in.$i.$P ${news[$i]} '')" >> "$f"
    echo "$(ev $P wamid.t8.burst.k.$i.$P ${known[$i]} '' business_app)" >> "$f"
    echo "$(ev $P wamid.t8.burst.u.$i.$P ${unk[$i]} '' other_app)" >> "$f"
    echo "$(ev $P wamid.t8.burst.n.$i.$P ${news[$i]} '' meta_business_agent)" >> "$f"
  done
  shuf "$f" > "$f.s"; split -n l/8 "$f.s" "$D/burst."
  for x in "$D"/burst.a?; do psql -X -q -tA -v ON_ERROR_STOP=0 -f "$x" > "$x.out" 2>&1 & done; wait
  check "T-979-CC3 no deadlock / serialization failure" "$(cat "$D"/burst.a?.out | grep -cE 'deadlock|40P01|40001|could not serialize')" "0"
  check "T-979-CC3 echoes to the 10 unknown customers wrote nothing" "$(q "select count(*) from public.messages where wa_message_id like 'wamid.t8.burst.u.%.$P'")" "0"
  check "T-979-CC3 echoes to the 10 known customers all attached" "$(q "select count(*) from public.messages where wa_message_id like 'wamid.t8.burst.k.%.$P' and sent_by is null")" "10"
  check "T-979-CC3 exactly the 10 new conversations, contacts and leads of the 10 inbound messages were created" \
    "$(q "select count(*) from public.conversations c join public.whatsapp_accounts x on x.id=c.whatsapp_account_id where x.phone_number_id='$P'")|$(echo "$s0|$(snap)" | awk -F'[/|]' '{print ($8-$1)"/"($12-$5)}')" "20|10/10"
  info "T-979-CC3 echoes to arriving customers: $(q "select count(*) from public.messages where wa_message_id like 'wamid.t8.burst.n.%.$P'") of 10 attached in this run (the rest raised unattributed and would be retried); unattributed: $(cat "$D"/burst.a?.out | grep -c 'kapso.echo_unattributed')"
}

bsuid() {
  local a b PA PB b1 b2 ph c1 c2 s0 wm k1 k2
  a=$(mkacct); PA=${a##*|}; b=$(mkacct); PB=${b##*|}; b1=$(bs)
  check "T-BS-1 BSUID-only inbound processed" "$(r "$(ib $PA $(w s) '' $b1)")" "f"
  c1=$(conv_of $PA $b1 customer_bsuid)
  check "T-BS-1 ...conversation without phone, contact without phone, one account-scoped identity, automatic lead" \
    "$(q "select coalesce(c.customer_wa_id,'null')||'/'||coalesce(k.phone_e164,'null')||'/'||(select count(*) from public.contact_identities i where i.value='$b1' and i.whatsapp_account_id=c.whatsapp_account_id and i.contact_id=k.id)||'/'||(select count(*) from public.leads l where l.conversation_id=c.id) from public.conversations c join public.contacts k on k.id=c.contact_id where c.id='$c1'")" "null/null/1/1"
  s0=$(snap)
  check "T-BS-2 the same BSUID again (new message, same account): same conversation, only the message added" "$(r "$(ib $PA $(w s) '' $b1)")|$(conv_of $PA $b1 customer_bsuid)|$(snap)" "f|$c1|$(echo "$s0" | awk -F/ -v OFS=/ '{$6=$6+1; print}')"
  r "$(ib $PB $(w s) '' $b1)" >/dev/null; c2=$(conv_of $PB $b1 customer_bsuid)
  check "T-BS-3 the same BSUID on another account: its own conversation AND its own contact (never merged across accounts)" \
    "$([ -n "$c2" ] && [ "$c2" != "$c1" ] && echo distinct)|$(q "select count(distinct contact_id) from public.conversations where id in ('$c1','$c2')")|$(q "select count(*) from public.contact_identities where value='$b1'")" "distinct|2|2"
  wm=$(w s)
  check "T-BS-4 duplicate delivery of a BSUID-only message: duplicate, one message" "$(r "$(ib $PA $wm '' $b1)")|$(r "$(ib $PA $wm '' $b1)")|$(msgs $wm)" "f|t|1"
  b2=$(bs); ph=$(phone)
  r "$(ib $PA $(w s) $ph $b2)" >/dev/null
  check "T-BS-5 BSUID + E.164: one conversation with both, contact phone = +E.164 of the PHONE field, identity row" \
    "$(q "select c.customer_wa_id||'/'||c.customer_bsuid||'/'||k.phone_e164||'/'||(select count(*) from public.contact_identities i where i.value='$b2') from public.conversations c join public.contacts k on k.id=c.contact_id where c.customer_bsuid='$b2'")" "$ph/$b2/+$ph/1"
  s0=$(snap)
  check "T-BS-6 missing identity -> whatsapp.invalid_payload, nothing written" "$(r "$(ib $PA $(w s) '' '')")|$(snap)" "whatsapp.invalid_payload|$s0"
  check "T-BS-7 malformed BSUID -> whatsapp.invalid_payload, nothing written" "$(r "select o_duplicate from public.ingest_kapso_inbound('$PA','$(w s)',null,'has space',null,'T','text','hi',null,now());")|$(snap)" "whatsapp.invalid_payload|$s0"
  # conflicting identity on intake: phone -> X, BSUID -> Y. Phone wins, nothing is merged, a human gets an audit row.
  local p3 b3 x y; p3=$(phone); b3=$(bs); r "$(ib $PA $(w s) $p3 '')" >/dev/null; r "$(ib $PA $(w s) '' $b3)" >/dev/null
  x=$(conv_of $PA $p3); y=$(conv_of $PA $b3 customer_bsuid); wm=$(w s)
  r "$(ib $PA $wm $p3 $b3)" >/dev/null
  check "T-BS-8 conflicting identity on intake: message in the phone conversation, both conversations unchanged, audit row" \
    "$(q "select (conversation_id='$x')::text from public.messages where wa_message_id='$wm'")|$(q "select coalesce(customer_bsuid,'null') from public.conversations where id='$x'")|$(q "select coalesce(customer_wa_id,'null') from public.conversations where id='$y'")|$(q "select count(*) from public.audit_logs where action='conversation.identity_conflict' and entity_id='$x'")" "true|null|null|1"
  s0=$(snap)
  check "T-BS-9 status for an unknown wamid with only a BSUID (first delivery): false, nothing written" "$(r "$(ev $PA $(w s) '' $(bs) cloud_api false)")|$(snap)" "f|$s0"
  # ---- BSUID-only send refusal
  local super; super=$(q "select id from tests.users where key='super'")
  check "T-BS-10 employee send to a BSUID-only conversation (direct insert) -> whatsapp.recipient_phone_unknown" \
    "$(r "insert into public.messages (conversation_id, direction, message_type, body, status, sent_by) values ('$c1','outbound','text','x','queued','$super')")" "whatsapp.recipient_phone_unknown"
  check "T-BS-11 ...through queue_outbound as a super admin (the real send path) -> same refusal, nothing queued" \
    "$(r "select tests.login('super'); select message_id from public.queue_outbound('$c1', gen_random_uuid(), 'text', 'hello');" | tail -1)|$(snap)" "whatsapp.recipient_phone_unknown|$s0"
  check "T-BS-12 control: the phone conversation of the same account is refused for the 970 reason (outbound disabled), not by 979" \
    "$(r "insert into public.messages (conversation_id, direction, message_type, body, status, sent_by) values ('$x','outbound','text','x','queued','$super')")" "whatsapp.outbound_disabled"
  check "T-BS-13 an echo (no employee) into the BSUID-only conversation is allowed" "$(r "$(ev $PA $(w s) '' $b1 business_app)")" "t"
  local mc; mc=$(q "select count(*) from public.conversations c join public.whatsapp_accounts x on x.id=c.whatsapp_account_id where c.customer_wa_id is null and x.provider <> 'kapso'")
  check "T-BS-14 no non-Kapso conversation lacks a phone (the provider-independent refusal cannot hit Meta numbers)" "$mc" "0"
  # independence from outbound_enabled: a scratch account with outbound enabled still refuses the BSUID-only conversation
  local o Po bo co po cp en
  o=$(mkacct); Po=${o##*|}; bo=$(bs); po=$(phone); r "$(ib $Po $(w s) '' $bo)" >/dev/null; r "$(ib $Po $(w s) $po '')" >/dev/null
  co=$(conv_of $Po $bo customer_bsuid); cp=$(conv_of $Po $po)
  en=$(r "update public.whatsapp_accounts set outbound_enabled = true, status = 'active' where phone_number_id='$Po' returning outbound_enabled")
  if [ "$en" = "t" ]; then
    check "T-BS-15 outbound ENABLED: BSUID-only conversation still refused; the phone conversation passes the guard" \
      "$(r "insert into public.messages (conversation_id, direction, message_type, body, status, sent_by) values ('$co','outbound','text','x','queued','$super')")|$(r "begin; insert into public.messages (conversation_id, direction, message_type, body, status, sent_by) values ('$cp','outbound','text','x','queued','$super') returning 'inserted'; rollback;")" \
      "whatsapp.recipient_phone_unknown|inserted"
  else info "T-BS-15 outbound_enabled could not be set on a scratch account ($en): independence covered by the guard order (979 check runs first)"; fi
}

sandbox() {
  local sb ph wm s0
  sb=$(q "select a.phone_number_id from public.whatsapp_accounts a where a.provider='kapso' and a.environment='sandbox' and a.status='active' limit 1")
  if [ -z "$sb" ]; then info "T-979-S1 no active sandbox account in this database: skipped"; return; fi
  ph=$(phone); wm=$(w sb); s0=$(snap)
  info "T-979-S1 sandbox account, unknown phone echo (0960 path, unchanged by 979): result=$(r "$(ev $sb $wm $ph '' business_app)") snapshot $s0 -> $(snap)"
}

for t in "$@"; do case "$t" in unknown) unknown;; known) known;; bsuidconv) bsuidconv;; conflict) conflict;; dup) dup;; cross) cross;;
  retry) retry;; conc) conc;; bsuid) bsuid;; sandbox) sandbox;; esac; done
check "T-LOCK-7 invariant" "$(inv_company)" "0"
echo "---- summary: $(grep -c '^PASS' $RES) PASS, $(grep -c '^FAIL' $RES) FAIL, $(grep -c '^INFO' $RES) INFO"

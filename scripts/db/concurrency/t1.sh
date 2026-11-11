#!/usr/bin/env bash
# SCRATCH ONLY. Concurrency tests part 1: T-LOCK-4a, 4b, 5, 14, T-DUP-3, T-DUP-7 (characterisation), T-REC-2a/2b/2c/3a/3b.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# ------------------------------------------------------------------------------------------------------- T-LOCK-4a
t4a() {
  local a ACC P ph; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph=$(phone)
  sess A4a; sess W4a
  send A4a "begin; update public.whatsapp_accounts set default_company_id='$BETA' where id='$ACC'; select pg_sleep(2);"
  sleep 0.4; send W4a "begin; $(hook $P wamid.4a.$ACC $ph)"
  wait_blocked W4a || { fail "T-LOCK-4a" "webhook never blocked"; return; }
  [ "$(blockers W4a)" = "$(pid_of A4a)" ] && pass "T-LOCK-4a-1 webhook (creator) is blocked by the open account update (multi-statement txn that already passed the guard)" || fail "T-LOCK-4a-1" "blockers=$(blockers W4a) A=$(pid_of A4a)"
  send A4a "commit;"; wait_unblocked W4a; send W4a "commit;"; sleep 0.5; endsess A4a; endsess W4a
  check "T-LOCK-4a-2 the conversation was created under the NEW company" "$(q "select company_id from public.conversations where whatsapp_account_id='$ACC'")" "$BETA"
  check "T-LOCK-4a-3 contact link + lead follow the new company" "$(q "select (select count(*) from public.contact_companies cc join public.contacts k on k.id=cc.contact_id where k.phone_e164='+$ph' and cc.company_id='$BETA')||'/'||(select count(*) from public.leads l join public.conversations c on c.id=l.conversation_id where c.whatsapp_account_id='$ACC' and l.company_id='$BETA')||'/'||(select count(*) from public.contact_companies cc join public.contacts k on k.id=cc.contact_id where k.phone_e164='+$ph' and cc.company_id<>'$BETA')")" "1/1/0"
}
# ------------------------------------------------------------------------------------------------------- T-LOCK-4b
t4b() {
  local a ACC P ph; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph=$(phone)
  sess A4b; sess X4b
  send A4b "begin; update public.whatsapp_accounts set default_company_id='$BETA' where id='$ACC';"
  sleep 0.4; send X4b "select * from public.ingest_whatsapp_message('$P','wamid.4b.$ACC','$ph','Meta route','text','hi',null,now());"
  wait_blocked X4b || { fail "T-LOCK-4b" "Meta-route intake never blocked"; return; }
  pass "T-LOCK-4b-1 an UNLOCKED creator (Meta intake naming a Kapso production id) blocks in the conversation trigger while the account update is open"
  send A4b "commit;"; wait_unblocked X4b; sleep 0.5; endsess A4b; endsess X4b
  grep -q "conversation.account_company_mismatch" "$D/X4b.out" && pass "T-LOCK-4b-2 after the update commits the trigger re-reads the NEW company and refuses" || fail "T-LOCK-4b-2" "$(head -c 300 $D/X4b.out)"
  check "T-LOCK-4b-3 nothing created: conversations / contacts / links" "$(q "select (select count(*) from public.conversations where whatsapp_account_id='$ACC')||'/'||(select count(*) from public.contacts where phone_e164='+$ph')")" "0/0"
}
# ------------------------------------------------------------------------------------------------------- T-LOCK-5 (20 simultaneous first events)
t5() {
  local a ACC P; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}
  cat > "$D/t5.pgb" <<EOF
\set k :client_id % 20
select * from public.ingest_kapso_inbound('$P', case when :k < 10 then 'wamid.l5.$ACC.p' || :k when :k < 15 then 'wamid.l5.$ACC.b' || :k else 'wamid.l5.$ACC.dup' end, case when :k < 10 then '2010060' || lpad(:k::text, 5, '0') when :k < 15 then null else '2010060999999' end, case when :k between 10 and 14 then 'BS-L5-$ACC-' || :k else null end, null, 'T5', 'text', 'hi', null, now());
EOF
  PGAPPNAME=webhook pgbench -n -f "$D/t5.pgb" -c 20 -j 20 -t 1 > "$D/t5.out" 2>&1
  local failed; failed=$(grep -o "number of failed transactions: [0-9]*" "$D/t5.out" | grep -o '[0-9]*$'); info "T-LOCK-5 pgbench: $(grep -E 'number of transactions actually processed|number of failed' $D/t5.out | tr '\n' ' ')"
  check "T-LOCK-5a no failed transaction among 20 simultaneous first events" "${failed:-?}" "0"
  check "T-LOCK-5b exactly one conversation per customer (10 phone + 5 bsuid + 1 duplicated customer = 16) and 16 messages" "$(q "select (select count(*) from public.conversations where whatsapp_account_id='$ACC')||'/'||(select count(*) from public.messages m join public.conversations c on c.id=m.conversation_id where c.whatsapp_account_id='$ACC')")" "16/16"
  check "T-LOCK-5c all conversations under the account's company" "$(q "select count(*) from public.conversations where whatsapp_account_id='$ACC' and company_id<>'$ALPHA'")" "0"
  check "T-LOCK-5d one contact for the 5 duplicate deliveries" "$(q "select count(*) from public.contacts where phone_e164='+2010060999999'")" "1"
  check "T-LOCK-7 invariant after T-LOCK-5 (no production conversation under a company different from its account)" "$(inv_company)" "0"
}
# ------------------------------------------------------------------------------------------------------- T-LOCK-14 (Meta takes no lock; Kapso does)
t14() {
  local a ACC P ph; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph=$(phone)
  sess X14m; send X14m "begin; select * from public.ingest_whatsapp_message('PNID_ALPHA','wamid.14m.$ph','$ph','M','text','hi',null,now());"; sleep 0.6
  local r1; r1=$(psql -X -q -tA -c "set lock_timeout='1500ms'; select count(*) from (select 1 from public.whatsapp_accounts where phone_number_id='PNID_ALPHA' for no key update nowait) s" 2>&1 | tr '\n' ' ')
  endsess X14m
  [[ "$r1" == *"1"* && "$r1" != *"could not obtain"* ]] && pass "T-LOCK-14a Meta intake holds NO lock on its account row (a NOWAIT writer probe succeeds while the intake transaction is open)" "$r1" || fail "T-LOCK-14a" "$r1"
  sess X14k; send X14k "begin; $(hook $P wamid.14k.$ph $ph)"; sleep 0.6
  local r2; r2=$(psql -X -q -tA -c "select count(*) from (select 1 from public.whatsapp_accounts where id='$ACC' for no key update nowait) s" 2>&1 | tr '\n' ' ')
  endsess X14k
  [[ "$r2" == *"could not obtain lock"* ]] && pass "T-LOCK-14b a Kapso production webhook DOES hold the account row lock (NOWAIT writer probe fails: could not obtain lock)" || fail "T-LOCK-14b" "$r2"
  local r3; r3=$(psql -X -q -tA -c "select count(*) from (select 1 from public.whatsapp_accounts where id='$ACC' for no key update nowait) s" 2>&1 | tr '\n' ' '); [[ "$r3" == *"1"* ]] && pass "T-LOCK-14c ... and the lock is released at commit/end of the transaction" || fail "T-LOCK-14c" "$r3"
}
# ------------------------------------------------------------------------------------------------------- pair consistency helper
# pairs_ok OUTFILE EXPECTED_ACCOUNT_ID : every (o_message_id, o_conversation_id) printed in OUTFILE exists as ONE row of EXPECTED account
pairs_ok() {
  local f=$1 acc=$2 bad=0 line mid cid
  while read -r line; do
    mid=$(echo "$line" | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | sed -n 1p); cid=$(echo "$line" | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | sed -n 2p)
    [ -z "$mid" ] && continue
    [ "$(q "select count(*) from public.messages m join public.conversations c on c.id=m.conversation_id where m.id='$mid' and c.id='$cid' and c.whatsapp_account_id='$acc'")" = "1" ] || bad=$((bad+1))
  done < <(grep -E '^[ ]*[0-9a-f]{8}-' "$f")
  echo $bad
}
# ------------------------------------------------------------------------------------------------------- T-DUP-3 (same wamid, two accounts, simultaneous)
tdup3() {
  local iters=${1:-30} wins_a=0 wins_b=0 bad=0 pairbad=0 both=0 none=0 i
  local a b ACCA PA ACCB PB; a=$(mkacct); ACCA=${a%%|*}; PA=${a##*|}; b=$(mkacct); ACCB=${b%%|*}; PB=${b##*|}
  for i in $(seq 1 $iters); do
    local W="wamid.dup3.$(next)" pha phb; pha=$(phone); phb=$(phone)
    sess GB; sess SA; sess SB
    send GB "select pg_advisory_lock(8800);"; sleep 0.1
    if [ $((RANDOM % 2)) = 0 ]; then
      send SA "select pg_advisory_lock_shared(8800); $(hook $PA $W $pha) select pg_advisory_unlock_all();"; send SB "select pg_advisory_lock_shared(8800); $(hook $PB $W $phb) select pg_advisory_unlock_all();"
    else
      send SB "select pg_advisory_lock_shared(8800); $(hook $PB $W $phb) select pg_advisory_unlock_all();"; send SA "select pg_advisory_lock_shared(8800); $(hook $PA $W $pha) select pg_advisory_unlock_all();"
    fi
    for _ in $(seq 1 100); do [ "$(q "select count(*) from pg_stat_activity where application_name in ('SA','SB') and wait_event_type='Lock'")" = "2" ] && break; sleep 0.05; done
    send GB "select pg_advisory_unlock_all();"
    wait_out SA "unlock_all" ; wait_out SB "unlock_all"; sleep 0.1
    endsess GB; endsess SA; endsess SB
    local okA okB; okA=$(grep -c "o_duplicate" "$D/SA.out"); okB=$(grep -c "o_duplicate" "$D/SB.out")
    local mA mB; mA=$(grep -c "kapso.message_account_mismatch" "$D/SA.out"); mB=$(grep -c "kapso.message_account_mismatch" "$D/SB.out")
    local rows owner; rows=$(q "select count(*) from public.messages where wa_message_id='$W'"); owner=$(q "select c.whatsapp_account_id from public.messages m join public.conversations c on c.id=m.conversation_id where m.wa_message_id='$W'")
    [ "$rows" = "1" ] || bad=$((bad+1))
    if [ "$owner" = "$ACCA" ]; then wins_a=$((wins_a+1)); [ "$mB" = "1" ] || bad=$((bad+1)); pairbad=$((pairbad + $(pairs_ok $D/SA.out $ACCA)))
    elif [ "$owner" = "$ACCB" ]; then wins_b=$((wins_b+1)); [ "$mA" = "1" ] || bad=$((bad+1)); pairbad=$((pairbad + $(pairs_ok $D/SB.out $ACCB)))
    else none=$((none+1)); bad=$((bad+1)); fi
    # the loser created nothing: its phone has no contact / conversation under the loser account
    local loserph loseracc; if [ "$owner" = "$ACCA" ]; then loserph=$phb; loseracc=$ACCB; else loserph=$pha; loseracc=$ACCA; fi
    [ "$(q "select (select count(*) from public.conversations where whatsapp_account_id='$loseracc' and customer_wa_id='$loserph')+(select count(*) from public.contacts where phone_e164='+$loserph')")" = "0" ] || bad=$((bad+1))
    rm -f "$D"/SA.* "$D"/SB.* "$D"/GB.*
  done
  info "T-DUP-3 $iters iterations: account A won $wins_a, account B won $wins_b, anomalies $bad, inconsistent returned pairs $pairbad"
  [ "$bad" = "0" ] && [ "$pairbad" = "0" ] && pass "T-DUP-3 same wamid delivered to two accounts simultaneously ($iters runs): exactly one row, loser refused with kapso.message_account_mismatch, loser created no contact/conversation, every returned pair consistent" || fail "T-DUP-3" "anomalies=$bad pairbad=$pairbad"
  [ "$wins_a" -gt 0 ] && [ "$wins_b" -gt 0 ] && pass "T-DUP-3b both outcomes (A wins / B wins) occurred" || info "T-DUP-3b only one side won ($wins_a/$wins_b): interleaving not varied enough"
  check "T-LOCK-7 invariant after T-DUP-3" "$(inv_company)" "0"
}
# ------------------------------------------------------------------------------------------------------- T-DUP-7 characterisation (sandbox wrapper path)
hook7() { if [ "${HOOK7:-new}" = old ]; then echo "select * from public.ingest_kapso_message('$1','$2','$3','T','text','hi',null,now());"; else hook "$1" "$2" "$3"; fi; }
tdup7() {
  local iters=${1:-30} i mism=0 both=0 pairbad=0
  # two sandbox accounts (sandbox companies) via the legacy insert form
  local n; n=$(next); local sc1 sc2
  sc1=$(q "insert into public.companies (name, slug, timezone, currency, is_sandbox) values ('SbxD$n','sbxd$n','Asia/Qatar','QAR',true) returning id"); n=$(next)
  sc2=$(q "insert into public.companies (name, slug, timezone, currency, is_sandbox) values ('SbxE$n','sbxe$n','Asia/Qatar','QAR',true) returning id")
  local x1 x2 acc1 acc2 p1 p2; n=$(next); p1="SBXDUP_$n"; acc1=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status) values ('$sc1','sd1','+1555$(printf %07d $n)','$p1','kapso',true,'test') returning id")
  n=$(next); p2="SBXDUP_$n"; acc2=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status) values ('$sc2','sd2','+1555$(printf %07d $n)','$p2','kapso',true,'test') returning id")
  for i in $(seq 1 $iters); do
    local W="wamid.dup7.$(next)" pha phb; pha=$(phone); phb=$(phone)
    sess GB; sess SA; sess SB
    send GB "select pg_advisory_lock(8801);"; sleep 0.1
    send SA "select pg_advisory_lock_shared(8801); $(hook7 $p1 $W $pha) select pg_advisory_unlock_all();"; send SB "select pg_advisory_lock_shared(8801); $(hook7 $p2 $W $phb) select pg_advisory_unlock_all();"
    for _ in $(seq 1 100); do [ "$(q "select count(*) from pg_stat_activity where application_name in ('SA','SB') and wait_event_type='Lock'")" = "2" ] && break; sleep 0.05; done
    send GB "select pg_advisory_unlock_all();"; wait_out SA "unlock_all"; wait_out SB "unlock_all"; sleep 0.1; endsess GB; endsess SA; endsess SB
    local okA okB; okA=$(grep -cE '^ *[0-9a-f]{8}-[0-9a-f-]{27} *\|' "$D/SA.out"); okB=$(grep -cE '^ *[0-9a-f]{8}-[0-9a-f-]{27} *\|' "$D/SB.out")
    [ "$(grep -c "kapso.message_account_mismatch" "$D/SA.out")$(grep -c "kapso.message_account_mismatch" "$D/SB.out")" != "00" ] && mism=$((mism+1))
    [ "$okA" = "1" ] && [ "$okB" = "1" ] && both=$((both+1))
    pairbad=$((pairbad + $(pairs_ok $D/SA.out $acc1) + $(pairs_ok $D/SB.out $acc2)))
    rm -f "$D"/SA.* "$D"/SB.* "$D"/GB.*
  done
  info "T-DUP-7 (CHARACTERISATION, sandbox wrapper, decision D1) $iters runs: one side refused with mismatch in $mism runs, BOTH sides returned a row in $both runs, inconsistent returned (message,conversation) pairs: $pairbad"
}
# ------------------------------------------------------------------------------------------------------- T-REC choreography
AGENT=$(q "select id from tests.users where key='agent_a1'")
rec_setup() {  # prints "ACC|PNID|PHONE|BODY|M"   (production account, active, outbound on, conversation, one queued CRM message)
  local a ACC P ph body M; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph=$(phone); body="crm body $(next)"
  q "update public.whatsapp_accounts set status='active' where id='$ACC'" >/dev/null; q "update public.whatsapp_accounts set outbound_enabled=true where id='$ACC'" >/dev/null
  q "insert into public.whatsapp_account_access (whatsapp_account_id, user_id, can_reply) values ('$ACC','$AGENT',true)" >/dev/null
  qa "$(hook $P wamid.recin.$ACC $ph)" >/dev/null
  local conv; conv=$(q "select id from public.conversations where whatsapp_account_id='$ACC'")
  M=$(psql -X -q -tA -c "select set_config('request.jwt.claims','{\"sub\":\"$AGENT\",\"role\":\"authenticated\"}',false)" -c "set role authenticated" -c "select message_id from public.queue_outbound('$conv', gen_random_uuid(), 'text', '$body')" 2>&1 | grep -E '^[0-9a-f]{8}-' | head -1)
  echo "$ACC|$P|$ph|$body|$M"
}
apply_sql() { echo "select public.apply_kapso_status_v2('$1','$2','sent',null,null,'$3',null,'cloud_api','text','$4',null,now(),false);"; }   # PNID WAMID PHONE BODY
trec() {
  local s ACC P ph body M W
  # ---- 2a: the CRM's own record_outbound_result wins the row (same wamid)
  s=$(rec_setup); IFS='|' read -r ACC P ph body M <<<"$s"; W="wamid.rec2a.$ACC"
  sess S0; sess AP; send S0 "begin; select public.record_outbound_result('$M', '$W');"; sleep 0.3
  send AP "$(apply_sql $P $W $ph "$body")"
  wait_blocked AP && pass "T-REC-2a-1 the status handler blocks on the candidate row while record_outbound_result holds it" || fail "T-REC-2a-1" "not blocked"
  send S0 "commit;"; wait_unblocked AP; sleep 0.3; endsess S0; endsess AP
  check "T-REC-2a-2 zero-row UPDATE (same wamid recorded concurrently): handler returns true, status applied once" "$(grep -E '^ ?[tf]$' $D/AP.out | tr -d ' ')" "t"
  check "T-REC-2a-3 still ONE message row for the wamid, status sent, employee kept" "$(q "select count(*)||'/'||max(status::text)||'/'||(max(sent_by::text)='$AGENT')::text from public.messages where wa_message_id='$W'")" "1/sent/true"
  # ---- 2b: the CRM recorded a DIFFERENT wamid
  s=$(rec_setup); IFS='|' read -r ACC P ph body M <<<"$s"; W="wamid.rec2b.$ACC"
  sess S0b; sess APb; send S0b "begin; select public.record_outbound_result('$M', 'wamid.rec2b.other.$ACC');"; sleep 0.3
  send APb "$(apply_sql $P $W $ph "$body")"; wait_blocked APb || fail "T-REC-2b-1" "not blocked"
  send S0b "commit;"; wait_unblocked APb; sleep 0.3; endsess S0b; endsess APb
  check "T-REC-2b-1 candidate got a different wamid: handler returns false (retry-safe)" "$(grep -E '^ ?[tf]$' $D/APb.out | tr -d ' ')" "f"
  check "T-REC-2b-2 nothing applied: no row carries the handler's wamid; candidate carries only its own" "$(q "select (select count(*) from public.messages where wa_message_id='$W')||'/'||(select wa_message_id from public.messages where id='$M')")" "0/wamid.rec2b.other.$ACC"
  # ---- 2c: candidate deleted
  s=$(rec_setup); IFS='|' read -r ACC P ph body M <<<"$s"; W="wamid.rec2c.$ACC"
  sess S0c; sess APc; send S0c "begin; delete from public.messages where id='$M';"; sleep 0.3
  send APc "$(apply_sql $P $W $ph "$body")"; wait_blocked APc || fail "T-REC-2c-1" "not blocked"
  send S0c "commit;"; wait_unblocked APc; sleep 0.3; endsess S0c; endsess APc
  check "T-REC-2c candidate disappeared before the UPDATE: returns false, nothing applied" "$(grep -E '^ ?[tf]$' $D/APc.out | tr -d ' ')/$(q "select count(*) from public.messages where wa_message_id='$W'")" "f/0"
  # ---- 3a: another account commits the wamid between the candidate query and the UPDATE
  local b BACC BP bph; s=$(rec_setup); IFS='|' read -r ACC P ph body M <<<"$s"; W="wamid.rec3a.$ACC"
  b=$(mkacct "$BETA"); BACC=${b%%|*}; BP=${b##*|}; bph=$(phone)
  local bsnap1; sess S0d; sess APd; send S0d "begin; select 1 from public.messages where id='$M' for update;"; sleep 0.3
  send APd "$(apply_sql $P $W $ph "$body")"; wait_blocked APd || fail "T-REC-3a-1" "not blocked"
  qa "$(hook $BP $W $bph)" >/dev/null                                               # B wins the wamid (committed)
  bsnap1=$(q "select status::text||'/'||body||'/'||coalesce(status_updated_at::text,'null') from public.messages where wa_message_id='$W'")
  send S0d "rollback;"; wait_unblocked APd; sleep 0.3; endsess S0d; endsess APd
  grep -q "kapso.message_account_mismatch" "$D/APd.out" && pass "T-REC-3a-2 another account won the wamid: unique violation absorbed, domain error kapso.message_account_mismatch" || fail "T-REC-3a-2" "$(head -c 300 $D/APd.out)"
  check "T-REC-3a-3 candidate still queued with NULL wamid" "$(q "select status::text||'/'||coalesce(wa_message_id,'-') from public.messages where id='$M'")" "queued/-"
  check "T-REC-3a-4 B's row is unchanged (status/body/status_updated_at) and B owns the wamid" "$(q "select (status::text||'/'||body||'/'||coalesce(status_updated_at::text,'null') = '$bsnap1')::text||'/'||(select count(*) from public.messages m join public.conversations c on c.id=m.conversation_id where m.wa_message_id='$W' and c.whatsapp_account_id='$BACC')::text from public.messages where wa_message_id='$W'")" "true/1"
  # ---- 3b: B inserts the wamid in an OPEN transaction; the handler waits on the unique index
  for variant in commit rollback; do
    s=$(rec_setup); IFS='|' read -r ACC P ph body M <<<"$s"; W="wamid.rec3b$variant.$ACC"
    b=$(mkacct "$BETA"); BACC=${b%%|*}; BP=${b##*|}; bph=$(phone)
    sess SB3; sess AP3; send SB3 "begin; $(hook $BP $W $bph)"; sleep 0.4
    send AP3 "$(apply_sql $P $W $ph "$body")"; wait_blocked AP3 && pass "T-REC-3b-$variant-1 handler waits on the unique index behind B's in-flight insert" || fail "T-REC-3b-$variant-1" "not blocked"
    send SB3 "$variant;"; wait_unblocked AP3; sleep 0.3; endsess SB3; endsess AP3
    if [ $variant = commit ]; then
      grep -q "kapso.message_account_mismatch" "$D/AP3.out" && pass "T-REC-3b-commit-2 B committed first: refused with kapso.message_account_mismatch (no unhandled 23505)" || fail "T-REC-3b-commit-2" "$(head -c 300 $D/AP3.out)"
      grep -q "duplicate key" "$D/AP3.out" && fail "T-REC-3b-commit-3" "raw unique violation leaked"
    else
      check "T-REC-3b-rollback-2 B rolled back: the handler attaches the wamid to its candidate and returns true" "$(grep -E '^ ?[tf]$' $D/AP3.out | tr -d ' ')/$(q "select wa_message_id from public.messages where id='$M'")" "t/$W"
    fi
    rm -f "$D"/SB3.* "$D"/AP3.*
  done
  check "T-REC-7 (no cross-account state) invariant" "$(inv_company)" "0"
}

for t in "$@"; do case "$t" in 4a) t4a;; 4b) t4b;; 5) t5;; 14) t14;; dup3) tdup3 ${ITERS:-30};; dup7) tdup7 ${ITERS:-30};; rec) trec;; esac; done
echo "---- summary: $(grep -c '^PASS' $RES) PASS, $(grep -c '^FAIL' $RES) FAIL, $(grep -c '^INFO' $RES) INFO"
cp "$RES" "${OUT:-/tmp}/results_t1_$$.txt" 2>/dev/null

#!/usr/bin/env bash
# DISPOSABLE DATABASES ONLY, from a separate client container (see README.md). Concurrency tests part 4:
#   d1msg / d1echo : D1 regression - the same wamid delivered to TWO sandbox accounts at the same moment, via the Kapso sandbox wrappers
#   d1meta         : Meta Direct characterisation (must stay as it is: not touched by the D1 fix)
#   admin          : bounded lock_timeout of public.update_whatsapp_account (needs 20261104000976 and the Rev6 schema)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mk_sandbox_pair() {   # prints "acc1|pnid1|acc2|pnid2" : two sandbox accounts in two fresh sandbox companies (legacy insert form)
  local n sc1 sc2 p1 p2 a1 a2
  n=$(next); sc1=$(q "insert into public.companies (name, slug, timezone, currency, is_sandbox) values ('SbxD$n','sbxd$n','Asia/Qatar','QAR',true) returning id")
  n=$(next); sc2=$(q "insert into public.companies (name, slug, timezone, currency, is_sandbox) values ('SbxE$n','sbxe$n','Asia/Qatar','QAR',true) returning id")
  n=$(next); p1="D1SBX_$n"; a1=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status) values ('$sc1','d1a','+1555$(printf %07d $n)','$p1','kapso',true,'test') returning id")
  n=$(next); p2="D1SBX_$n"; a2=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, is_sandbox, status) values ('$sc2','d1b','+1555$(printf %07d $n)','$p2','kapso',true,'test') returning id")
  echo "$a1|$p1|$a2|$p2"
}
mk_meta_pair() {
  local n p1 p2 a1 a2
  n=$(next); p1="D1META_$n"; a1=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, status) values ('$ALPHA','m1','+1555$(printf %07d $n)','$p1','test') returning id")
  n=$(next); p2="D1META_$n"; a2=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, status) values ('$BETA','m2','+1555$(printf %07d $n)','$p2','test') returning id")
  echo "$a1|$p1|$a2|$p2"
}
pairs_ok() {   # pairs_ok OUTFILE ACCOUNT : every uuid pair printed in the file is ONE stored (message, conversation) row of ACCOUNT
  local f=$1 acc=$2 bad=0 line mid cid
  while read -r line; do
    mid=$(echo "$line" | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | sed -n 1p); cid=$(echo "$line" | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | sed -n 2p)
    [ -z "$mid" ] && continue
    [ "$(q "select count(*) from public.messages m join public.conversations c on c.id=m.conversation_id where m.id='$mid' and c.id='$cid' and c.whatsapp_account_id='$acc'")" = "1" ] || bad=$((bad+1))
  done < <(grep -E '^[ ]*[0-9a-f]{8}-' "$f")
  echo $bad
}
# race KIND PAIRFN ITERS : both sessions are released by one advisory-lock barrier, in random order
race() {
  local kind=$1 pairfn=$2 iters=${3:-30} i oks_total=0 anomalies=0 pairbad=0 refused_runs=0 bothok=0 pair acc1 p1 acc2 p2
  pair=$($pairfn); IFS='|' read -r acc1 p1 acc2 p2 <<<"$pair"
  for i in $(seq 1 $iters); do
    local W="wamid.d1$kind.$(next)" pha phb; pha=$(phone); phb=$(phone)
    local c1 c2
    case $kind in
      msg|meta)
        local fn=ingest_kapso_message; [ $kind = meta ] && fn=ingest_whatsapp_message
        c1="select * from public.$fn('$p1','$W','$pha','T','text','hi',null,now());"; c2="select * from public.$fn('$p2','$W','$phb','T','text','hi',null,now());";;
      echo) c1="select * from public.ingest_kapso_echo('$p1','$W','$pha','text','hi',null,now());"; c2="select * from public.ingest_kapso_echo('$p2','$W','$phb','text','hi',null,now());";;
    esac
    sess GB; sess SA; sess SB
    send GB "select pg_advisory_lock(8802);"; sleep 0.1
    if [ $((RANDOM % 2)) = 0 ]; then send SA "select pg_advisory_lock_shared(8802); $c1 select pg_advisory_unlock_all();"; send SB "select pg_advisory_lock_shared(8802); $c2 select pg_advisory_unlock_all();"
    else send SB "select pg_advisory_lock_shared(8802); $c2 select pg_advisory_unlock_all();"; send SA "select pg_advisory_lock_shared(8802); $c1 select pg_advisory_unlock_all();"; fi
    for _ in $(seq 1 100); do [ "$(q "select count(*) from pg_stat_activity where application_name in ('SA','SB') and wait_event_type='Lock'")" = "2" ] && break; sleep 0.05; done
    send GB "select pg_advisory_unlock_all();"; wait_out SA "unlock_all"; wait_out SB "unlock_all"; sleep 0.1; endsess GB; endsess SA; endsess SB
    local okA okB mA mB
    okA=$(grep -cE '^ *[0-9a-f]{8}-[0-9a-f-]{27} *\|' "$D/SA.out"); okB=$(grep -cE '^ *[0-9a-f]{8}-[0-9a-f-]{27} *\|' "$D/SB.out")
    mA=$(grep -c "kapso.message_account_mismatch" "$D/SA.out"); mB=$(grep -c "kapso.message_account_mismatch" "$D/SB.out")
    [ "$okA" = 1 ] && [ "$okB" = 1 ] && bothok=$((bothok+1))
    [ "$((mA + mB))" -ge 1 ] && refused_runs=$((refused_runs+1))
    pairbad=$((pairbad + $(pairs_ok "$D/SA.out" "$acc1") + $(pairs_ok "$D/SB.out" "$acc2")))
    # a loser must have created nothing for its customer
    local rows; rows=$(q "select count(*) from public.messages where wa_message_id='$W'")
    [ "$rows" = "1" ] || anomalies=$((anomalies+1))
    if [ "$((mA + mB))" -ge 1 ]; then
      local lp la; if [ "$mA" -ge 1 ]; then lp=$pha; la=$acc1; else lp=$phb; la=$acc2; fi
      [ "$(q "select (select count(*) from public.conversations where whatsapp_account_id='$la' and customer_wa_id='$lp')+(select count(*) from public.contacts where phone_e164='+$lp')")" = "0" ] || anomalies=$((anomalies+1))
    fi
    rm -f "$D"/SA.* "$D"/SB.* "$D"/GB.*
  done
  echo "$iters|$refused_runs|$bothok|$pairbad|$anomalies"
}
d1() {   # d1 KIND LABEL : REGRESSION assertion
  local kind=$1 label=$2 r iters=${ITERS:-30}
  r=$(race $kind mk_sandbox_pair $iters); IFS='|' read -r n refused bothok pairbad anomalies <<<"$r"
  info "$label: $n runs; one side refused in $refused; BOTH sides returned a row in $bothok; inconsistent returned pairs $pairbad; extra-row/leftover anomalies $anomalies"
  if [ "$refused" = "$n" ] && [ "$bothok" = 0 ] && [ "$pairbad" = 0 ] && [ "$anomalies" = 0 ]; then pass "$label: exactly one side wins, the other is refused with kapso.message_account_mismatch, nothing is left behind, every returned pair is consistent"
  else fail "$label" "refused=$refused/$n bothOk=$bothok inconsistentPairs=$pairbad anomalies=$anomalies"; fi
}
d1meta() {
  local r n refused bothok pairbad anomalies; r=$(race meta mk_meta_pair ${ITERS:-30}); IFS='|' read -r n refused bothok pairbad anomalies <<<"$r"
  info "D1-META (Meta Direct, CHARACTERISATION - deliberately not changed by the D1 fix): $n runs; refused in $refused; both sides returned a row in $bothok; inconsistent pairs $pairbad"
}

# ----------------------------------------------------------------------------------------------- admin lock_timeout
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
tadmin() {
  local a ACC P ph SUPER; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph=$(phone)
  SUPER=$(q "select id from tests.users where key='super'")
  local jwt="select set_config('request.jwt.claims','{\"sub\":\"$SUPER\",\"role\":\"authenticated\"}',false)"
  local call="select public.update_whatsapp_account('$ACC','$ALPHA','Edited by admin','+1555$(printf %07d $(next))','$P',null,'test')"
  # 1. a webhook transaction holds the account SHARE lock for ~12 s
  sess H; send H "begin; $(hook $P wamid.adm.$ACC $ph) select pg_sleep(12);"; sleep 0.8
  local t0 out e1; t0=$(date +%s%N)
  out=$(psql -X -q -tA -v VERBOSITY=verbose -c "$jwt" -c "set role authenticated" -c "$call" 2>&1); e1=$(ms $t0)
  [[ "$out" == *"whatsapp.account_busy"* ]] && pass "T-ADMIN-LOCK-1 the admin update gives up with the stable retryable key whatsapp.account_busy" "SQLSTATE $(grep -oE '55P03' <<<"$out" | head -1)" || fail "T-ADMIN-LOCK-1" "$out"
  [ "$e1" -ge 4800 ] && [ "$e1" -le 7500 ] && pass "T-ADMIN-LOCK-2 ... after the bounded wait (${e1} ms; configured 5000 ms)" || fail "T-ADMIN-LOCK-2" "waited ${e1} ms"
  check "T-ADMIN-LOCK-3 nothing was changed by the timed-out edit (display name, company)" "$(q "select display_name||'/'||(default_company_id='$ALPHA')::text from public.whatsapp_accounts where id='$ACC'")" "C$(echo $P | sed 's/CONC_//')/true"
  # 2. the setting is function-local: the same session is back to the default afterwards, and the other sessions never had it
  out=$(psql -X -q -tA -c "$jwt" -c "set role authenticated" -c "$call" -c "show lock_timeout" 2>&1 | tail -1)
  [ "$out" = "0" ] && pass "T-ADMIN-LOCK-4 lock_timeout is back to 0 (disabled) after the function returns: it is not leaked into the session or set globally" || fail "T-ADMIN-LOCK-4" "show lock_timeout -> '$out'"
  check "T-ADMIN-LOCK-5 the database-wide default is untouched" "$(q "show lock_timeout")" "0"
  # 3. after the webhook load has stopped the SAME edit succeeds at once (caller retries by itself; the database never retries)
  send H "commit;"; sleep 11; endsess H
  t0=$(date +%s%N); out=$(psql -X -q -tA -c "$jwt" -c "set role authenticated" -c "$call" 2>&1); local e2; e2=$(ms $t0)
  [[ "$out" != *ERROR* ]] && [ "$e2" -lt 1500 ] && pass "T-ADMIN-LOCK-6 retry after the webhook load stopped succeeds immediately (${e2} ms)" || fail "T-ADMIN-LOCK-6" "$out (${e2} ms)"
  check "T-ADMIN-LOCK-7 ... and the edit is applied" "$(q "select display_name from public.whatsapp_accounts where id='$ACC'")" "Edited by admin"
  # 4. webhook transactions are NOT subject to a lock timeout: one that has to wait for an admin write lock (7 s) completes
  sess AH; send AH "begin; update public.whatsapp_accounts set display_name = 'holding the write lock' where id='$ACC'; select pg_sleep(7); commit;"; sleep 0.8
  local ph2; ph2=$(phone); t0=$(date +%s%N); out=$(psql -X -q -tA -c "$(hook $P wamid.adm2.$ACC $ph2)" 2>&1); local e3; e3=$(ms $t0); wait_out AH "COMMIT" ; endsess AH
  [[ "$out" != *ERROR* ]] && [ "$e3" -ge 5500 ] && pass "T-ADMIN-LOCK-8 a webhook that waited ${e3} ms (> 5 s) for an admin write lock still completed: webhook transactions have no lock timeout" || fail "T-ADMIN-LOCK-8" "$out (${e3} ms)"
  # 5. invariants of the mapping/locking protocol still hold through the function
  out=$(psql -X -q -tA -c "$jwt" -c "set role authenticated" -c "select public.update_whatsapp_account('$ACC','$BETA','x','+15559998877','$P',null,'test')" 2>&1)
  [[ "$out" == *"whatsapp.default_company_immutable"* ]] && pass "T-ADMIN-LOCK-9 a company change after conversations exist is still refused through the function (guard unchanged)" || fail "T-ADMIN-LOCK-9" "$out"
  local OUTSIDER; OUTSIDER=$(q "select id from tests.users where key='admin_a'")
  out=$(psql -X -q -tA -c "select set_config('request.jwt.claims','{\"sub\":\"$OUTSIDER\",\"role\":\"authenticated\"}',false)" -c "set role authenticated" -c "select public.update_whatsapp_account('$ACC','$ALPHA','hijack','+15559998866','$P',null,'test')" 2>&1)
  [[ "$out" == *"auth.forbidden"* ]] && pass "T-ADMIN-LOCK-10 a company admin who is not a super admin is refused (RLS applies: SECURITY INVOKER)" || fail "T-ADMIN-LOCK-10" "$out"
  out=$(psql -X -q -tA -c "set role anon" -c "select public.update_whatsapp_account('$ACC','$ALPHA','x','+15559998855','$P',null,'test')" 2>&1)
  [[ "$out" == *"permission denied"* ]] && pass "T-ADMIN-LOCK-11 anon cannot execute the function" || fail "T-ADMIN-LOCK-11" "$out"
  check "T-LOCK-7 invariant after the admin tests" "$(inv_company)" "0"
}

for t in "$@"; do case "$t" in
  d1msg) d1 msg "D1-MSG (ingest_kapso_message)";; d1echo) d1 echo "D1-ECHO (ingest_kapso_echo)";; d1meta) d1meta;; admin) tadmin;;
esac; done
echo "---- summary: $(grep -c '^PASS' $RES) PASS, $(grep -c '^FAIL' $RES) FAIL, $(grep -c '^INFO' $RES) INFO"

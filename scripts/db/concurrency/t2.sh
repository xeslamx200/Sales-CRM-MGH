#!/usr/bin/env bash
# SCRATCH ONLY. Concurrency tests part 2: T-LOCK-8 (randomized), T-LOCK-10 (isolation), T-LOCK-11, T-LOCK-15, T-LOCK-16, T-LOCK-17.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
deadlocks() { q "select deadlocks from pg_stat_database where datname=current_database()"; }
errsummary() { qa "select who||' '||sqlstate||' '||left(msg,70)||'  x'||count(*) from public.scratch_errlog where id > ${1:-0} group by who, sqlstate, left(msg,70) order by count(*) desc"; }
maxerr() { q "select coalesce(max(id),0) from public.scratch_errlog"; }

# ----------------------------------------------------------------------------------------------- T-LOCK-8 randomized stress
t8() {
  local NACC=${NACC:-500} DUR=${DUR:-40} i
  qa "truncate public.scratch_accts" >/dev/null
  qa "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status) select '$ALPHA', 'S8 ' || g, '+1556' || lpad(nextval('public.scratch_ctr')::text, 7, '0'), 'S8_' || nextval('public.scratch_ctr'), 'kapso', 'production', 'coexistence', 'test' from generate_series(1, $NACC) g" >/dev/null

  qa "insert into public.scratch_accts select row_number() over (order by phone_number_id), id, phone_number_id, default_company_id from public.whatsapp_accounts where display_name like 'S8 %' and phone_number_id like 'S8%' and not exists (select 1 from public.conversations c where c.whatsapp_account_id = whatsapp_accounts.id)" >/dev/null
  info "T-LOCK-8 setup: $(q "select count(*) from public.scratch_accts") fresh production accounts (no conversations), all in company alpha"
  cat > "$D/w.pgb" <<'EOF'
\set a random(1, __N__)
\set k random(1, 100)
\set c random(1, 6)
\set w random(1, 2000000000)
select public.scratch_w(:a, :k, :c, :w);
EOF
  cat > "$D/a.pgb" <<'EOF'
\set a random(1, __N__)
\set k random(1, 100)
\set r random(1, 3)
select public.scratch_a(:a, :k, :r);
EOF
  sed -i "s/__N__/$NACC/" "$D/w.pgb" "$D/a.pgb"
  local d0 e0 aud0; d0=$(deadlocks); e0=$(maxerr); aud0=$(q "select coalesce(max(id),0) from public.scratch_account_update_log")
  ( PGAPPNAME=webhook pgbench -n -f "$D/w.pgb" -c 8 -j 8 -T $DUR > "$D/t8w.out" 2>&1 ) & local p1=$!
  ( PGAPPNAME=admin pgbench -n -f "$D/a.pgb" -c 3 -j 3 -T $DUR > "$D/t8a.out" 2>&1 ) & local p2=$!
  wait $p1 $p2
  info "T-LOCK-8 pgbench webhook: $(grep -E 'number of transactions actually processed' $D/t8w.out) ; admin: $(grep -E 'number of transactions actually processed' $D/t8a.out)"
  check "T-LOCK-8a deadlocks reported by PostgreSQL (pg_stat_database delta) during the randomized run" "$(( $(deadlocks) - d0 ))" "0"
  check "T-LOCK-8b no 40P01 / 40001 in the caught-error log" "$(q "select count(*) from public.scratch_errlog where id > $e0 and sqlstate in ('40P01','40001')")" "0"
  info "T-LOCK-8 caught errors by kind: $(errsummary $e0 | tr '\n' ';')"
  # (979) echoes to a customer the account has not seen yet (the stress mix sends them) are refused with kapso.echo_unattributed
  check "T-LOCK-8c the ONLY errors are the expected rejections (company change after conversations exist; echo to an unseen customer)" "$(q "select count(*) from public.scratch_errlog where id > $e0 and msg not like '%default_company_immutable%' and msg <> 'kapso.echo_unattributed'")" "0"
  check "T-LOCK-7 invariant after the randomized run (no production conversation under a company different from its account)" "$(inv_company)" "0"
  check "T-LOCK-8d every conversation's contact link/lead company equals its conversation company" "$(q "select count(*) from public.leads l join public.conversations c on c.id=l.conversation_id join public.whatsapp_accounts a on a.id=c.whatsapp_account_id join public.scratch_accts s on s.id=a.id where l.company_id <> c.company_id")" "0"
  # outcome histogram
  info "T-LOCK-8 outcomes: accounts re-pointed (update won before any conversation): $(q "select count(*) from public.scratch_accts s join public.whatsapp_accounts a on a.id=s.id where a.default_company_id <> s.orig_company")  |  with conversations: $(q "select count(distinct c.whatsapp_account_id) from public.conversations c join public.scratch_accts s on s.id=c.whatsapp_account_id")  |  re-pointed AND with conversations (re-point first, conversations afterwards under the NEW company): $(q "select count(distinct c.whatsapp_account_id) from public.conversations c join public.scratch_accts s on s.id=c.whatsapp_account_id join public.whatsapp_accounts a on a.id=s.id where a.default_company_id <> s.orig_company")  |  re-point rejected because a conversation existed: $(q "select count(*) from public.scratch_errlog where id > $e0 and msg like '%default_company_immutable%'")"
  check "T-LOCK-17a (audit trigger) webhook sessions never updated an account row during the randomized run" "$(q "select count(*) from public.scratch_account_update_log where id > $aud0 and application_name='webhook'")" "0"
  info "T-LOCK-17b account updates seen by the audit trigger during the run (application_name [columns] xcount): $(qa "select application_name||' ['||cols||'] x'||n from (select application_name, coalesce(array_to_string(changed_columns,','),'') cols, count(*) n from public.scratch_account_update_log where id > $aud0 group by 1, 2) s order by n desc limit 6" | tr '
' ';')"
}

# ----------------------------------------------------------------------------------------------- T-LOCK-10 isolation
t10() {
  local a ACC P ph; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph=$(phone)
  local r
  for lvl in "repeatable read" "serializable"; do
    r=$(psql -X -q -tA -c "begin isolation level $lvl; update public.whatsapp_accounts set default_company_id='$BETA' where id='$ACC'; rollback;" 2>&1 | tr '\n' ' ')
    [[ "$r" == *"whatsapp.isolation_unsupported"* ]] && pass "T-LOCK-10a company change of a Kapso account under $lvl is refused (fail closed)" || fail "T-LOCK-10a $lvl" "$r"
    r=$(psql -X -q -tA -c "begin isolation level $lvl; update public.whatsapp_accounts set display_name='iso' where id='$ACC'; rollback;" 2>&1 | tr '\n' ' ')
    [[ "$r" != *"ERROR"* ]] && pass "T-LOCK-10b ... but an ordinary edit of the same account works under $lvl" || fail "T-LOCK-10b $lvl" "$r"
    r=$(psql -X -q -tA -c "begin isolation level $lvl; update public.whatsapp_accounts set default_company_id='$BETA' where phone_number_id='PNID_ALPHA'; rollback;" 2>&1 | tr '\n' ' ')
    [[ "$r" != *"ERROR"* ]] && pass "T-LOCK-10c a Meta account company change is unaffected under $lvl (Meta behaviour unchanged)" || fail "T-LOCK-10c $lvl" "$r"
  done
  # webhook under REPEATABLE READ racing a committed company update -> 40001, nothing created
  sess WRR; send WRR "begin isolation level repeatable read; select 1;"; sleep 0.3
  q "update public.whatsapp_accounts set default_company_id='$BETA' where id='$ACC'" >/dev/null
  send WRR "$(hook $P wamid.10rr.$ACC $ph)"; sleep 0.8; send WRR "rollback;"; sleep 0.2; endsess WRR
  if grep -q "could not serialize access" "$D/WRR.out"; then pass "T-LOCK-10d a webhook under REPEATABLE READ that raced a committed company update fails with 40001 (could not serialize) instead of reading a stale company"
  else fail "T-LOCK-10d" "$(head -c 400 $D/WRR.out)"; fi
  check "T-LOCK-10e ... and created no conversation" "$(q "select count(*) from public.conversations where whatsapp_account_id='$ACC'")" "0"
}

# ----------------------------------------------------------------------------------------------- T-LOCK-11 (retry job holds many shares)
t11() {
  local ids=() pns=() n j phs d0; d0=$(deadlocks)
  for j in 1 2 3 4 5; do local a; a=$(mkacct); ids+=("${a%%|*}"); pns+=("${a##*|}"); done
  # 100 failed retry events spread over the 5 accounts (10 new customers each, 2 events each)
  for j in 0 1 2 3 4; do for n in $(seq 1 20); do
    qa "insert into public.whatsapp_webhook_events (event_key, event_kind, phone_number_id, payload, status, attempts, last_error, received_at) values ('kapso:msg:wamid.l11.${ids[$j]}.$n', 'message', '${pns[$j]}', jsonb_build_object('kind','kapso_inbound_v2','phoneNumberId','${pns[$j]}','waMessageId','wamid.l11.${ids[$j]}.$n','fromWaId','2010011' || lpad(($j*100+$n%10)::text, 8, '0'),'fromBsuid',null,'origin',null,'profileName','L11','messageType','text','body','x','media',null,'sentAt','2026-11-04T10:00:00Z'), 'failed', 1, 'processing_error', now())" >/dev/null
  done; done
  info "T-LOCK-11 setup: 5 accounts, $(q "select count(*) from public.whatsapp_webhook_events where event_key like 'kapso:msg:wamid.l11.%' and phone_number_id in ('${pns[0]}','${pns[1]}','${pns[2]}','${pns[3]}','${pns[4]}')") failed events"
  # order 1: the job runs first and holds shares for 3 s; admin updates arrive meanwhile
  sess J11; sess A11
  send J11 "begin; select public.process_webhook_retries(100, 8) ->> 'processed'; select pg_sleep(3);"; sleep 1.0
  send A11 "update public.whatsapp_accounts set default_company_id='$BETA' where id='${ids[0]}';"
  wait_blocked A11 && pass "T-LOCK-11a admin update waits behind the retry job's share locks" || fail "T-LOCK-11a" "not blocked"
  send J11 "commit;"; wait_unblocked A11; sleep 0.5; endsess J11; endsess A11
  grep -q "default_company_immutable" "$D/A11.out" && pass "T-LOCK-11b after the job commits the update is rejected (conversations now exist) - no deadlock" || fail "T-LOCK-11b" "$(head -c 300 $D/A11.out)"
  check "T-LOCK-11c all 100 events processed in the single job transaction" "$(q "select count(*) from public.whatsapp_webhook_events where event_key like 'kapso:msg:wamid.l11.%' and status='processed' and phone_number_id in ('${pns[0]}','${pns[1]}','${pns[2]}','${pns[3]}','${pns[4]}')")" "100"
  # order 2 needs fresh accounts: admin holds an open update on account 0, job must wait for it, then use the NEW company
  local ids2=() pns2=(); for j in 1 2 3; do local a; a=$(mkacct); ids2+=("${a%%|*}"); pns2+=("${a##*|}"); done
  for j in 0 1 2; do for n in $(seq 1 10); do
    qa "insert into public.whatsapp_webhook_events (event_key, event_kind, phone_number_id, payload, status, attempts, last_error, received_at) values ('kapso:msg:wamid.l11b.${ids2[$j]}.$n', 'message', '${pns2[$j]}', jsonb_build_object('kind','kapso_inbound_v2','phoneNumberId','${pns2[$j]}','waMessageId','wamid.l11b.${ids2[$j]}.$n','fromWaId','2010012' || lpad(($j*100+$n)::text, 8, '0'),'fromBsuid',null,'origin',null,'profileName','L11','messageType','text','body','x','media',null,'sentAt','2026-11-04T10:00:00Z'), 'failed', 1, 'processing_error', now())" >/dev/null
  done; done
  sess A11b; sess J11b
  send A11b "begin; update public.whatsapp_accounts set default_company_id='$BETA' where id='${ids2[0]}';"; sleep 0.3
  send J11b "select public.process_webhook_retries(100, 8) ->> 'processed';"
  wait_blocked J11b && pass "T-LOCK-11d the retry job waits behind an open account update (no conversation yet)" || fail "T-LOCK-11d" "not blocked"
  send A11b "commit;"; wait_unblocked J11b; sleep 0.8; endsess A11b; endsess J11b
  check "T-LOCK-11e the account re-pointed first got its conversations under the NEW company; the others under alpha" "$(q "select (select count(*) from public.conversations where whatsapp_account_id='${ids2[0]}' and company_id='$BETA')||'/'||(select count(*) from public.conversations where whatsapp_account_id='${ids2[0]}' and company_id<>'$BETA')||'/'||(select count(*) from public.conversations where whatsapp_account_id in ('${ids2[1]}','${ids2[2]}') and company_id='$ALPHA')")" "10/0/20"
  check "T-LOCK-11f no deadlock reported" "$(( $(deadlocks) - d0 ))" "0"
  check "T-LOCK-7 invariant after T-LOCK-11" "$(inv_company)" "0"
}

# ----------------------------------------------------------------------------------------------- T-LOCK-15 starvation + T-LOCK-16 touch
t15() {
  local a ACC P; a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; local d0 e0; d0=$(deadlocks)
  # webhook transactions deliberately hold their share lock for ~50 ms (a long-ish transaction), 16 clients -> overlapping shares all the time
  cat > "$D/t15.pgb" <<EOF
\set w random(1, 2000000000)
\set c random(1, 40)
begin;
select count(*) from public.ingest_kapso_inbound('$P', 'wamid.l15.' || :w, '2010015' || lpad(:c::text, 8, '0'), null, null, 'T15', 'text', 'hi', null, now());
select pg_sleep(0.05);
commit;
EOF
  ( PGAPPNAME=webhook pgbench -n -f "$D/t15.pgb" -c 16 -j 16 -T 14 > "$D/t15.out" 2>&1 ) & local p=$!
  sleep 4
  local t0 t1 out; t0=$(date +%s%N)
  out=$(PGAPPNAME=admin psql -X -q -tA -c "update public.whatsapp_accounts set display_name = 'starve probe' where id='$ACC'" 2>&1); t1=$(date +%s%N)
  local wait1; wait1="$(( (t1 - t0) / 1000000 )) ms"
  t0=$(date +%s%N); out=$(PGAPPNAME=admin psql -X -q -tA -c "update public.whatsapp_accounts set default_company_id = default_company_id where id='$ACC'" 2>&1); t1=$(date +%s%N)
  local wait2; wait2="$(( (t1 - t0) / 1000000 )) ms"
  wait $p
  info "T-LOCK-15 (informational) 16 overlapping webhook transactions each holding the account SHARE lock ~50 ms for 14 s: admin edit #1 waited ${wait1}, edit #2 waited ${wait2}; $(grep -E 'number of transactions actually processed' $D/t15.out)"
  info "T-LOCK-15 pgbench tps: $(grep -E '^tps' $D/t15.out | head -1)"
  check "T-LOCK-15b no deadlock reported" "$(( $(deadlocks) - d0 ))" "0"
  # T-LOCK-16: telemetry concurrently with webhooks
  local a2 ACC2 P2; a2=$(mkacct); ACC2=${a2%%|*}; P2=${a2##*|}; d0=$(deadlocks); local aud0; aud0=$(q "select coalesce(max(id),0) from public.scratch_account_update_log")
  sed "s/'$P'/'$P2'/" "$D/t15.pgb" > "$D/t16w.pgb"
  cat > "$D/t16t.pgb" <<EOF
select public.touch_kapso_account('$P2');
EOF
  ( PGAPPNAME=webhook pgbench -n -f "$D/t16w.pgb" -c 12 -j 12 -T 10 > "$D/t16w.out" 2>&1 ) & local q1=$!
  ( PGAPPNAME=admin pgbench -n -f "$D/t16t.pgb" -c 4 -j 4 -T 10 > "$D/t16t.out" 2>&1 ) & local q2=$!
  wait $q1 $q2
  info "T-LOCK-16 webhooks: $(grep -E 'number of transactions actually processed' $D/t16w.out) ; touch calls: $(grep -E 'number of transactions actually processed' $D/t16t.out)"
  check "T-LOCK-16a no deadlock with touch_kapso_account running concurrently with webhooks" "$(( $(deadlocks) - d0 ))" "0"
  check "T-LOCK-16b the account row was written at most once per minute by the telemetry (audit rows for last_inbound_event_at)" "$(q "select (count(*) <= 2)::text from public.scratch_account_update_log where id > $aud0 and account_id='$ACC2' and 'last_inbound_event_at' = any(changed_columns)")" "true"
  check "T-LOCK-17c webhook sessions never wrote the account row in T-LOCK-15/16" "$(q "select count(*) from public.scratch_account_update_log where id > $aud0 and application_name='webhook'")" "0"
  check "T-LOCK-7 invariant after T-LOCK-15/16" "$(inv_company)" "0"
}

for t in "$@"; do case "$t" in 8) t8;; 10) t10;; 11) t11;; 15) t15;; esac; done
echo "---- summary: $(grep -c '^PASS' $RES) PASS, $(grep -c '^FAIL' $RES) FAIL, $(grep -c '^INFO' $RES) INFO"

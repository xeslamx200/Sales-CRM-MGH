#!/usr/bin/env bash
# DISPOSABLE DATABASES ONLY, from a separate client container (see README.md). Deterministic tests for patch 977 (contact lock order).
#   sub : proves that row locks taken inside a rolled-back PL/pgSQL sub-transaction are released (and kept when the block ends normally)
#   cyc : the original cycle, built from states and pg_blocking_pids (no sleeps decide the outcome):
#           B = promotion path (conversation found by BSUID, helper app.kapso_lock_conversation_contact)
#           N = new-customer path (contact found by phone, live-contact loop of app.kapso_resolve_conversation)
# Choreography (K = surviving contact, M = merged-away contact):
#   MG1 : merge_contacts(K, M), left open  (holds K and M, conversation move uncommitted)
#   W   : the webhook; reads the pre-merge state (contact M) and blocks on M behind MG1
#   MG2 : second merge, first lock only: K FOR UPDATE (queues behind MG1)        [merge_contacts lines "where id = p_keep_id for update"]
#   MG1 commits -> W obtains M, finds the conversation/contact moved to K, and needs K, which MG2 holds
#   MG2 : second merge, second lock: M FOR UPDATE                                [merge_contacts "where id = p_merge_id for update"]
# T6_EXPECT=deadlock : the schema is Rev6+972 (no 977): the test PASSES only if PostgreSQL reports 40P01 (proves the test can detect it)
# T6_EXPECT=clean    : the schema has 977: the test PASSES only if there is no 40P01, MG2 gets M at once and the webhook completes.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
EXPECT=${T6_EXPECT:-clean}
SUPER=$(q "select id from tests.users where key='super'")
JWT="select set_config('request.jwt.claims','{\"sub\":\"$SUPER\",\"role\":\"authenticated\"}',false);"
dl_count() { q "select deadlocks from pg_stat_database where datname=current_database()"; }

sub() {
  local X
  X=$(q "insert into public.contacts (full_name) values ('S1-$(next)') returning id")
  # (a) the block is rolled back: the lock must be gone while the surrounding transaction is still open
  sess SA; sess SB
  send SA "begin; do \$\$ begin begin perform 1 from public.contacts where id='$X' for no key update; raise exception 'moved' using errcode='KL001'; exception when sqlstate 'KL001' then null; end; end \$\$; select 'A_READY';"
  wait_out SA A_READY
  send SB "set lock_timeout='1500ms'; select 'B_GOT_'||count(*) from (select 1 from public.contacts where id='$X' for update) s;"
  wait_out SB "B_GOT_1" && pass "T-977-S1a row lock taken inside a rolled-back sub-transaction is released (FOR UPDATE by another session succeeds at once)" || fail "T-977-S1a" "$(head -c 300 $D/SB.out)"
  check "T-977-S1a2 the session that rolled the block back is still inside its transaction" "$(q "select state from pg_stat_activity where application_name='SA'")" "idle in transaction"
  endsess SA; endsess SB
  # (b) control: the block ends normally -> the lock is kept (so S1a is not passing for a trivial reason)
  sess SC; sess SD
  send SC "begin; do \$\$ begin begin perform 1 from public.contacts where id='$X' for no key update; end; end \$\$; select 'C_READY';"
  wait_out SC C_READY
  send SD "set lock_timeout='1500ms'; select 'D_GOT' from public.contacts where id='$X' for update;"
  wait_out SD "lock timeout" && pass "T-977-S1b control: a lock taken in a block that ends normally is KEPT (other session times out, 55P03)" || fail "T-977-S1b" "$(head -c 300 $D/SD.out)"
  endsess SC; endsess SD
  # (c) a waiter that queued while the block still held the lock is woken by the sub-transaction rollback, not by the end of the transaction
  sess SE; sess SF
  send SE "begin; do \$\$ begin begin perform 1 from public.contacts where id='$X' for no key update; perform pg_sleep(3); raise exception 'moved' using errcode='KL001'; exception when sqlstate 'KL001' then null; end; end \$\$; select 'E_READY';"
  sleep 0.7; send SF "select 'F_GOT' from public.contacts where id='$X' for update;"
  wait_blocked SF && check "T-977-S1c the waiter is blocked by the sub-transaction holder" "$(blockers SF | grep -c "$(pid_of SE)")" "1" || fail "T-977-S1c" "waiter not blocked"
  wait_out SF "F_GOT" && pass "T-977-S1d the waiter is released by the sub-transaction rollback" || fail "T-977-S1d" "$(head -c 300 $D/SF.out)"
  check "T-977-S1e ... while the holder's transaction is still open" "$(q "select state from pg_stat_activity where application_name='SE'")" "idle in transaction"
  endsess SE; endsess SF
}

# cyc B|N
cyc() {
  local kind=$1 a ACC P ph1 ph2 bs K M cm tag="$1$(next)" d0 dl W_PID M2_PID M1_PID i
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph2=$(phone); bs="BS-C977-$tag"
  if [ "$kind" = B ]; then
    ph1=$(phone)
    qa "select * from public.ingest_kapso_inbound('$P','wamid.c977.k.$tag','$ph1',null,null,'Keep977','text','hi',null,now());" >/dev/null
    qa "select * from public.ingest_kapso_inbound('$P','wamid.c977.m.$tag',null,'$bs',null,'Merge977','text','hi',null,now());" >/dev/null
    K=$(q "select contact_id from public.conversations where whatsapp_account_id='$ACC' and customer_wa_id='$ph1'")
    M=$(q "select contact_id from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='$bs'")
  else
    K=$(q "insert into public.contacts (full_name) values ('K977-$tag') returning id")
    M=$(q "insert into public.contacts (full_name, phone_e164) values ('M977-$tag', '+$ph2') returning id")
  fi
  d0=$(dl_count)
  sess "MG1$tag"; sess "W$tag"; sess "MG2$tag"
  send "MG1$tag" "$JWT"; send "MG1$tag" "begin; select public.merge_contacts('$K','$M'); select 'MG1_READY';"
  wait_out "MG1$tag" MG1_READY
  if [ "$kind" = B ]; then
    send "W$tag" "select * from public.ingest_kapso_inbound('$P','wamid.c977.w.$tag','$ph2','$bs',null,'Merge977','text','phone appears',null,now());"
  else
    send "W$tag" "select * from public.ingest_kapso_inbound('$P','wamid.c977.w.$tag','$ph2',null,null,'M977','text','new customer',null,now());"
  fi
  wait_blocked "W$tag"; W_PID=$(pid_of "W$tag"); M1_PID=$(pid_of "MG1$tag")
  check "T-977-$kind-1 the webhook is blocked on M behind the first merge" "$(blockers "W$tag")" "$M1_PID"
  send "MG2$tag" "begin; select 'MG2_HAS_K' from public.contacts where id='$K' for update;"
  for i in $(seq 1 100); do [ "$(blockers "MG2$tag")" = "$M1_PID" ] && break; sleep 0.05; done; M2_PID=$(pid_of "MG2$tag")
  check "T-977-$kind-2 the second merge queues on K behind the first merge" "$(blockers "MG2$tag")" "$M1_PID"
  send "MG1$tag" "commit;"
  for i in $(seq 1 200); do [ "$(blockers "W$tag")" = "$M2_PID" ] && break; sleep 0.05; done
  check "T-977-$kind-3 after the first merge committed the webhook waits for K behind the second merge" "$(blockers "W$tag")" "$M2_PID"
  wait_out "MG2$tag" MG2_HAS_K
  info "T-977-$kind evidence before the second lock of the second merge (pid: application_name, blocked by):"
  qa "select '   '||pid||': '||application_name||', wait='||coalesce(wait_event_type||'/'||wait_event,'-')||', blocked_by='||coalesce(array_to_string(pg_blocking_pids(pid),','),'-') from pg_stat_activity where application_name in ('MG1$tag','W$tag','MG2$tag') order by application_name" | tee -a "$RES"
  qa "select '   pg_locks pid='||l.pid||' '||l.locktype||' mode='||l.mode||' granted='||l.granted from pg_locks l where l.pid in ($W_PID,$M2_PID) and l.locktype in ('tuple','transactionid') order by l.pid, l.locktype, l.granted" | tee -a "$RES"
  # the second lock of the second merge (merge_contacts: where id = p_merge_id for update)
  send "MG2$tag" "select 'MG2_HAS_M' from public.contacts where id='$M' for update;"
  if [ "$EXPECT" = clean ]; then
    wait_out "MG2$tag" MG2_HAS_M && pass "T-977-$kind-4 the second merge obtains M at once (the webhook released it)" || fail "T-977-$kind-4" "second merge did not get M: $(tail -c 300 $D/MG2$tag.out)"
    send "MG2$tag" "commit;"
    wait_out "W$tag" "(1 row)" && pass "T-977-$kind-5 the webhook completes and returns one (contact, conversation) pair" || fail "T-977-$kind-5" "$(tail -c 400 $D/W$tag.out)"
  else
    for i in $(seq 1 200); do grep -q "deadlock detected" "$D/W$tag.out" "$D/MG2$tag.out" 2>/dev/null && break; sleep 0.05; done
    send "MG2$tag" "rollback;"; sleep 0.5
  fi
  endsess "MG1$tag"; endsess "W$tag"; endsess "MG2$tag"; sleep 1.5
  dl=$(( $(dl_count) - d0 ))
  local seen=0; grep -q "deadlock detected" "$D/W$tag.out" "$D/MG2$tag.out" "$D/MG1$tag.out" 2>/dev/null && seen=1
  if [ "$EXPECT" = deadlock ]; then
    check "T-977-$kind-6 [Rev6+972, no 977] the cycle IS reproduced: PostgreSQL reports 40P01 (error text seen)" "$seen" "1"
    check "T-977-$kind-7 [Rev6+972, no 977] pg_stat_database deadlock counter" "$dl" "1"
    info "T-977-$kind victim: $(grep -l 'deadlock detected' $D/W$tag.out $D/MG2$tag.out 2>/dev/null | sed 's#.*/##' | tr '\n' ' ')"
    grep -h -A3 "deadlock detected" "$D/W$tag.out" "$D/MG2$tag.out" 2>/dev/null | head -8 | tee -a "$RES"
    return
  fi
  check "T-977-$kind-6 no 40P01 anywhere in the deterministic interleaving" "$seen" "0"
  check "T-977-$kind-7 pg_stat_database deadlock counter" "$dl" "0"
  check "T-977-$kind-8 M remains merged into K" "$(q "select (merged_into_id='$K')::text from public.contacts where id='$M'")" "true"
  check "T-977-$kind-9 the conversation of this account points at K (never at the merged-away contact)" "$(q "select string_agg((contact_id='$K')::text, ',') from public.conversations where whatsapp_account_id='$ACC'")" "$([ $kind = B ] && echo true,true || echo true)"
  check "T-977-$kind-10 no identity, company link or conversation references M" "$(q "select (select count(*) from public.contact_identities where contact_id='$M')||'/'||(select count(*) from public.contact_companies where contact_id='$M')||'/'||(select count(*) from public.conversations where contact_id='$M')")" "0/0/0"
  check "T-977-$kind-11 the webhook's message is stored in a conversation of THIS account that belongs to K (no cross-account pair)" "$(q "select count(*) from public.messages m join public.conversations c on c.id=m.conversation_id where m.wa_message_id='wamid.c977.w.$tag' and c.whatsapp_account_id='$ACC' and c.contact_id='$K'")" "1"
  if [ "$kind" = B ]; then
    check "T-977-B-12 BSUID promotion preserved: the conversation got the new phone, the merged-away contact did not" "$(q "select (select customer_wa_id from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='$bs')||'/'||(select coalesce(phone_e164,'null') from public.contacts where id='$M')")" "$ph2/null"
  fi
}

# exh : the 5-attempt bound. Five merges move the conversation C0 -> C1 -> ... -> C5 one after the other, each committing exactly
#       while the webhook holds the previous contact; after the 5th move the helper gives up with 40001 (retry-safe), holding nothing.
exh() {
  local a ACC P bs n k i W CS=() HP
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next); bs="BS-EXH-$n"
  qa "select * from public.ingest_kapso_inbound('$P','wamid.exh.c0.$n',null,'$bs',null,'Exh','text','hi',null,now());" >/dev/null
  CS[0]=$(q "select contact_id from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='$bs'")
  for k in 1 2 3 4 5; do CS[$k]=$(q "insert into public.contacts (full_name) values ('EXH$k-$n') returning id"); done
  for k in 1 2 3 4 5; do sess "H$k$n"; send "H$k$n" "$JWT"; done
  W="WX$n"; sess "$W"
  send "H1$n" "begin; select public.merge_contacts('${CS[1]}','${CS[0]}'); select 'H_READY';"; wait_out "H1$n" H_READY
  send "$W" "select * from public.ingest_kapso_inbound('$P','wamid.exh.w.$n',null,'$bs',null,'Exh','text','again',null,now());"
  for i in $(seq 1 100); do [ "$(blockers "$W")" = "$(pid_of "H1$n")" ] && break; sleep 0.05; done
  check "T-977-X-1 attempt 1: the webhook waits for C0 behind merge 1" "$(blockers "$W")" "$(pid_of "H1$n")"
  for k in 1 2 3 4; do
    local nx=$((k+1))
    send "H$nx$n" "begin; select public.merge_contacts('${CS[$nx]}','${CS[$k]}'); select 'H_READY';"
    for i in $(seq 1 100); do [ "$(blockers "H$nx$n")" = "$(pid_of "H$k$n")" ] && break; sleep 0.05; done
    send "H$k$n" "commit;"
    wait_out "H$nx$n" H_READY
    for i in $(seq 1 200); do [ "$(blockers "$W")" = "$(pid_of "H$nx$n")" ] && break; sleep 0.05; done
    check "T-977-X-$((k+1)) attempt $((k+1)): after move $k the webhook waits for C$k behind merge $nx" "$(blockers "$W")" "$(pid_of "H$nx$n")"
    # ...and holds NO lock on the stale contact C(k-1) any more (972 still held it here; that was the inversion)
    check "T-977-X-$((k+1))b ...while the stale contact C$((k-1)) is free (FOR UPDATE NOWAIT succeeds)" \
      "$(psql -X -q -tA -c "begin" -c "select 'FREE' from public.contacts where id='${CS[$((k-1))]}' for update nowait" -c "rollback" 2>&1 | grep -c FREE)" "1"
  done
  send "H5$n" "commit;"
  wait_out "$W" "identity_conflict" && pass "T-977-X-6 after the 5th consecutive move the helper gives up: kapso.identity_conflict" || fail "T-977-X-6" "$(tail -c 300 $D/$W.out)"
  for k in 1 2 3 4 5; do endsess "H$k$n"; done; endsess "$W"; sleep 0.5
  check "T-977-X-7 ...nothing of the webhook was stored (the whole call rolled back; the retry job will try again)" "$(q "select count(*) from public.messages where wa_message_id='wamid.exh.w.$n'")" "0"
  check "T-977-X-8 the conversation ends on C5 and no identity points at a merged contact" "$(q "select (contact_id='${CS[5]}')::text from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='$bs'")|$(q "select count(*) from public.contact_identities i join public.contacts k on k.id=i.contact_id where i.whatsapp_account_id='$ACC' and k.merged_into_id is not null")" "true|0"
}

# unexp : an error that is NOT the internal retry signal (here: lock_timeout) propagates unchanged; it is never swallowed or retried.
unexp() {
  local a ACC P bs n C
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next); bs="BS-UNX-$n"
  qa "select * from public.ingest_kapso_inbound('$P','wamid.unx.c.$n',null,'$bs',null,'Unx','text','hi',null,now());" >/dev/null
  C=$(q "select contact_id from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='$bs'")
  sess "UX$n"; sess "UW$n"
  send "UX$n" "begin; select 'X_HAS' from public.contacts where id='$C' for update;"; wait_out "UX$n" X_HAS
  send "UW$n" "set lock_timeout='400ms'; select * from public.ingest_kapso_inbound('$P','wamid.unx.w.$n',null,'$bs',null,'Unx','text','again',null,now());"
  wait_out "UW$n" "lock timeout" && pass "T-977-U-1 an unexpected error inside the attempt block (55P03 lock timeout) propagates as itself" || fail "T-977-U-1" "$(tail -c 300 $D/UW$n.out)"
  check "T-977-U-2 ...it is not turned into the retry signal or the exhaustion code" "$(grep -c 'KL001\|contact_moved\|identity_conflict' $D/UW$n.out)" "0"
  send "UX$n" "rollback;"; endsess "UX$n"; endsess "UW$n"; sleep 0.3
  check "T-977-U-3 nothing of the failed call was stored" "$(q "select count(*) from public.messages where wa_message_id='wamid.unx.w.$n'")" "0"
}

# retain : after a normal return the helper's lock is KEPT for the rest of the transaction (the caller relies on it).
retain() {
  local a ACC P bs n C CV
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; n=$(next); bs="BS-RET-$n"
  qa "select * from public.ingest_kapso_inbound('$P','wamid.ret.c.$n',null,'$bs',null,'Ret','text','hi',null,now());" >/dev/null
  CV=$(q "select id from public.conversations where whatsapp_account_id='$ACC' and customer_bsuid='$bs'")
  C=$(q "select contact_id from public.conversations where id='$CV'")
  sess "RT$n"; sess "RO$n"
  send "RT$n" "begin; select 'GOT_'||app.kapso_lock_conversation_contact('$CV');"; wait_out "RT$n" "GOT_$C"
  send "RO$n" "set lock_timeout='600ms'; select 'O_GOT' from public.contacts where id='$C' for update;"
  wait_out "RO$n" "lock timeout" && pass "T-977-R-1 the contact stays locked after the helper returned normally (another session times out)" || fail "T-977-R-1" "$(tail -c 200 $D/RO$n.out)"
  send "RT$n" "rollback;"; endsess "RT$n"; endsess "RO$n"
  check "T-977-R-2 a conversation that does not exist raises kapso.conversation_not_found (never a NULL contact)" "$(psql -X -q -tA -c "select app.kapso_lock_conversation_contact(gen_random_uuid())" 2>&1 | grep -o 'kapso.conversation_not_found')" "kapso.conversation_not_found"
}

for t in "$@"; do case "$t" in sub) sub;; cycB) cyc B;; cycN) cyc N;; exh) exh;; unexp) unexp;; retain) retain;; esac; done
check "T-LOCK-7 invariant" "$(inv_company)" "0"
echo "---- summary: $(grep -c '^PASS' $RES) PASS, $(grep -c '^FAIL' $RES) FAIL, $(grep -c '^INFO' $RES) INFO"

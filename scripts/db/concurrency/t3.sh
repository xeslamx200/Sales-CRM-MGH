#!/usr/bin/env bash
# SCRATCH ONLY. T-LOCK-12 (attach / promotion vs merge_contacts) and T-LOCK-13 (pre-existing merge vs lead, characterisation).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
deadlocks() { q "select deadlocks from pg_stat_database where datname=current_database()"; }
maxerr() { q "select coalesce(max(id),0) from public.scratch_errlog"; }
N=${N:-500}; DUR=${DUR:-20}
run_pair() {   # run_pair TYPE LABEL : N pairs, concurrent merge clients and webhook clients on random pairs
  local typ=$1 label=$2 a ACC P d0 e0
  a=$(mkacct); ACC=${a%%|*}; P=${a##*|}
  q "select public.scratch_l12_setup('$typ', $N, '$P', '$ALPHA')" >/dev/null
  info "$label setup: $(q "select count(*) from public.scratch_l12 where typ='$typ' and pnid='$P'") pairs on account $P"
  # the pair index is relative to the type; restrict to this account's rows by using a per-run offset table view
  q "create or replace view public.scratch_l12_run as select * from public.scratch_l12 where pnid='$P'" >/dev/null
  cat > "$D/m.pgb" <<EOF
\set i random(1, $N)
select public.scratch_merge('$typ', ((select count(*) from public.scratch_l12 where typ='$typ' and id < (select min(id) from public.scratch_l12 where pnid='$P')) + :i)::int);
EOF
  cat > "$D/w.pgb" <<EOF
\set i random(1, $N)
select public.scratch_w12('$typ', ((select count(*) from public.scratch_l12 where typ='$typ' and id < (select min(id) from public.scratch_l12 where pnid='$P')) + :i)::int);
EOF
  d0=$(deadlocks); e0=$(maxerr)
  ( PGAPPNAME=admin pgbench -n -f "$D/m.pgb" -c 4 -j 4 -T $DUR > "$D/m.out" 2>&1 ) & local p1=$!
  ( PGAPPNAME=webhook pgbench -n -f "$D/w.pgb" -c 4 -j 4 -T $DUR > "$D/w.out" 2>&1 ) & local p2=$!
  wait $p1 $p2
  local dd=$(( $(deadlocks) - d0 ))
  info "$label: merges $(grep -E 'transactions actually processed' $D/m.out | grep -o '[0-9]*$'), webhooks $(grep -E 'transactions actually processed' $D/w.out | grep -o '[0-9]*$'); merged pairs now: $(q "select count(*) from public.scratch_l12 s join public.contacts k on k.id=s.mrg where s.pnid='$P' and k.merged_into_id is not null")/$N"
  info "$label caught errors: $(qa "select who||' '||sqlstate||' '||left(msg,50)||' x'||n from (select who, sqlstate, msg, count(*) n from public.scratch_errlog where id > $e0 group by 1,2,3) s order by n desc limit 6" | tr '\n' ';')"
  # anomalies are counted for THIS run's account only (the database may hold data from earlier runs)
  local an; an=$(q "select (select count(*) from public.contact_identities i join public.contacts k on k.id=i.contact_id where i.whatsapp_account_id='$ACC' and k.merged_into_id is not null)+(select count(*) from public.conversations c join public.contacts k on k.id=c.contact_id where c.whatsapp_account_id='$ACC' and k.merged_into_id is not null)+(select count(*) from public.contact_companies cc join public.contacts k on k.id=cc.contact_id join public.conversations c on c.contact_id=k.id where c.whatsapp_account_id='$ACC' and k.merged_into_id is not null)")
  echo "$dd|$an"
}
t12() {
  local rA rB dA dB anA anB
  rA=$(run_pair A "T-LOCK-12A (attach a bsuid to the conversation of the contact being merged)" | tee /dev/stderr | tail -1); dA=${rA%%|*}; anA=${rA##*|}
  rB=$(run_pair B "T-LOCK-12B (promote a bsuid-only conversation while its contact is being merged)" | tee /dev/stderr | tail -1); dB=${rB%%|*}; anB=${rB##*|}
  check "T-LOCK-12A deadlocks (pg_stat_database delta)" "$dA" "0"
  check "T-LOCK-12B deadlocks (pg_stat_database delta)" "$dB" "0"
  check "T-LOCK-12c-A no identity/conversation/link of this run's account points at a merged contact" "$anA" "0"
  check "T-LOCK-12c-B same for the promotion run" "$anB" "0"
  check "T-LOCK-7 invariant after T-LOCK-12" "$(inv_company)" "0"
}
t13() {
  local dC; dC=$(run_pair C "T-LOCK-13 (CHARACTERISATION of the pre-existing message->lead vs merge ordering, decision D9)" | tee /dev/stderr | tail -1); dC=${dC%%|*}
  info "T-LOCK-13 RESULT (characterisation, not asserted): deadlocks detected = $dC"
}
for t in "$@"; do case "$t" in 12) t12;; 13) t13;; esac; done
echo "---- summary: $(grep -c '^PASS' $RES) PASS, $(grep -c '^FAIL' $RES) FAIL, $(grep -c '^INFO' $RES) INFO"

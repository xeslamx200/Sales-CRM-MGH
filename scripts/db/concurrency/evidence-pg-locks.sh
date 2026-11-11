#!/usr/bin/env bash
# SCRATCH ONLY. Prints the ACTUAL pg_locks / pg_blocking_pids / isolation output observed during the T-LOCK-3 interleaving (evidence, not an assertion).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
a=$(mkacct); ACC=${a%%|*}; P=${a##*|}; ph=$(phone)
KEY=$(q "select hashtextextended('kapso:id:' || '$ACC'::uuid::text || ':p:' || '$ph', 0)")
sess G; sess W; sess A
send G "select pg_advisory_lock($KEY);"; sleep 0.4
send W "show transaction_isolation; begin; $(hook $P wamid.evid.$ACC $ph)"
wait_blocked W
send A "show transaction_isolation; update public.whatsapp_accounts set default_company_id='$BETA' where id='$ACC';"
wait_blocked A
echo "### session identities"; qa "select application_name, pid, state, wait_event_type, wait_event, backend_xid from pg_stat_activity where application_name in ('G','W','A') order by application_name"
echo "### pg_blocking_pids"; qa "select application_name, pid, pg_blocking_pids(pid) from pg_stat_activity where application_name in ('W','A') order by 1"
echo "### advisory key ($KEY) split as pg_locks reports it: classid=$(q "select (($KEY >> 32) & 4294967295)") objid=$(q "select ($KEY & 4294967295)") objsubid=1"
echo "### pg_locks rows that are NOT granted (who is waiting for what)"; qa "select s.application_name, l.locktype, l.classid, l.objid, l.objsubid, l.transactionid, l.relation::regclass, l.mode, l.granted from pg_locks l join pg_stat_activity s using (pid) where s.application_name in ('G','W','A') and not l.granted order by 1"
echo "### advisory lock granted to the gate"; qa "select s.application_name, l.locktype, l.classid, l.objid, l.objsubid, l.mode, l.granted from pg_locks l join pg_stat_activity s using (pid) where s.application_name='G' and l.locktype='advisory'"
echo "### transaction isolation seen by the sessions:"; sleep 0.1; grep -h "read committed\|repeatable\|serializable" "$D/W.out" "$D/A.out" | sort | uniq -c
send G "select pg_advisory_unlock($KEY);"; wait_unblocked W; send W "commit;"; wait_unblocked A; sleep 0.4; endsess G; endsess W; endsess A
echo "### outcome: A -> $(grep -o 'whatsapp.default_company_immutable' $D/A.out | head -1); account company unchanged: $(q "select (default_company_id='$ALPHA')::text from public.whatsapp_accounts where id='$ACC'"); conversation company: $(q "select company_id=$(echo "'$ALPHA'") from public.conversations where whatsapp_account_id='$ACC'")"

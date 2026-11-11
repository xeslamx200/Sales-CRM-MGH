#!/usr/bin/env bash
# DISPOSABLE DATABASES ONLY, from a separate client container. Samples lock waits while a workload runs (start it in the background, stop it by
# creating the file named in $STOP). Every sample where at least one backend waits for a lock prints: pid, application_name, wait event,
# pg_blocking_pids(pid), the query head, and the tuple / transactionid entries of pg_locks of the waiting and the blocking backends.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
STOP=${STOP:?STOP file path required}; INTERVAL=${INTERVAL:-0.2}
n=0; waits=0
while [ ! -f "$STOP" ]; do
  n=$((n+1))
  out=$(psql -X -q -tA -c "
    with w as (select pid, application_name, wait_event_type, wait_event, pg_blocking_pids(pid) b, left(regexp_replace(query, '\s+', ' ', 'g'), 90) q
               from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock')
    select 'WAIT pid='||pid||' app='||application_name||' '||wait_event_type||'/'||wait_event||' blocked_by='||array_to_string(b, ',')||' q='||q from w
    union all
    select '  LOCK pid='||l.pid||' '||l.locktype||' '||l.mode||' granted='||l.granted from pg_locks l
    where l.locktype in ('tuple','transactionid') and (l.pid in (select pid from w) or l.pid in (select unnest(b) from w))
    order by 1" 2>&1)
  if [ -n "$out" ]; then waits=$((waits+1)); echo "--- sample $n at $(date -u +%T.%N | cut -c1-12) UTC"; echo "$out" | cut -c1-230; fi
  sleep "$INTERVAL"
done
echo "SAMPLER-DONE samples=$n with_waits=$waits"

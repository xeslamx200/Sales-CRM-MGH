# Concurrency tests for the Kapso account-row lock protocol

**Disposable databases only.** These scripts insert accounts, contacts, conversations and messages and run randomized load.
They need the proposed migrations (`supabase/migrations/`, see its README), the test fixtures and `scratch_helpers.sql`.

## Run them from a separate client container

A previous version of `lock-interleavings.sh` killed a PostgreSQL backend: its EXIT trap `kill`ed PIDs read from files, PIDs are recycled, and the
client shared a container (PID namespace) with the server. The scripts no longer kill anything and `lib.sh` / `lock-interleavings.sh` **refuse to run**
when the PostgreSQL backend they are connected to is visible in their own `/proc` (i.e. client and server share a PID namespace), unless
`SCRATCH_DB_CONFIRM=yes-this-database-is-disposable` is set and the database name contains `scratch`, `disposable` or `throwaway`.

```
# server: any PostgreSQL 16/17 container, e.g. docker run -d --name x-scratch-pg ... postgres:17
# client: a second container from the same image, e.g. docker run -d --name x-scratch-client --entrypoint sleep postgres:17 infinity
# 1. build the scratch DB (inside the server container, from the repo):
EXTRA_SQL="supabase/migrations/20261104000970_kapso_production.sql supabase/migrations/20261104000972_kapso_bsuid_contact_lock_recheck.sql \
           supabase/migrations/20261104000975_kapso_sandbox_wamid_pair_check.sql supabase/migrations/20261104000976_update_whatsapp_account.sql \
           supabase/migrations/20261104000977_kapso_contact_lock_order.sql supabase/migrations/20261104000978_kapso_event_lifecycle.sql \
           supabase/migrations/20261104000979_kapso_echo_attribution_bsuid_send_guard.sql" \
  LOCAL_DB_NAME=my_scratch PGHOST=localhost bash scripts/db/test.sh          # also runs the 19 SQL test files
psql -d my_scratch -f scripts/db/concurrency/scratch_helpers.sql
# 2. run from the CLIENT container (copy scripts/db/concurrency there):
export PGHOST=<server address> PGUSER=postgres PGDATABASE=my_scratch SCRATCH_DB_CONFIRM=yes-this-database-is-disposable
bash drive-lock-interleavings.sh 1 2 3 6 id     # T-LOCK-1/2/3/6, T-ID-1..4 (re-runnable)
bash t1.sh 4a 4b 5 14 dup3 rec                  # T-LOCK-4a/4b/5/14, T-DUP-3, T-REC choreography
bash t2.sh 10 11 8 15                           # isolation, retry job, randomized stress, starvation + telemetry
bash t3.sh 12 13                                # contact lock order vs merge_contacts (13 = characterisation of a pre-existing ordering)
bash t4.sh d1msg d1echo d1meta admin           # D1 regression, Meta characterisation, admin lock_timeout
bash t5.sh fix1 fix2                            # stale-contact regression (patch 972)
T6_EXPECT=clean bash t6.sh sub cycB cycN exh unexp retain   # patch 977: sub-transaction lock release proof + the 2-merge/1-webhook cycle (T6_EXPECT=deadlock on a Rev6+972 DB must REPRODUCE 40P01)
bash t7.sh claim held retries jobs crash protocol protect terminal races retry978 jobrace   # patch 978: lifecycle, retry job, crash windows,
                                                # protocol check, quarantine protection, terminal-state matrix, independent-session races,
                                                # retry worker vs webhook worker on the same event (jobrace)
bash t8.sh unknown known bsuidconv conflict dup cross retry conc bsuid sandbox   # patch 979: echoes never create customers (each origin),
                                                # known / BSUID / conflicting identities, retry job, concurrency, BSUID intake, BSUID-only send refusal
                                                # (needs 979 in EXTRA_SQL; on a database WITHOUT 979 it must FAIL = negative control)
STOP=/tmp/stop bash sample-waits.sh &            # optional: records pg_blocking_pids / pg_locks of every lock wait while a workload runs
```

Order: run `t2.sh` before `t7.sh` (or on a fresh database). t7 leaves older failed retry work behind, and T-LOCK-11c asserts that ONE job run
(limit 100, oldest first) processes exactly its own 100 events.

`rollback-scenarios.sh` exercises the refusal conditions of the Rev6 rollback (needs `ROLLBACK_SQL`); `evidence-pg-locks.sh` prints the real `pg_locks` /
`pg_blocking_pids` output of the T-LOCK-3 interleaving. The randomized runs have low power on their own (a mutant with the protocol removed also passes);
the deterministic interleavings are the evidence.

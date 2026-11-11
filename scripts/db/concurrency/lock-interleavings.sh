#!/usr/bin/env bash
# =============================================================================================================
# KAPSO PRODUCTION LOCK-PROTOCOL SCRATCH TESTS  -  revision 6 draft
#
# STATUS (accurate as of the revision that produced this file)
#   * Maintained copy of the Rev6 proposal's script, fixed after the Rev6 scratch run (see supabase/proposed/README.md): LF line endings,
#     the unsafe EXIT trap (which could kill a recycled PID, i.e. a PostgreSQL backend) removed, a PID-namespace guard added, and unique
#     wamids per run. Its T-LOCK-1/2/3/6 and T-ID results on the Rev6 scratch database are in the scratch-run RESULTS.
#
# SAFETY - DISPOSABLE SCRATCH DATABASES ONLY
#   Use a database created for this purpose, with 01_migration_PROPOSED_rev6.sql applied on top of the repository migrations.
#   NEVER point it at the local development database, staging or production: the tests insert and update accounts,
#   conversations, contacts and leads. The script refuses to start unless BOTH hold:
#     - SCRATCH_DB_CONFIRM=yes-this-database-is-disposable
#     - the database name contains "scratch", "disposable" or "throwaway"
#
# REQUIRED ENVIRONMENT (placeholders; there are no secrets in this file)
#   PGDATABASE PGHOST PGPORT PGUSER      usual libpq variables, pointing at the scratch database
#   PNID  ACC     phone_number_id and id of a Kapso PRODUCTION account (status 'test'/'active', no conversations) in company C_OLD
#   PNID2 ACC2    a second, unrelated Kapso production account
#   C_OLD C_NEW   ids of two REAL (non-sandbox) companies
# The webhook is exercised through the same service-role function the server calls:
#   public.ingest_kapso_inbound(pnid, wamid, from_wa_id, bsuid, origin, name, type, body, media, sent_at)
# =============================================================================================================
set -u
case "${PGDATABASE:-}" in *scratch*|*disposable*|*throwaway*) ;; *) echo "refusing: PGDATABASE must contain scratch/disposable/throwaway"; exit 3;; esac
[ "${SCRATCH_DB_CONFIRM:-}" = "yes-this-database-is-disposable" ] || { echo "refusing: SCRATCH_DB_CONFIRM not set"; exit 3; }
[ -d /proc/self ] || { echo "refusing: needs Linux /proc"; exit 3; }
_bp=$(psql -X -q -tA -c 'select pg_backend_pid()' 2>/dev/null | head -1)
[ -n "$_bp" ] || { echo "refusing: cannot reach the server"; exit 3; }
[ -d "/proc/$_bp" ] && { echo "refusing: client and server share a PID namespace (backend $_bp visible); run from a separate client container"; exit 3; }
: "${PNID:?}" "${ACC:?}" "${C_OLD:?}" "${C_NEW:?}" "${PNID2:?}" "${ACC2:?}"

# Customer phones are defined ONCE here and only ever referenced through these variables (never retyped).
PHONE_1=201000000001; PHONE_2=201000000002; PHONE_3=201000000003; PHONE_6=201000000006
FAILS=0
DIR=$(mktemp -d)
RUN="$(date +%s)$RANDOM"      # unique wamids per run: the script can be re-run on the same database
# NO kill/trap: each psql session ends by itself when the script exits and its FIFO is closed.
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS+1)); }

# ---------------------------------------------------------------- session plumbing
start() {  # start NAME : an independent psql process (application_name = NAME) reading statements from a FIFO
  mkfifo "$DIR/$1.in"
  ( PGAPPNAME="$1" psql -X -q -v ON_ERROR_STOP=0 -f "$DIR/$1.in" > "$DIR/$1.out" 2>&1 & )
  exec {fd}> "$DIR/$1.in"; eval "FD_$1=$fd"
}
send() { local v="FD_$1"; printf '%s\n' "$2" >&"${!v}"; }
ctl()  { psql -X -q -tA -c "$1"; }                       # control connection (observer), never holds locks
pid_of()   { ctl "select pid from pg_stat_activity where application_name='$1' and backend_type='client backend' order by backend_start desc limit 1"; }
blockers() { ctl "select coalesce(array_to_string(pg_blocking_pids(pid), ','), '') from pg_stat_activity where application_name='$1' and backend_type='client backend'"; }
is_blocked()      { [ "$(ctl "select count(*) from pg_stat_activity where application_name='$1' and wait_event_type='Lock'")" = "1" ]; }
wait_blocked()     { for _ in $(seq 1 150); do is_blocked "$1" && return 0; sleep 0.1; done; return 1; }
wait_not_blocked() { for _ in $(seq 1 150); do is_blocked "$1" || return 0; sleep 0.1; done; return 1; }
wait_adv_granted() {  # wait until session $1 holds advisory lock key $2
  for _ in $(seq 1 150); do
    [ "$(ctl "select count(*) from pg_locks l join pg_stat_activity s using (pid) where s.application_name='$1' and l.locktype='advisory' and l.granted and l.objsubid=1 and l.classid::bigint = (($2 >> 32) & 4294967295) and l.objid::bigint = ($2 & 4294967295)")" = "1" ] && return 0
    sleep 0.1
  done; return 1
}
# is session $1 waiting (not granted) for the advisory lock with bigint key $2 ?   (pg_locks splits a bigint key into classid/objid)
waits_on_advisory() {
  [ "$(ctl "select count(*) from pg_locks l join pg_stat_activity s using (pid) where s.application_name='$1' and l.locktype='advisory' and not l.granted and l.objsubid=1 and l.classid::bigint = (($2 >> 32) & 4294967295) and l.objid::bigint = ($2 & 4294967295)")" = "1" ]
}
hook() {  # hook WAMID PHONE : the webhook statement; the phone value is whatever the caller passes (always a PHONE_* variable)
  echo "select * from public.ingest_kapso_inbound('$PNID','$1','$2',null,null,'T','text','hi',null,now());"
}
# the advisory key the helper takes for (account, phone): derived from the SAME variables that are passed to hook()
phone_key() { ctl "select hashtextextended('kapso:id:' || '$1'::uuid::text || ':p:' || '$2', 0)"; }     # phone_key ACCOUNT_ID PHONE
conv_companies() { ctl "select coalesce(string_agg(company_id::text, ','), '') from public.conversations where whatsapp_account_id='$ACC'"; }
account_company() { ctl "select default_company_id from public.whatsapp_accounts where id='$ACC'"; }

# ---- T-LOCK-1  account update WINS, webhook waits, then uses the NEW company ----------------------------------------
t_lock_1() {
  start A; start W
  send A "begin; update public.whatsapp_accounts set default_company_id='$C_NEW' where id='$ACC';"
  sleep 0.3; send W "begin; $(hook wamid.l1.$RUN "$PHONE_1")"
  wait_blocked W || { fail "T-LOCK-1 webhook never blocked"; return; }
  [ "$(blockers W)" = "$(pid_of A)" ] || fail "T-LOCK-1 W is not blocked by A (blockers: $(blockers W))"
  send A "commit;"; wait_not_blocked W; send W "commit;"; sleep 0.5
  [ "$(conv_companies)" = "$C_NEW" ] && pass "T-LOCK-1" || fail "T-LOCK-1 (conversation companies: $(conv_companies))"
}

# ---- T-LOCK-2  first conversation WINS, account update waits, then is REJECTED ----------------------------------------
t_lock_2() {
  start W; start A
  send W "begin; $(hook wamid.l2.$RUN "$PHONE_2")"                 # holds SHARE + an uncommitted conversation under the current company
  sleep 0.3; send A "update public.whatsapp_accounts set default_company_id='$C_NEW' where id='$ACC';"
  wait_blocked A || { fail "T-LOCK-2 update never blocked"; return; }
  [ "$(blockers A)" = "$(pid_of W)" ] || fail "T-LOCK-2 A is not blocked by W (blockers: $(blockers A))"
  send W "commit;"; wait_not_blocked A; sleep 0.3
  grep -q "default_company_immutable" "$DIR/A.out" && [ "$(account_company)" = "$C_OLD" ] && pass "T-LOCK-2" || fail "T-LOCK-2"
}

# ---- T-LOCK-3 (corrected in rev 6)  webhook is parked on the identity advisory lock WHILE holding the account SHARE lock;
#      the account update must then block on the WEBHOOK (not on the gate). Order asserted from pg_locks/pg_blocking_pids.
t_lock_3() {
  start G; start W; start A
  local KEY; KEY=$(phone_key "$ACC" "$PHONE_3")              # same $ACC and same $PHONE_3 that hook() receives below
  [ -n "$KEY" ] || { fail "T-LOCK-3 could not derive the advisory key"; return; }
  send G "select pg_advisory_lock($KEY);"                     # session-level gate holding exactly the key the helper will request
  wait_adv_granted G "$KEY" || { fail "T-LOCK-3 gate not granted"; return; }

  send W "begin; $(hook wamid.l3.$RUN "$PHONE_3")"                 # W: kapso_resolve_account -> FOR SHARE on the account row (L1) -> advisory (L2)
  wait_blocked W || { fail "T-LOCK-3 W never blocked"; return; }
  waits_on_advisory W "$KEY"                                  || fail "T-LOCK-3 assert-1: W is not waiting for the expected advisory key $KEY"
  [ "$(blockers W)" = "$(pid_of G)" ]                         || fail "T-LOCK-3 assert-2: W's blocker is not the gate (blockers: $(blockers W))"

  send A "update public.whatsapp_accounts set default_company_id='$C_NEW' where id='$ACC';"   # must wait for W's SHARE on the account row
  wait_blocked A || { fail "T-LOCK-3 A never blocked"; return; }
  [ "$(blockers A)" = "$(pid_of W)" ]                         || fail "T-LOCK-3 assert-3: A is not blocked by W (blockers: $(blockers A); W=$(pid_of W); gate=$(pid_of G))"
  # A waits on W's transaction id (or on the tuple of whatsapp_accounts), never on an advisory lock
  local AW; AW=$(ctl "select l.locktype || ':' || coalesce(l.transactionid::text, l.relation::regclass::text) from pg_locks l join pg_stat_activity s using (pid) where s.application_name='A' and not l.granted limit 1")
  local WX; WX=$(ctl "select backend_xid::text from pg_stat_activity where application_name='W' and backend_type='client backend'")
  case "$AW" in "transactionid:$WX"|"tuple:whatsapp_accounts"|"tuple:public.whatsapp_accounts") ;; *) fail "T-LOCK-3 assert-4: A waits on '$AW' (W xid: '$WX')";; esac
  waits_on_advisory W "$KEY"                                  || fail "T-LOCK-3 assert-5: W left the advisory wait before the gate was released (order broken)"

  send G "select pg_advisory_unlock($KEY);"                   # release the gate: W proceeds, creates its conversation, commits
  wait_not_blocked W; send W "commit;"; wait_not_blocked A; sleep 0.3
  grep -q "default_company_immutable" "$DIR/A.out" && [ "$(account_company)" = "$C_OLD" ] && pass "T-LOCK-3 (assertions 1-5 + final state)" || fail "T-LOCK-3 final state"
}

# ---- T-LOCK-6  an UNRELATED account is not delayed by an open update of ACC ----------------------------------------
t_lock_6() {
  start A; start W2
  send A "begin; update public.whatsapp_accounts set display_name = display_name where id='$ACC';"   # holds ACC's write lock open
  send W2 "select * from public.ingest_kapso_inbound('$PNID2','wamid.l6.$RUN','$PHONE_6',null,null,'T','text','hi',null,now());"
  sleep 1; is_blocked W2 && fail "T-LOCK-6 account 2 was blocked" || pass "T-LOCK-6 (account 2 not blocked)"
  send A "rollback;"
}

# ---- T-ID-1..4  identity immutability (D8), single session, no concurrency --------------------------------------------
t_identity() {
  local out
  out=$(psql -X -q -tA -c "update public.whatsapp_accounts set provider = 'meta' where id='$ACC'" 2>&1);       echo "$out" | grep -q "provider_immutable" && pass "T-ID-1 provider change rejected (no conversations)" || fail "T-ID-1: $out"
  out=$(psql -X -q -tA -c "update public.whatsapp_accounts set environment = 'sandbox' where id='$ACC'" 2>&1);  echo "$out" | grep -q "provider_immutable" && pass "T-ID-2 environment change rejected (no conversations)" || fail "T-ID-2: $out"
  out=$(psql -X -q -tA -c "update public.whatsapp_accounts set provider = provider, environment = environment, display_name = display_name where id='$ACC'" 2>&1)
  [ -z "$out" ] || [ "$out" = "UPDATE 1" ] && pass "T-ID-3 whole-row save with unchanged identity succeeds" || fail "T-ID-3: $out"
  out=$(psql -X -q -tA -c "update public.whatsapp_accounts set environment = null where id='$ACC'" 2>&1)           # derive trigger restores the old value
  [ "$(ctl "select environment from public.whatsapp_accounts where id='$ACC'")" = "production" ] && pass "T-ID-4 NULL environment is re-derived, not applied" || fail "T-ID-4: $out"
}

case "${1:-}" in
  1) t_lock_1;; 2) t_lock_2;; 3) t_lock_3;; 6) t_lock_6;; id) t_identity;;
  *) echo "usage: $0 {1|2|3|6|id}   (T-LOCK-4/5/7-17: see plan section 4; they need parallel clients / pgbench)"; exit 2;;
esac
[ "$FAILS" = "0" ] || { echo "$FAILS check(s) FAILED"; exit 1; }

#!/usr/bin/env bash
# SCRATCH ONLY. Shared helpers for the Kapso concurrency tests (need the Rev6 schema + scratch_helpers.sql in a DISPOSABLE database).
# Run them from a CLIENT container that is separate from the PostgreSQL server container (see README.md). Nothing here kills a process:
# sessions end when their FIFO is closed.
set -u
export PGPORT=5432 PGUSER=postgres PGDATABASE=${PGDATABASE:-kapso_rev6_scratch}
case "$PGDATABASE" in *scratch*|*disposable*|*throwaway*) ;; *) echo "refusing: database name must contain scratch/disposable/throwaway" >&2; exit 3;; esac
[ "${SCRATCH_DB_CONFIRM:-}" = "yes-this-database-is-disposable" ] || { echo "refusing: SCRATCH_DB_CONFIRM=yes-this-database-is-disposable is required" >&2; exit 3; }
: "${PGHOST:?PGHOST (scratch server address) required}"
# The server's backend processes must NOT be visible in this PID namespace (an earlier version of the harness killed a PostgreSQL backend
# through a recycled PID when client and server shared a container). /proc/<backend pid> existing here means they share one: refuse.
[ -d /proc/self ] || { echo "refusing: this harness needs Linux /proc to verify it runs apart from the server" >&2; exit 3; }
_bp=$(psql -X -q -tA -c 'select pg_backend_pid()' 2>/dev/null | head -1)
[ -n "$_bp" ] || { echo "refusing: cannot reach the server" >&2; exit 3; }
[ -d "/proc/$_bp" ] && { echo "refusing: PostgreSQL backend $_bp is visible here, so client and server share a PID namespace; run from a separate client container" >&2; exit 3; }
D=${D:-$(mktemp -d)}
q()  { psql -X -q -tA -c "$1" | head -${2:-1}; }
qa() { psql -X -q -tA -c "$1"; }
next() { psql -X -q -tA -c "select nextval('public.scratch_ctr')" | head -1; }   # persistent, unique across runs
ALPHA=$(q "select id from public.companies where slug='alpha'"); BETA=$(q "select id from public.companies where slug='beta'"); GAMMA=$(q "select id from public.companies where slug='gamma'")
RES="$D/results.txt"; : > "$RES"
pass() { echo "PASS  $1${2:+  -- $2}" | tee -a "$RES"; }
fail() { echo "FAIL  $1${2:+  -- $2}" | tee -a "$RES"; }
info() { echo "INFO  $1" | tee -a "$RES"; }
check() { if [ "$2" = "$3" ]; then pass "$1" "$2"; else fail "$1" "expected '$3' got '$2'"; fi; }

# fresh production account without conversations in company $1 (default alpha); prints "id|pnid"
mkacct() {
  local n; n=$(next); local co=${1:-$ALPHA}
  local id; id=$(q "insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status) values ('$co','C$n','+1555$(printf %07d $n)','CONC_$n','kapso','production','coexistence','test') returning id")
  echo "$id|CONC_$n"
}
phone() { echo "20100$(printf %07d $(next))"; }
# ---- sessions (psql reading a FIFO)
sess() { mkfifo "$D/$1.in"; ( PGAPPNAME="$1" psql -X -q -v ON_ERROR_STOP=0 -f "$D/$1.in" > "$D/$1.out" 2>&1 ) & exec {fd}> "$D/$1.in"; eval "FD_$1=$fd"; }
send() { local v="FD_$1"; printf '%s\n' "$2" >&"${!v}"; }
endsess() { local v="FD_$1"; eval "exec ${!v}>&-"; }
pid_of() { q "select pid from pg_stat_activity where application_name='$1' and backend_type='client backend' order by backend_start desc limit 1"; }
blockers() { q "select coalesce(array_to_string(pg_blocking_pids(pid), ','), '') from pg_stat_activity where application_name='$1' and backend_type='client backend' order by backend_start desc limit 1"; }
is_blocked() { [ "$(q "select count(*) from pg_stat_activity where application_name='$1' and wait_event_type='Lock'")" = "1" ]; }
wait_blocked() { for _ in $(seq 1 200); do is_blocked "$1" && return 0; sleep 0.05; done; return 1; }
wait_unblocked() { for _ in $(seq 1 300); do is_blocked "$1" || return 0; sleep 0.05; done; return 1; }
wait_out() { for _ in $(seq 1 300); do grep -q "$2" "$D/$1.out" 2>/dev/null && return 0; sleep 0.05; done; return 1; }   # wait for text in a session's output
hook() { echo "select * from public.ingest_kapso_inbound('$1','$2','$3',null,null,'T','text','hi',null,now());"; }   # hook PNID WAMID PHONE
# ---- invariants / counters
inv_company() { q "select count(*) from public.conversations c join public.whatsapp_accounts a on a.id=c.whatsapp_account_id where a.provider='kapso' and a.environment='production' and c.company_id <> a.default_company_id"; }
log_marker() { docker_log_marker=$(q "select now()::text"); }

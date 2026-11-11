#!/usr/bin/env bash
# Two simultaneous bookings for the LAST seat of a group (migration 985): exactly one must succeed, the other must be refused with booking.group_full.
# Needs a scratch database with migrations 27 + 970..985 and tests/_helpers + _fixtures loaded. Run: PSQL='psql -X -q -At -d <db>' bash t9_booking_capacity.sh
# (Docker example: PSQL='docker exec -i <container> psql -U postgres -X -q -At -d <db>'). Creates committed rows in that scratch database.
set -uo pipefail
: "${PSQL:?set PSQL to the psql command for the scratch database}"
$PSQL <<'SQL'
do $$ declare w uuid; g uuid; c uuid; i int; begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'CC W', 'workshop') returning id into w;
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values (tests.ref('alpha'), w, 'EG', 'online', 'EGP', 100);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity) values (tests.ref('alpha'), w, 'Last seat', array[date '2027-03-01'], date '2027-03-01', date '2027-03-01', 1) returning id into g;
  insert into tests.refs values ('ccg', g);
  for i in 1..2 loop
    insert into public.contacts (full_name, phone_e164) values ('CC ' || i, '+2010555000' || i) returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
    insert into tests.refs values ('cc' || i, c);
  end loop; end $$;
SQL
A=$(mktemp); B=$(mktemp)
( $PSQL <<'SQL' >"$A" 2>&1 ) &
begin; select tests.login('agent_a1'); select 'A booked: ' || (public.create_workshop_booking(tests.ref('cc1'), tests.ref('ccg'), 'EG', 'online') is not null); select pg_sleep(3); commit;
SQL
sleep 1
$PSQL <<'SQL' >"$B" 2>&1
begin; select tests.login('agent_a1');
do $$ begin perform public.create_workshop_booking(tests.ref('cc2'), tests.ref('ccg'), 'EG', 'online'); raise notice 'B booked'; exception when others then raise notice 'B refused: %', sqlerrm; end $$; commit;
SQL
wait
n=$($PSQL -c "select count(*) from public.workshop_bookings where group_id = tests.ref('ccg')")
if grep -q "A booked: true" "$A" && grep -q "B refused: booking.group_full" "$B" && [ "$n" = "1" ]; then echo "PASS t9: one booking, the second refused with booking.group_full"; else echo "FAIL t9"; cat "$A" "$B"; exit 1; fi

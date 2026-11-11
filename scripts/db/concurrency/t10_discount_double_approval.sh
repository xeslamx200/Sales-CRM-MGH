#!/usr/bin/env bash
# Two approvers decide the SAME pending discount request at the same moment (migration 986): exactly one approval takes effect, the other is refused with
# discount.invalid_transition, and the booking carries the discount exactly once. Needs a scratch database with 27 + 970..986 + tests/_helpers + _fixtures.
# Run: PSQL='psql -X -q -At -d <db>' bash t10_discount_double_approval.sh   (Docker: PSQL='docker exec -i <container> psql -U postgres -X -q -At -d <db>')
set -uo pipefail
: "${PSQL:?set PSQL to the psql command for the scratch database}"
$PSQL <<'SQL'
do $$ declare w uuid; g uuid; c uuid; b uuid; begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'T10 W', 'workshop') returning id into w;
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values (tests.ref('alpha'), w, 'EG', 'online', 'EGP', 1000);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values (tests.ref('alpha'), w, 'T10 G', array[date '2028-03-01'], date '2028-03-01', date '2028-03-01') returning id into g;
  insert into public.contacts (full_name, phone_e164) values ('T10 c', '+2010555111001') returning id into c;
  insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
  insert into tests.refs values ('t10g', g), ('t10c', c);
end $$;
begin; select tests.login('agent_a1'); select public.create_workshop_booking(tests.ref('t10c'), tests.ref('t10g'), 'EG', 'online', 'percent', 20, 'concurrency test') is not null; commit;
select id from public.booking_discount_requests where status = 'pending' order by requested_at desc limit 1;
SQL
RID=$($PSQL -c "select id from public.booking_discount_requests where status = 'pending' order by requested_at desc limit 1" | tr -d '[:space:]')
A=$(mktemp); B=$(mktemp)
( $PSQL <<SQL >"$A" 2>&1 ) &
begin; select tests.login('mgr_a');
do \$\$ begin perform public.approve_booking_discount('$RID'); raise notice 'A approved'; end \$\$;
select pg_sleep(3); commit;
SQL
sleep 1
$PSQL <<SQL >"$B" 2>&1
begin; select tests.login('admin_a');
do \$\$ begin perform public.approve_booking_discount('$RID'); raise notice 'B approved'; exception when others then raise notice 'B refused: %', sqlerrm; end \$\$; commit;
SQL
wait
n=$($PSQL -c "select count(*) from public.booking_discount_requests where status = 'approved' and id = '$RID'" | tr -d '[:space:]')
f=$($PSQL -c "select final_price from public.workshop_bookings b join public.booking_discount_requests r on r.booking_id = b.id where r.id = '$RID'" | tr -d '[:space:]')
if grep -q "A approved" "$A" && grep -q "B refused: discount.invalid_transition" "$B" && [ "$n" = "1" ] && [ "$f" = "800.00" ]; then echo "PASS t10: one approval applied (final 800.00), the second refused with discount.invalid_transition"; else echo "FAIL t10 (n=$n final=$f)"; cat "$A" "$B"; exit 1; fi

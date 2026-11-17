-- A group with its own price (private groups, migration 1019).
begin;
select tests.logout();

do $$
declare w uuid; c uuid; i int;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Private W', 'workshop') returning id into w;
  insert into tests.refs values ('pw', w);
  -- the workshop has a country price only for QA online; session price 120
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price, session_price) values (tests.ref('alpha'), w, 'QA', 'online', 'QAR', 500, 120);
  for i in 1..2 loop
    insert into public.contacts (full_name, phone_e164, email) values ('Priv ' || i, '+2010888' || lpad(i::text, 5, '0'), 'priv' || i || '@example.test') returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
    insert into tests.refs values ('p' || i, c);
  end loop;
end $$;
create or replace function pg_temp.bk(p_user text, p_contact text, p_group text, p_country text, p_att text, p_kind text default 'full', p_date date default null)
returns uuid language plpgsql as $$ begin perform tests.login(p_user);
  return public.create_workshop_booking(p_contact_id := tests.ref(p_contact), p_group_id := tests.ref(p_group), p_country := p_country, p_attendance := p_att, p_kind := p_kind, p_session_date := p_date); end $$;
create temp table r (a uuid, b uuid);
insert into r default values;
grant all on r to public;

select tests.login('agent_a1');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw'), 'X', array[date '2026-12-06'], 1, null, true, 900, 'QAR')$q$, 'auth.forbidden', 'an employee cannot set a group price');
select tests.login('admin_a');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw'), 'X', array[date '2026-12-06'], 1, null, true, 900, null)$q$, 'group.invalid_price', 'a price needs a currency');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw'), 'X', array[date '2026-12-06'], 1, null, true, null, 'QAR')$q$, 'group.invalid_price', 'a currency needs a price');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw'), 'X', array[date '2026-12-06'], 1, null, true, 0, 'QAR')$q$, 'group.invalid_price', 'zero refused');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw'), 'X', array[date '2026-12-06'], 1, null, true, 9.999, 'QAR')$q$, 'group.invalid_price', 'two decimals at most');
select tests.throws($q$select public.set_workshop_group(null, tests.ref('pw'), 'X', array[date '2026-12-06'], 1, null, true, 900, 'QA')$q$, 'group.invalid_price', 'currency is 3 letters');
insert into tests.refs values ('pg1', public.set_workshop_group(null, tests.ref('pw'), 'Ali', array[date '2026-12-06', date '2026-12-08'], null, null, true, 900, 'qar'));
insert into tests.refs values ('pg2', public.set_workshop_group(null, tests.ref('pw'), 'Sara', array[date '2026-12-20'], null, null, true, 1500.5, 'USD'));
insert into tests.refs values ('pg3', public.set_workshop_group(null, tests.ref('pw'), 'Plain', array[date '2026-12-25'], null, null));
select tests.eq((select group_price || ' ' || group_currency from public.workshop_groups where id = tests.ref('pg1')), '900.00 QAR', 'the group stores its own price (currency upper-cased)');
select tests.eq((select (metadata->>'group_price') from public.audit_logs where action = 'workshop.group_set' and (metadata->>'group_id') = tests.ref('pg1')::text), '900', 'the price is audited');

-- booking: each private group sells at its own price, in its own currency, whatever the country / attendance
update r set a = pg_temp.bk('admin_a', 'p1', 'pg1', 'QA', 'online');
select tests.eq((select list_price || ' ' || currency from public.workshop_bookings where id = (select a from r)), '900.00 QAR', 'the group price is the list price');
update r set b = pg_temp.bk('admin_a', 'p2', 'pg2', 'EG', 'offline');
select tests.eq((select list_price || ' ' || currency from public.workshop_bookings where id = (select b from r)), '1500.50 USD', 'another group, another price and currency; no country price row needed');
-- a group without its own price still needs the country price
select tests.throws($q$select pg_temp.bk('admin_a', 'p1', 'pg3', 'EG', 'offline')$q$, 'booking.price_not_configured', 'no group price: the country price is required as before');
-- a session of a priced group: the country session price only in the group currency
select tests.throws($q$select pg_temp.bk('admin_a', 'p2', 'pg2', 'QA', 'online', 'session', date '2026-12-20')$q$, 'booking.session_price_not_configured', 'the session price row is QAR, the group is USD: refused');
select pg_temp.bk('admin_a', 'p2', 'pg1', 'QA', 'online', 'session', date '2026-12-06');
select tests.ok(true, 'a session of a QAR group uses the QAR session price');
-- changing the group price later does not touch the booking already made
select tests.login('admin_a');
select public.set_workshop_group(tests.ref('pg1'), tests.ref('pw'), 'Ali', array[date '2026-12-06', date '2026-12-08'], null, null, true, 1000, 'QAR');
select tests.eq((select list_price from public.workshop_bookings where id = (select a from r)), 900::numeric, 'a booking keeps the price it was made at');
-- clearing the price falls back to the country price
select public.set_workshop_group(tests.ref('pg1'), tests.ref('pw'), 'Ali', array[date '2026-12-06', date '2026-12-08'], null, null, true, null, null);
select tests.eq((select group_price is null from public.workshop_groups where id = tests.ref('pg1')), true, 'the group price can be cleared');
rollback;

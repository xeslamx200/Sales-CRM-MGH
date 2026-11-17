-- Single-session bookings (own price) and repeat bookings of the same customer in one group (migration 1018).
begin;
select tests.logout();

do $$
declare w uuid; g uuid; g2 uuid; c uuid; i int;
begin
  insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Session W', 'workshop') returning id into w;
  insert into tests.refs values ('sw', w);
  insert into public.workshop_prices (company_id, offering_id, country, attendance, currency, price) values
    (tests.ref('alpha'), w, 'QA', 'online', 'QAR', 500), (tests.ref('alpha'), w, 'QA', 'offline', 'QAR', 750);
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on, capacity) values
    (tests.ref('alpha'), w, 'SG1', array[date '2026-12-06', date '2026-12-08', date '2026-12-10'], date '2026-12-06', date '2026-12-10', 1) returning id into g;
  insert into public.workshop_groups (company_id, offering_id, name, sessions, starts_on, ends_on) values
    (tests.ref('alpha'), w, 'SG2', array[date '2026-12-20'], date '2026-12-20', date '2026-12-20') returning id into g2;
  insert into tests.refs values ('sg1', g), ('sg2', g2);
  for i in 1..3 loop
    insert into public.contacts (full_name, phone_e164, email) values ('Sess ' || i, '+2010777' || lpad(i::text, 5, '0'), 'sess' || i || '@example.test') returning id into c;
    insert into public.contact_companies (contact_id, company_id, owner_id) values (c, tests.ref('alpha'), tests.uid('agent_a1'));
    insert into tests.refs values ('s' || i, c);
  end loop;
end $$;
create or replace function pg_temp.bk(p_user text, p_contact text, p_group text, p_att text, p_kind text, p_date date, p_confirm boolean default false, p_dt text default 'none', p_dv numeric default 0, p_reason text default null)
returns uuid language plpgsql as $$ begin perform tests.login(p_user);
  return public.create_workshop_booking(p_contact_id := tests.ref(p_contact), p_group_id := tests.ref(p_group), p_country := 'QA', p_attendance := p_att,
    p_discount_type := p_dt, p_discount_value := p_dv, p_discount_reason := p_reason, p_kind := p_kind, p_session_date := p_date, p_confirm_repeat := p_confirm); end $$;
create temp table r (a uuid, b uuid, c uuid, d uuid, e uuid);
insert into r default values;
grant all on r to public;

-- the session price: who may set it, and what it needs
select tests.login('agent_a1');
select tests.throws($q$select public.set_workshop_session_price(tests.ref('sw'), 'QA', 'online', 150)$q$, 'auth.forbidden', 'an employee cannot set the session price');
select tests.login('admin_a');
select tests.throws($q$select public.set_workshop_session_price(tests.ref('sw'), 'SA', 'online', 150)$q$, 'price.not_found', 'a session price needs the workshop price row');
select tests.throws($q$select public.set_workshop_session_price(tests.ref('sw'), 'QA', 'online', 0)$q$, 'price.invalid_value', 'zero refused');
select public.set_workshop_session_price(tests.ref('sw'), 'QA', 'online', 150);
select tests.eq((select session_price from public.workshop_prices where offering_id = tests.ref('sw') and country = 'QA' and attendance = 'online'), 150::numeric, 'the session price is stored beside the workshop price');
select tests.eq((select count(*) from public.audit_logs where action = 'workshop.session_price_set' and entity_id = tests.ref('sw')), 1::bigint, 'the change is audited');

-- booking one session
select tests.throws($q$select pg_temp.bk('admin_a', 's1', 'sg1', 'offline', 'session', date '2026-12-06')$q$, 'booking.session_price_not_configured', 'no session price for this country / attendance: refused');
select tests.throws($q$select pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'session', date '2026-12-07')$q$, 'booking.invalid_session', 'the date must be one of the group sessions');
select tests.throws($q$select pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'session', null)$q$, 'booking.invalid_session', 'a session booking needs its date');
select tests.throws($q$select pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'full', date '2026-12-06')$q$, 'booking.invalid_value', 'a whole-workshop booking has no session date');
select tests.throws($q$select pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'weekly', null)$q$, 'booking.invalid_value', 'unknown kind refused');
update r set a = pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'session', date '2026-12-06');
select tests.eq((select booking_kind || ' ' || session_date || ' ' || list_price || ' ' || final_price || ' ' || status from public.workshop_bookings where id = (select a from r)),
  'session 2026-12-06 150.00 150.00 booked', 'a session is booked at the session price');
update r set b = pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'session', date '2026-12-08');
select tests.ok(true, 'another session of the same group by the same customer needs no confirmation');
select tests.throws($q$select pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'session', date '2026-12-06')$q$, 'booking.repeat_unconfirmed', 'the same session again must be confirmed');
update r set c = pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'session', date '2026-12-06', true);
select tests.eq((select count(*) from public.workshop_bookings where contact_id = tests.ref('s1') and group_id = tests.ref('sg1')), 3::bigint, 'the confirmed repeat is recorded');
select tests.eq((select (metadata->>'repeat_confirmed') from public.audit_logs where action = 'booking.created' and entity_id = (select c from r)), 'true', 'the audit log says the repeat was confirmed');

-- a discount applies to the session price
select tests.eq((select final_price from public.workshop_bookings where id = (select b from r)), 150::numeric, 'no discount: 150');
update r set d = pg_temp.bk('admin_a', 's2', 'sg1', 'online', 'session', date '2026-12-10', false, 'fixed', 15, 'friend');
select tests.eq((select list_price || '>' || final_price from public.workshop_bookings where id = (select d from r)), '150.00>135.00', 'a fixed discount is taken from the session price');

-- a whole-workshop booking after a session booking: repeat of the group; seats count customers, not rows
select tests.throws($q$select pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'full', null)$q$, 'booking.repeat_unconfirmed', 'the whole workshop after a session of the same group is a repeat: confirm it');
update r set e = pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'full', null, true);
select tests.eq((select list_price from public.workshop_bookings where id = (select e from r)), 500::numeric, 'whole workshop at the workshop price');
select tests.throws($q$select pg_temp.bk('admin_a', 's3', 'sg1', 'online', 'full', null)$q$, 'booking.group_full', 'capacity 1: another customer cannot take a seat');
select tests.eq((select booked from public.workshop_group_stats(tests.ref('sw')) where group_id = tests.ref('sg1')), 1::bigint, 'seats taken = customers with a whole-workshop booking (sessions take none)');
select pg_temp.bk('admin_a', 's1', 'sg1', 'online', 'full', null, true);
select tests.ok(true, 'the same customer paying the whole workshop twice (confirmed) takes no second seat');

-- a whole-workshop booking in a second, unfinished group is still refused
select tests.throws($q$select pg_temp.bk('admin_a', 's1', 'sg2', 'online', 'full', null)$q$, 'booking.duplicate', 'a second unfinished group of the same workshop is still refused');

-- what the form shows
select tests.login('agent_a1');
select tests.eq((select count(*) from public.booking_existing_for(tests.ref('s1'), tests.ref('sg1'))), 5::bigint, 'the form can list what the customer already has in the group');
select tests.login('agent_b');
select tests.throws($q$select * from public.booking_existing_for(tests.ref('s1'), tests.ref('sg1'))$q$, 'auth.forbidden', 'another company sees nothing');

-- immutable
select tests.logout();
select tests.throws($q$update public.workshop_bookings set session_date = date '2026-12-10' where id = (select a from r)$q$, 'booking.immutable', 'the kind and the session date cannot change afterwards');
rollback;

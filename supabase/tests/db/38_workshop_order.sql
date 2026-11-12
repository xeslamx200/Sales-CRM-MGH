-- Workshop order (migration 1001): a company admin orders the workshops of their company; nobody else can; it never crosses companies or the sharing sync.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with supabase/migrations + _helpers.sql + _fixtures.sql> -f supabase/tests/db/38_workshop_order.sql
begin;
select tests.logout();
insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Order A', 'workshop'), (tests.ref('alpha'), 'Order B', 'workshop'), (tests.ref('alpha'), 'Order C', 'course'), (tests.ref('beta'), 'Order Beta', 'course');
create temp table o as select name, id from public.company_offerings where name like 'Order %';
grant select on o to public;

select tests.login('admin_a');
select tests.eq(public.set_offering_order(tests.ref('alpha'), array[(select id from o where name = 'Order C'), (select id from o where name = 'Order A')]), 2, 'a company admin orders workshops: C first, then A');
select tests.eq((select string_agg(name, ',' order by sort_order) from public.company_offerings where company_id = tests.ref('alpha') and sort_order is not null), 'Order C,Order A', 'the order is stored');
select tests.eq((select sort_order is null from public.company_offerings where name = 'Order B'), true, 'a workshop not in the list has no place yet');
select public.set_offering_order(tests.ref('alpha'), array[(select id from o where name = 'Order B')]);
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('alpha') and sort_order is not null), 1::bigint, 'a new list replaces the old one');
select tests.throws(format($q$select public.set_offering_order(%L::uuid, array[%L::uuid])$q$, tests.ref('alpha'), (select id from o where name = 'Order Beta')), 'offering.invalid_order', 'a workshop of another company is refused');
select tests.throws(format($q$select public.set_offering_order(%L::uuid, array[%L::uuid, %L::uuid])$q$, tests.ref('alpha'), (select id from o where name = 'Order A'), (select id from o where name = 'Order A')), 'offering.invalid_order', 'a repeated id is refused');
select tests.throws(format($q$select public.set_offering_order(%L::uuid, array[]::uuid[])$q$, tests.ref('beta')), 'auth.forbidden', 'an admin of another company cannot order this one');
select tests.logout();

select tests.login('agent_a1');
select tests.throws(format($q$select public.set_offering_order(%L::uuid, array[]::uuid[])$q$, tests.ref('alpha')), 'auth.forbidden', 'an agent cannot order workshops');
select tests.logout();
select tests.throws(format($q$select public.set_offering_order(%L::uuid, array[]::uuid[])$q$, tests.ref('alpha')), 'auth.forbidden', 'nobody signed in cannot');

-- sharing: ordering does not travel to the paired company
select app.share_workshops(tests.ref('alpha'), tests.ref('beta'));
select tests.login('admin_a');
select public.set_offering_order(tests.ref('alpha'), array[(select id from o where name = 'Order A')]);
select tests.logout();
select tests.eq((select count(*) from public.company_offerings where company_id = tests.ref('beta') and sort_order is not null), 0::bigint, 'the order of one company never moves the other company''s list');
rollback;

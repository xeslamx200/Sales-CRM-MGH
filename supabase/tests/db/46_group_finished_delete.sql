-- Migration 1009: a workshop group can be marked finished (paused, history kept) or deleted when nobody booked it; paired companies stay in step.
begin;
select tests.logout();
select tests.login('admin_a');
insert into public.company_offerings (company_id, name, kind) values (tests.ref('alpha'), 'Finish Test Workshop', 'workshop');
select public.set_workshop_group(null, (select id from public.company_offerings where name = 'Finish Test Workshop'), 'Run 1', array[date '2026-12-06'], 10, 'online', true);
select public.set_workshop_group(null, (select id from public.company_offerings where name = 'Finish Test Workshop'), 'Run 2', array[date '2026-12-20'], 10, 'online', true);
create temp table g as select id, name from public.workshop_groups where name in ('Run 1', 'Run 2');
grant select on g to public;

select public.set_workshop_group_finished((select id from g where name = 'Run 1'), true);
select tests.eq((select is_active::text || '/' || (finished_at is not null)::text from public.workshop_groups where id = (select id from g where name = 'Run 1')), 'false/true', 'finished: paused (no new bookings) and stamped');
select tests.eq((select is_active::text || '/' || (finished_at is not null)::text from public.workshop_groups where id = (select id from g where name = 'Run 2')), 'true/false', 'the other group is untouched');
select public.set_workshop_group_finished((select id from g where name = 'Run 1'), false);
select tests.eq((select is_active::text || '/' || (finished_at is null)::text from public.workshop_groups where id = (select id from g where name = 'Run 1')), 'true/true', 'reopened: active again, no finished stamp');
select tests.logout();

-- other people cannot
select tests.login('agent_a1');
select tests.throws(format($q$select public.set_workshop_group_finished(%L::uuid, true)$q$, (select id from g where name = 'Run 2')), 'auth.forbidden', 'an agent cannot finish a group');
select tests.throws(format($q$select public.delete_workshop_group(%L::uuid)$q$, (select id from g where name = 'Run 2')), 'auth.forbidden', 'an agent cannot delete a group');
select tests.logout();
select tests.login('admin_b');
select tests.throws(format($q$select public.delete_workshop_group(%L::uuid)$q$, (select id from g where name = 'Run 2')), 'auth.forbidden', 'an admin of another company cannot delete it');
select tests.logout();

-- a booked group cannot be deleted
select tests.service();
insert into public.contacts (full_name, phone_e164) values ('Group Booker', '+97488000001');
insert into public.contact_companies (contact_id, company_id) select id, tests.ref('alpha') from public.contacts where phone_e164 = '+97488000001';
select tests.login('admin_a');
select public.set_workshop_price((select id from public.company_offerings where name = 'Finish Test Workshop'), 'QA', 'online', 'QAR', 500);
select public.create_workshop_booking((select id from public.contacts where phone_e164 = '+97488000001'), (select id from g where name = 'Run 2'), 'QA', 'online', 'none', 0, null, null);
select tests.throws(format($q$select public.delete_workshop_group(%L::uuid)$q$, (select id from g where name = 'Run 2')), 'group.has_bookings', 'a group with a booking cannot be deleted');
select tests.eq(public.delete_workshop_group((select id from g where name = 'Run 1')), 1, 'a group nobody booked is deleted');
select tests.eq((select count(*) from public.workshop_groups where name = 'Run 1'), 0::bigint, '... and it is gone');
select tests.logout();

-- paired companies: the copy goes with it
select app.share_workshops(tests.ref('alpha'), tests.ref('beta'));
select tests.login('admin_a');
select public.set_workshop_group(null, (select id from public.company_offerings where name = 'Finish Test Workshop' and company_id = tests.ref('alpha')), 'Run 3', array[date '2027-01-10'], 5, null, true);
select tests.logout();
select tests.eq((select count(*) from public.workshop_groups where name = 'Run 3'), 2::bigint, 'paired: the group exists in both companies');
select tests.login('admin_a');
select public.set_workshop_group_finished((select id from public.workshop_groups where name = 'Run 3' and company_id = tests.ref('alpha')), true);
select tests.logout();
select tests.eq((select count(*) from public.workshop_groups where name = 'Run 3' and finished_at is not null and not is_active), 2::bigint, 'paired: finishing it in one company finishes the copy too');
select tests.login('admin_a');
select tests.eq(public.delete_workshop_group((select id from public.workshop_groups where name = 'Run 3' and company_id = tests.ref('alpha'))), 2, 'paired: deleting it removes both copies');
select tests.logout();
select tests.eq((select count(*) from public.workshop_groups where name = 'Run 3'), 0::bigint, '... and the sync does not bring it back');
rollback;

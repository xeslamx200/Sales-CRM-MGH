-- Migration 1006: custom roles on top of a built-in role. Only the company admin writes them; they never raise a person above the base role.
begin;
select tests.logout();

select tests.login('admin_a');
create temp table r as select public.save_company_role(null, tests.ref('alpha'), 'Workshop supervisor', 'sales_agent', array['/reports', '/performance'],
  '{"send_messages": true, "export_data": false, "record_payments": false}'::jsonb) as id;
grant select on r to public;
select tests.eq((select count(*) from public.company_roles where company_id = tests.ref('alpha')), 1::bigint, 'a company admin creates a role');
select tests.eq((select hidden_nav::text from public.company_roles where id = (select id from r)), '{/performance,/reports}', 'the hidden pages are stored (sorted, no duplicates)');
select tests.eq((select permissions::text from public.company_roles where id = (select id from r)), '{"export_data": false, "record_payments": false}', 'only the denials are stored');
select tests.throws($q$select public.save_company_role(null, tests.ref('alpha'), 'workshop SUPERVISOR', 'sales_agent', '{}', '{}')$q$, 'role.name_taken', 'a name is unique inside the company (case and spaces ignored)');
select tests.throws($q$select public.save_company_role(null, tests.ref('alpha'), 'Boss', 'company_admin', '{}', '{}')$q$, 'role.invalid', 'a custom role cannot sit on the company admin role');
select tests.throws($q$select public.save_company_role(null, tests.ref('alpha'), 'X', 'sales_agent', array['/admin/users'], '{}')$q$, 'role.invalid', 'only the listed pages can be hidden');
select tests.throws($q$select public.save_company_role(null, tests.ref('alpha'), 'X', 'sales_agent', '{}', '{"god_mode": false}')$q$, 'role.invalid', 'only the known switches are accepted');
select tests.throws($q$select public.save_company_role(null, tests.ref('beta'), 'Y', 'sales_agent', '{}', '{}')$q$, 'auth.forbidden', 'an admin cannot create roles in another company');

-- assigning: the membership follows the role's base role
select tests.eq((select count(*) from public.company_memberships where custom_role_id is not null), 0::bigint, 'nobody has the role yet');
update public.company_memberships set custom_role_id = (select id from r) where company_id = tests.ref('alpha') and user_id = tests.uid('agent_a2');
select tests.eq((select role::text from public.company_memberships where company_id = tests.ref('alpha') and user_id = tests.uid('agent_a2')), 'sales_agent', 'the person keeps the base role of the custom role');
update public.company_memberships set custom_role_id = (select id from r) where company_id = tests.ref('alpha') and user_id = tests.uid('mgr_a');
select tests.eq((select role::text from public.company_memberships where company_id = tests.ref('alpha') and user_id = tests.uid('mgr_a')), 'sales_agent', 'a manager given an agent-based role becomes an agent (the base role decides the data)');
select tests.throws($q$select public.delete_company_role((select id from r))$q$, 'role.in_use', 'a role in use cannot be deleted');
-- changing the base role moves its people
select public.save_company_role((select id from r), tests.ref('alpha'), 'Workshop supervisor', 'cs_agent', array['/reports'], '{}');
select tests.eq((select string_agg(role::text, ',' order by role::text) from public.company_memberships where custom_role_id = (select id from r)), 'cs_agent,cs_agent', 'people follow a change of the base role');
update public.company_memberships set custom_role_id = null, role = 'sales_agent' where company_id = tests.ref('alpha') and user_id in (tests.uid('agent_a2'), tests.uid('mgr_a'));
select public.delete_company_role((select id from r));
select tests.eq((select count(*) from public.company_roles), 0::bigint, 'an unused role is deleted');
select tests.logout();

-- visibility and writes
select tests.login('admin_a');
select public.save_company_role(null, tests.ref('alpha'), 'Visible to members', 'sales_agent', '{}', '{}');
select tests.logout();
select tests.login('agent_a1');
select tests.eq((select count(*) from public.company_roles), 1::bigint, 'a member of the company can read its roles (the application needs them)');
select tests.throws($q$select public.save_company_role(null, tests.ref('alpha'), 'Mine', 'sales_agent', '{}', '{}')$q$, 'auth.forbidden', 'an agent cannot create a role');
select tests.throws($q$insert into public.company_roles (company_id, name, base_role) values (tests.ref('alpha'), 'Sneaky', 'sales_agent')$q$, 'permission denied', 'no direct writes');
select tests.logout();
select tests.login('agent_b');
select tests.eq((select count(*) from public.company_roles), 0::bigint, 'another company sees none of them');
select tests.logout();

-- a role of another company cannot be attached
select tests.service();
insert into public.company_roles (company_id, name, base_role) values (tests.ref('beta'), 'Beta role', 'sales_agent');
select tests.throws($q$update public.company_memberships set custom_role_id = (select id from public.company_roles where name = 'Beta role') where company_id = tests.ref('alpha') and user_id = tests.uid('agent_a1')$q$, 'role.invalid_custom_role', 'a role of another company is refused');
select tests.logout();
rollback;

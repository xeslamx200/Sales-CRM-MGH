-- Migration 1008: the company admin edits what a built-in role can open / do in their company. Never the admin role, never another company.
begin;
select tests.logout();
select tests.login('admin_a');
select public.save_builtin_role(tests.ref('alpha'), 'sales_agent', array['/reports', '/performance'], '{"export_data": false, "send_messages": true}'::jsonb);
select tests.eq((select hidden_nav::text from public.company_builtin_roles where company_id = tests.ref('alpha') and role = 'sales_agent'), '{/performance,/reports}', 'pages hidden from agents are stored');
select tests.eq((select permissions::text from public.company_builtin_roles where company_id = tests.ref('alpha') and role = 'sales_agent'), '{"export_data": false}', 'only the denials are stored');
select public.save_builtin_role(tests.ref('alpha'), 'sales_agent', array['/tasks'], '{}'::jsonb);
select tests.eq((select count(*) from public.company_builtin_roles where company_id = tests.ref('alpha')), 1::bigint, 'saving again replaces the row');
select tests.eq((select hidden_nav::text from public.company_builtin_roles where company_id = tests.ref('alpha') and role = 'sales_agent'), '{/tasks}', '... with the new pages');
select public.save_builtin_role(tests.ref('alpha'), 'sales_agent', '{}', '{}'::jsonb);
select tests.eq((select count(*) from public.company_builtin_roles where company_id = tests.ref('alpha')), 0::bigint, 'nothing restricted = no row (back to the default)');
select tests.throws($q$select public.save_builtin_role(tests.ref('alpha'), 'company_admin', array['/reports'], '{}')$q$, 'role.invalid', 'the company admin role cannot be restricted');
select tests.throws($q$select public.save_builtin_role(tests.ref('alpha'), 'sales_agent', array['/admin/users'], '{}')$q$, 'role.invalid', 'only the listed pages can be hidden');
select tests.throws($q$select public.save_builtin_role(tests.ref('alpha'), 'sales_agent', '{}', '{"god_mode": false}')$q$, 'role.invalid', 'only the known switches are accepted');
select tests.throws($q$select public.save_builtin_role(tests.ref('beta'), 'sales_agent', '{}', '{"export_data": false}')$q$, 'auth.forbidden', 'an admin cannot edit another company');
select public.save_builtin_role(tests.ref('alpha'), 'cs_agent', array['/bookings'], '{"record_payments": false}'::jsonb);
select tests.logout();

select tests.login('agent_a1');
select tests.eq((select count(*) from public.company_builtin_roles), 1::bigint, 'members of the company can read the settings (their menu depends on them)');
select tests.throws($q$select public.save_builtin_role(tests.ref('alpha'), 'sales_agent', '{}', '{}')$q$, 'auth.forbidden', 'an agent cannot edit roles');
select tests.throws($q$insert into public.company_builtin_roles (company_id, role) values (tests.ref('alpha'), 'sales_agent')$q$, 'permission denied', 'no direct writes');
select tests.logout();
select tests.login('agent_b');
select tests.eq((select count(*) from public.company_builtin_roles), 0::bigint, 'another company sees none of them');
select tests.logout();
rollback;

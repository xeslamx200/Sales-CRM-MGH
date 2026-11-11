-- Audit log viewer (/admin/audit): who can read which rows. The page only
-- filters; these checks pin the RLS behaviour it relies on.
begin;

-- Fresh rows in both companies plus one global (company-less) row.
select tests.logout();
select app.write_audit(tests.ref('alpha'), 'lead.created', 'lead', gen_random_uuid(), '{}'::jsonb);
select app.write_audit(tests.ref('beta'), 'lead.created', 'lead', gen_random_uuid(), '{}'::jsonb);
select app.write_audit(null, 'contact.merged', 'contact', gen_random_uuid(), '{}'::jsonb);

select tests.login('admin_a');
select tests.ok(tests.count($q$select * from public.audit_logs where company_id = tests.ref('alpha')$q$) > 0,
  'a company admin reads their company''s audit rows');
select tests.eq(tests.count($q$select * from public.audit_logs where company_id is distinct from tests.ref('alpha')$q$), 0::bigint,
  'a company admin sees no other company''s rows and no global rows');

select tests.login('mgr_a');
select tests.eq(tests.count('select * from public.audit_logs'), 0::bigint, 'sales managers cannot read the audit log');
select tests.login('shared');
select tests.eq(tests.count('select * from public.audit_logs'), 0::bigint, 'a non-admin member of two companies reads nothing');
select tests.login('outsider');
select tests.eq(tests.count('select * from public.audit_logs'), 0::bigint, 'an outsider reads nothing');

select tests.login('super');
select tests.ok(tests.count($q$select * from public.audit_logs where company_id = tests.ref('beta')$q$) > 0
  and tests.count('select * from public.audit_logs where company_id is null') > 0,
  'the super admin reads every company and the global rows');

-- Filters used by the page do not widen visibility.
select tests.login('admin_a');
select tests.eq(tests.count($q$select * from public.audit_logs where company_id in (tests.ref('alpha'), tests.ref('beta'))
  and action = 'lead.created' and company_id = tests.ref('beta')$q$), 0::bigint,
  'asking for another company by id returns nothing');

-- Deactivated admins lose access.
select tests.logout();
update public.profiles set is_active = false where id = tests.uid('admin_b');
select tests.login('admin_b');
select tests.eq(tests.count('select * from public.audit_logs'), 0::bigint, 'a deactivated admin reads nothing');

rollback;

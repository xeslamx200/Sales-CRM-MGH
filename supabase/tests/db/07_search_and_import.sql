-- Global search and CSV lead import (0800). Both run as the caller, so the
-- results must follow exactly the same visibility rules as direct reads.
begin;

-- ------------------------------------------------------------------ fixtures
select tests.login('agent_a1');
create temp table r as select * from public.find_or_create_contact(tests.ref('alpha'), 'Laila Searchable', '+97455559876');
insert into tests.refs select 'c_a1', contact_id from r; drop table r;
insert into public.leads (company_id, contact_id, title, owner_id)
values (tests.ref('alpha'), tests.ref('c_a1'), 'Findme Lead A1', auth.uid());

select tests.login('agent_a2');
create temp table r as select * from public.find_or_create_contact(tests.ref('alpha'), 'Other Person', '+97455551111');
insert into public.leads (company_id, contact_id, title, owner_id)
values (tests.ref('alpha'), (select contact_id from r), 'Findme Lead A2', auth.uid());
drop table r;

select tests.login('agent_b');
create temp table r as select * from public.find_or_create_contact(tests.ref('beta'), 'Beta Person', '+97455552222');
insert into public.leads (company_id, contact_id, title, owner_id)
values (tests.ref('beta'), (select contact_id from r), 'Findme Lead B', auth.uid());
drop table r;

-- -------------------------------------------------------------------- search
select tests.login('agent_a1');
select tests.eq(tests.count($q$select * from public.global_search('Findme') where entity_type = 'lead'$q$), 1::bigint,
  'agent finds only their own lead');
select tests.eq((select title from public.global_search('Findme') where entity_type = 'lead'), 'Findme Lead A1',
  'and it is the right one');
select tests.eq(tests.count($q$select * from public.global_search('٩٨٧٦')$q$), 2::bigint,
  'phone search with Arabic-Indic digits finds the contact and its lead');
select tests.eq(tests.count($q$select * from public.global_search('5555 9876') where entity_type = 'contact'$q$), 1::bigint,
  'phone search ignores spaces');
select tests.eq(tests.count($q$select * from public.global_search('F')$q$), 0::bigint,
  'queries shorter than 2 characters return nothing');
select tests.eq(tests.count($q$select * from public.global_search('%%')$q$), 0::bigint,
  'LIKE wildcards are escaped (a literal %% matches nothing)');
select tests.eq(tests.count($q$select * from public.global_search('Shared Customer')$q$), 0::bigint,
  'agent does not find a shared contact they have no relationship with');

select tests.login('admin_a');
select tests.eq(tests.count($q$select * from public.global_search('Findme') where entity_type = 'lead'$q$), 2::bigint,
  'company admin finds every lead in their company, none from other companies');
select tests.eq(tests.count($q$select * from public.global_search('Findme', array[tests.ref('beta')])$q$), 0::bigint,
  'filtering by a company they cannot access returns nothing');

select tests.login('mgr_a');
select tests.eq((select title from public.global_search('Findme') where entity_type = 'lead'), 'Findme Lead A1',
  'sales manager finds leads of agents in teams they manage, not of agents outside them');

select tests.login('admin_b');
select tests.eq(tests.count($q$select * from public.global_search('Shared Customer') where entity_type = 'contact'$q$), 1::bigint,
  'admin of a linked company finds the shared contact');
select tests.eq(tests.count($q$select * from public.global_search('Findme') where company_id = tests.ref('alpha')$q$), 0::bigint,
  '… but never another company''s leads');

select tests.login('super');
select tests.eq(tests.count($q$select * from public.global_search('Findme') where entity_type = 'lead'$q$), 3::bigint,
  'super admin finds leads in every company');
select tests.eq(tests.count($q$select * from public.global_search('Findme', array[tests.ref('beta')]) where entity_type = 'lead'$q$), 1::bigint,
  'company filter narrows the results');

select tests.login('inactive');
select tests.eq(tests.count($q$select * from public.global_search('Findme')$q$), 0::bigint,
  'a deactivated user finds nothing');

select tests.login_anon();
select tests.throws($q$select * from public.global_search('Findme')$q$, 'permission denied',
  'anon cannot call global_search');

-- -------------------------------------------------------------------- import
select tests.login('agent_a1');
create temp table imp as select * from public.import_leads(tests.ref('alpha'), jsonb_build_array(
  jsonb_build_object('full_name', 'Imported New', 'phone', '+97455553333', 'title', 'From CSV', 'campaign', 'Autumn'),
  jsonb_build_object('full_name', 'Different Name', 'phone', '+97455550001'),
  jsonb_build_object('full_name', 'Bad Source', 'source', 'carrier_pigeon'),
  jsonb_build_object('full_name', 'Assign Elsewhere', 'owner_id', tests.uid('agent_a2')),
  jsonb_build_object('full_name', '   ')
));
select tests.eq(tests.count('select * from imp where error_key is null'), 2::bigint, 'two valid rows imported');
select tests.eq((select error_key from imp where row_index = 3), 'import.invalid_value', 'an invalid enum value is reported per row');
select tests.eq((select error_key from imp where row_index = 4), 'lead.owner_change_forbidden',
  'an agent cannot import leads assigned to someone else (lead guard applies)');
select tests.eq((select error_key from imp where row_index = 5), 'contact.name_required', 'blank name is rejected');
select tests.ok((select matched_existing from imp where row_index = 2), 'existing phone links to the existing contact');
select tests.eq((select contact_id from imp where row_index = 2), tests.ref('contact_shared'), 'no duplicate contact for a known phone');
select tests.eq((select full_name from public.contacts where id = tests.ref('contact_shared')), 'Shared Customer',
  'import does not overwrite an existing identity');
select tests.eq((select created_by from public.leads where id = (select lead_id from imp where row_index = 1)), auth.uid(),
  'imported leads are created by the importing user');
select tests.eq((select source::text || '/' || campaign from public.leads where id = (select lead_id from imp where row_index = 1)),
  'import/Autumn', 'source defaults to import; campaign is kept');
select tests.eq((select title from public.leads where id = (select lead_id from imp where row_index = 2)), 'Different Name',
  'title defaults to the contact name');
select tests.throws($q$select * from public.import_leads(tests.ref('beta'), '[{"full_name":"x"}]'::jsonb)$q$,
  'auth.forbidden', 'cannot import into a company without access');
select tests.throws($q$select * from public.import_leads(tests.ref('alpha'), (select jsonb_agg(jsonb_build_object('full_name', 'n' || g)) from generate_series(1, 1001) g))$q$,
  'import.invalid_batch', 'batches are limited to 1000 rows');
drop table imp;

select tests.login_anon();
select tests.throws($q$select * from public.import_leads(tests.ref('alpha'), '[]'::jsonb)$q$, 'permission denied',
  'anon cannot call import_leads');

rollback;

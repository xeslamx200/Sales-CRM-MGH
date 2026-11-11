-- Record attachments (0920): who can attach, see and delete files, and what
-- a row may point at.
begin;

select tests.logout();
do $$
declare v uuid;
begin
  insert into public.leads (company_id, contact_id, title, owner_id, team_id, created_by)
  values (tests.ref('alpha'), tests.ref('contact_shared'), 'Attach A', tests.uid('agent_a1'), tests.ref('team_a1'), tests.uid('agent_a1'))
  returning id into v; insert into tests.refs values ('lead_a', v);
  insert into public.leads (company_id, contact_id, title, owner_id, created_by)
  values (tests.ref('beta'), tests.ref('contact_shared'), 'Attach B', tests.uid('agent_b'), tests.uid('agent_b'))
  returning id into v; insert into tests.refs values ('lead_b', v);
end $$;

create or replace function pg_temp.path(p_company text, p_lead text, p_name text default 'aaaaaaaaaaaaaaaaaaaaaaaa.pdf') returns text
language sql as $$ select tests.ref(p_company) || '/lead/' || tests.ref(p_lead) || '/' || p_name $$;

-- ------------------------------------------------------------ insert rules
select tests.login('agent_a1');
select tests.lives($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (tests.ref('alpha'), 'lead', tests.ref('lead_a'), pg_temp.path('alpha', 'lead_a'), 'عرض سعر.pdf', 'application/pdf', 1000, tests.uid('agent_a2'))$q$,
  'the lead owner attaches a file to their lead');
select tests.eq((select uploaded_by from public.attachments where entity_id = tests.ref('lead_a')), tests.uid('agent_a1'),
  'uploaded_by is the caller, whatever the input said');

select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('alpha'), 'lead', tests.ref('lead_a'), tests.ref('alpha') || '/lead/' || tests.ref('lead_b') || '/bbbbbbbbbbbbbbbbbbbbbbbb.pdf',
  'x.pdf', 'application/pdf', 10)$q$, 'attachment.invalid_path', 'a row cannot point into another record''s folder');
select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('alpha'), 'lead', tests.ref('lead_a'), pg_temp.path('alpha', 'lead_a', '../../x.pdf'), 'x.pdf', 'application/pdf', 10)$q$,
  'attachment.invalid_path', 'path traversal is refused');
select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('alpha'), 'lead', tests.ref('lead_a'), pg_temp.path('alpha', 'lead_a', 'cccccccccccccccccccccccc.html'), 'x.html', 'text/html', 10)$q$,
  'attachment.unsupported_type', 'HTML is not an allowed attachment type');
select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('alpha'), 'lead', tests.ref('lead_a'), pg_temp.path('alpha', 'lead_a', 'dddddddddddddddddddddddd.pdf'), 'x.pdf', 'application/pdf', 26214401)$q$,
  'check constraint', 'files over 25 MB are refused');

-- A member of both companies cannot file an Alpha lead's document under Beta.
select tests.login('shared');
select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('beta'), 'lead', tests.ref('lead_a'), tests.ref('beta') || '/lead/' || tests.ref('lead_a') || '/eeeeeeeeeeeeeeeeeeeeeeee.pdf',
  'x.pdf', 'application/pdf', 10)$q$, 'attachment.company_mismatch', 'company_id must be the record''s company');

-- No access to the record, no attachment.
select tests.login('agent_a2');
select tests.throws($q$insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('alpha'), 'lead', tests.ref('lead_a'), pg_temp.path('alpha', 'lead_a', 'ffffffffffffffffffffffff.pdf'), 'x.pdf', 'application/pdf', 10)$q$,
  'row-level security', 'an agent who cannot see the lead cannot attach to it');

-- ------------------------------------------------------------ visibility
select tests.eq(tests.count('select * from public.attachments'), 0::bigint, 'another agent does not see the attachment');
select tests.login('agent_b');
select tests.eq(tests.count('select * from public.attachments'), 0::bigint, 'another company does not see the attachment');
select tests.login('outsider');
select tests.eq(tests.count('select * from public.attachments'), 0::bigint, 'an outsider sees nothing');
select tests.login('mgr_a');
select tests.eq(tests.count('select * from public.attachments'), 1::bigint, 'the team manager sees it');
select tests.login('admin_a');
select tests.eq(tests.count('select * from public.attachments'), 1::bigint, 'the company admin sees it');

-- ------------------------------------------------------------ immutability & delete
select tests.logout();
select tests.throws($q$update public.attachments set storage_path = 'x' where entity_id = tests.ref('lead_a')$q$,
  'attachment.immutable', 'attachments cannot be changed, even by privileged roles');

select tests.login('mgr_a');
delete from public.attachments where entity_id = tests.ref('lead_a');
select tests.logout();
select tests.eq(tests.count($q$select * from public.attachments where entity_id = tests.ref('lead_a')$q$), 1::bigint,
  'a manager who neither uploaded it nor administers the company cannot delete it');

-- A former employee loses delete rights on their own uploads.
update public.profiles set is_active = false where id = tests.uid('agent_a1');
select tests.login('agent_a1');
delete from public.attachments where entity_id = tests.ref('lead_a');
select tests.logout();
select tests.eq(tests.count($q$select * from public.attachments where entity_id = tests.ref('lead_a')$q$), 1::bigint,
  'a deactivated uploader cannot delete');
update public.profiles set is_active = true where id = tests.uid('agent_a1');

select tests.login('agent_a1');
delete from public.attachments where entity_id = tests.ref('lead_a');
select tests.logout();
select tests.eq(tests.count($q$select * from public.attachments where entity_id = tests.ref('lead_a')$q$), 0::bigint,
  'the uploader deletes their own attachment');

-- Company admin deletes someone else's.
select tests.login('agent_b');
insert into public.attachments (company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes)
  values (tests.ref('beta'), 'lead', tests.ref('lead_b'), pg_temp.path('beta', 'lead_b'), 'b.png', 'image/png', 10);
select tests.login('admin_a');
delete from public.attachments where entity_id = tests.ref('lead_b');
select tests.login('admin_b');
select tests.eq(tests.count($q$select * from public.attachments where entity_id = tests.ref('lead_b')$q$), 1::bigint,
  'another company''s admin could not delete it');
delete from public.attachments where entity_id = tests.ref('lead_b');
select tests.eq(tests.count($q$select * from public.attachments where entity_id = tests.ref('lead_b')$q$), 0::bigint,
  'the company admin deletes an employee''s attachment');

rollback;

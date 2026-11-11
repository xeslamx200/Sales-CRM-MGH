-- File attachments on records (leads and deals in the UI; the table also
-- allows contacts, tasks and conversations).
--
-- Files live in the private `attachments` bucket (0890). The app issues a
-- signed upload URL only after a user-session check, then inserts the row
-- below with the user's session. These rules make the row trustworthy no
-- matter who calls the API directly:
--   * uploaded_by is the caller (set here, never taken from input);
--   * company_id is the record's own company (a member of two companies
--     cannot file a document under the wrong one);
--   * storage_path is <company>/<entity_type>/<entity_id>/<random>[.ext], so
--     a row can only point at an object inside its own record's folder;
--   * the declared MIME type is on the same allow-list as the bucket.

create or replace function app.guard_attachment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'attachment.immutable' using errcode = '42501';
  end if;
  new.uploaded_by := coalesce(app.actor_id(), new.uploaded_by);
  new.created_at := now();

  if new.entity_type = 'contact' then
    if not exists (select 1 from public.contact_companies cc where cc.contact_id = new.entity_id and cc.company_id = new.company_id) then
      raise exception 'attachment.company_mismatch' using errcode = '42501';
    end if;
  else
    v_company := case new.entity_type
      when 'lead' then (select company_id from public.leads where id = new.entity_id)
      when 'deal' then (select company_id from public.deals where id = new.entity_id)
      when 'task' then (select company_id from public.tasks where id = new.entity_id)
      when 'conversation' then (select company_id from public.conversations where id = new.entity_id)
    end;
    if v_company is distinct from new.company_id then
      raise exception 'attachment.company_mismatch' using errcode = '42501';
    end if;
  end if;

  if new.storage_path !~ ('^' || new.company_id || '/' || new.entity_type || '/' || new.entity_id || '/[0-9a-f]{24}(\.[a-z0-9]{1,8})?$') then
    raise exception 'attachment.invalid_path' using errcode = '22023';
  end if;
  if new.mime_type not in (
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation') then
    raise exception 'attachment.unsupported_type' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger attachments_guard before insert or update on public.attachments
  for each row execute function app.guard_attachment();

-- Delete: the uploader or a company admin, and only while they can still see
-- the record (a former member no longer can).
drop policy attachments_delete on public.attachments;
create policy attachments_delete on public.attachments for delete to authenticated
  using (app.has_company_access(company_id) and app.can_access_entity(entity_type, entity_id)
         and (uploaded_by = (select auth.uid()) or app.is_company_admin(company_id)));

create index if not exists attachments_company_idx on public.attachments (company_id);

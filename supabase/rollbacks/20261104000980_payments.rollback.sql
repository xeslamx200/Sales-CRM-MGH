-- ROLLBACK of 20261104000980 (payments). Run with psql -1. Refuses (changes nothing) while any payment or payment attachment exists:
-- recorded money data is never dropped by a script. Restores the exact 0920 / 0200 function bodies.
do $$
begin
  if exists (select 1 from public.payments) or exists (select 1 from public.attachments where entity_type = 'payment') then
    raise exception 'refusing: payments or payment attachments exist (%, %)',
      (select count(*) from public.payments), (select count(*) from public.attachments where entity_type = 'payment');
  end if;
end $$;

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

create or replace function app.can_access_entity(p_entity_type text, p_entity_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_entity_type
    when 'lead' then app.can_access_lead(p_entity_id)
    when 'deal' then app.can_access_deal(p_entity_id)
    when 'contact' then app.can_see_contact(p_entity_id)
    when 'conversation' then app.can_access_conversation(p_entity_id)
    when 'task' then coalesce((
      select app.can_see_task(t.company_id, t.assigned_to, t.created_by)
      from public.tasks t where t.id = p_entity_id), false)
    else false
  end
$$;

alter table public.attachments drop constraint attachments_entity_type_check;
alter table public.attachments add constraint attachments_entity_type_check
  check (entity_type in ('lead', 'deal', 'contact', 'task', 'conversation'));

drop function if exists public.payment_balance(uuid, uuid);
drop function if exists public.review_payment(uuid, text, text);
drop function if exists public.record_payment(uuid, uuid, numeric, text, text, date, text);
drop table if exists public.payments;
drop function if exists app.guard_payment();
drop function if exists public.upsert_fx_rates(jsonb, text);
drop table if exists public.fx_rates;
alter table public.company_offerings drop column if exists price_egp;

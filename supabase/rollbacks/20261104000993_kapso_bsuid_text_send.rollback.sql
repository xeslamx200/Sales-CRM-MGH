-- ROLLBACK of 20261104000993: restores the exact 20261104000979 body (every employee send to a customer without a phone is refused again). Run with psql -1.
-- Messages already sent to BSUID customers stay (they are ordinary rows); nothing else was written by 993.

create or replace function app.block_kapso_unready_send() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a public.whatsapp_accounts; v_company uuid;
begin
  if new.direction <> 'outbound' or new.sent_by is null then return new; end if;
  if exists (select 1 from public.conversations c where c.id = new.conversation_id and c.customer_wa_id is null) then
    raise exception 'whatsapp.recipient_phone_unknown' using errcode = '23514';
  end if;
  select c.company_id into v_company from public.conversations c where c.id = new.conversation_id;
  select wa.* into a from public.whatsapp_accounts wa
    join public.conversations c on c.whatsapp_account_id = wa.id where c.id = new.conversation_id;
  if found and a.provider = 'kapso' and a.environment = 'production' then
    if not a.outbound_enabled or a.status <> 'active' then
      raise exception 'whatsapp.outbound_disabled' using errcode = '23514';
    end if;
    if v_company is distinct from a.default_company_id then
      raise exception 'whatsapp.account_company_mismatch' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

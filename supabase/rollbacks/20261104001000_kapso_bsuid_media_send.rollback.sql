-- ROLLBACK of 20261104001000: restores the 20261104000993 body (TEXT only to a BSUID-only customer). Run with psql -1.
-- Messages already sent stay (ordinary rows).

create or replace function app.block_kapso_unready_send() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a public.whatsapp_accounts; v_company uuid;
begin
  if new.direction <> 'outbound' or new.sent_by is null then return new; end if;
  -- (979, relaxed by 993) No phone number: only a TEXT to a BSUID customer of a Kapso production account may go on. Every employee send
  -- (text, media, template, resend) inserts its row here first, so anything else is refused before a request leaves the CRM.
  if exists (select 1 from public.conversations c where c.id = new.conversation_id and c.customer_wa_id is null) then
    if not exists (
      select 1 from public.conversations c join public.whatsapp_accounts wa on wa.id = c.whatsapp_account_id
      where c.id = new.conversation_id and c.customer_bsuid is not null
        and wa.provider = 'kapso' and wa.environment = 'production' and new.message_type = 'text'
    ) then
      raise exception 'whatsapp.recipient_phone_unknown' using errcode = '23514';
    end if;
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

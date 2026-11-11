-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only after 20261104000992 and only with explicit approval.
-- 20261104000993 - an employee may reply with TEXT to a customer known only by a business-scoped user id (BSUID).
--
-- Before (979): every employee send to a conversation without customer_wa_id was refused (whatsapp.recipient_phone_unknown), so a customer who
-- hides the phone number (WhatsApp usernames) could write to the CRM but never be answered from it.
-- Now: the refusal stays for everything except ONE case: a TEXT message, on a Kapso PRODUCTION account, in a conversation that has a BSUID.
-- Media and templates to such a customer stay refused. Every other check of the function is unchanged (outbound_enabled + active account,
-- company of the account). The phone number is still never derived from the BSUID; the app sends to the BSUID itself (`recipient`).
-- A send Kapso/Meta refuses is a definite 4xx: nothing leaves, the message is marked failed with the stable code, and a person decides.
--
-- No table, column, index, grant or new function: CREATE OR REPLACE of the existing function with an unchanged signature (grants kept).
-- Rollback: supabase/proposed/rollbacks/20261104000993_kapso_bsuid_text_send.rollback.sql (restores the 979 body). Run with psql -1.

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

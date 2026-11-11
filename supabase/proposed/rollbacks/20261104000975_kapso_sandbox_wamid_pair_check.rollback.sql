-- Rollback of 20261104000975_kapso_sandbox_wamid_pair_check.sql: restores the exact 0960 bodies of the two wrappers.

create or replace function public.ingest_kapso_message(
  p_phone_number_id text, p_wa_message_id text, p_from_wa_id text, p_profile_name text,
  p_message_type text, p_body text, p_media jsonb, p_sent_at timestamptz
) returns table (message_id uuid, conversation_id uuid, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.whatsapp_accounts;
  v_phone text;
  v_had boolean;
  r record;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  v_acc := app.kapso_account(p_phone_number_id);
  v_phone := '+' || p_from_wa_id;
  v_had := exists (select 1 from public.contacts k where k.phone_e164 = v_phone and k.merged_into_id is null);
  select * into r from public.ingest_whatsapp_message(p_phone_number_id, p_wa_message_id, p_from_wa_id, p_profile_name,
                                                        p_message_type, p_body, p_media, p_sent_at);
  -- A message id that already exists must belong to THIS sandbox account (never to a Meta account).
  if not exists (select 1 from public.conversations c where c.id = r.conversation_id and c.whatsapp_account_id = v_acc.id) then
    raise exception 'kapso.message_account_mismatch' using errcode = '42501';
  end if;
  if not v_had then perform app.mark_new_sandbox_contact(v_phone); end if;
  return query select r.message_id, r.conversation_id, r.duplicate;
end $$;

create or replace function public.ingest_kapso_echo(
  p_phone_number_id text, p_wa_message_id text, p_to_wa_id text, p_message_type text,
  p_body text, p_media jsonb, p_sent_at timestamptz
) returns table (message_id uuid, conversation_id uuid, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.whatsapp_accounts;
  v_phone text;
  v_had boolean;
  r record;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  v_acc := app.kapso_account(p_phone_number_id);
  v_phone := '+' || p_to_wa_id;
  v_had := exists (select 1 from public.contacts k where k.phone_e164 = v_phone and k.merged_into_id is null);
  select * into r from public.ingest_whatsapp_echo(p_phone_number_id, p_wa_message_id, p_to_wa_id, p_message_type,
                                                    p_body, p_media, p_sent_at);
  if not exists (select 1 from public.conversations c where c.id = r.conversation_id and c.whatsapp_account_id = v_acc.id) then
    raise exception 'kapso.message_account_mismatch' using errcode = '42501';
  end if;
  if not v_had then perform app.mark_new_sandbox_contact(v_phone); end if;
  return query select r.message_id, r.conversation_id, r.duplicate;
end $$;

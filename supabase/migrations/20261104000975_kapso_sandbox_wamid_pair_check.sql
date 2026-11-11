-- =============================================================================================================================
-- PROPOSED (separate from Rev6, not applied automatically): D1 - Kapso SANDBOX wrappers must never return a (message, conversation) pair
-- that belongs to two different accounts.
--
-- Reproduction (scratch DB, 30/30 runs, on the pre-Rev6 baseline as well): the same wamid delivered to two sandbox accounts at the same moment.
-- ingest_whatsapp_message's race fallback returns the WINNER's message id with the LOSER's freshly created conversation id; the 0960 wrappers
-- only checked that the conversation belongs to the calling account, so both calls "succeeded" and the loser got a foreign message id.
--
-- Scope: replaces ONLY public.ingest_kapso_message and public.ingest_kapso_echo (0960 bodies + one extra check). It does not touch
-- ingest_whatsapp_message / ingest_whatsapp_echo (Meta Direct), does not need Rev6, and works on the 0960 schema as well as on the Rev6
-- schema (ingest_kapso_inbound delegates sandbox traffic to these wrappers). Same signatures, same grants. No production behaviour is enabled.
-- Rollback: supabase/proposed/rollbacks/20261104000975_kapso_sandbox_wamid_pair_check.rollback.sql (the exact 0960 bodies).
-- =============================================================================================================================

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
  -- D1: the pair returned by the generic function must be ONE stored pair. When a concurrent delivery of the same wamid to ANOTHER account
  -- wins the insert, the generic function falls back to the winner's message id but returns THIS call's freshly resolved conversation;
  -- the account check above passes for that local conversation. Refuse such a pair (the raise rolls back everything this call created).
  if not exists (select 1 from public.messages m where m.id = r.message_id and m.conversation_id = r.conversation_id) then
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
  -- D1: the pair returned by the generic function must be ONE stored pair. When a concurrent delivery of the same wamid to ANOTHER account
  -- wins the insert, the generic function falls back to the winner's message id but returns THIS call's freshly resolved conversation;
  -- the account check above passes for that local conversation. Refuse such a pair (the raise rolls back everything this call created).
  if not exists (select 1 from public.messages m where m.id = r.message_id and m.conversation_id = r.conversation_id) then
    raise exception 'kapso.message_account_mismatch' using errcode = '42501';
  end if;
  if not v_had then perform app.mark_new_sandbox_contact(v_phone); end if;
  return query select r.message_id, r.conversation_id, r.duplicate;
end $$;

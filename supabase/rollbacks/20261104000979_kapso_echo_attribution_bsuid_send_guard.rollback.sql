-- ROLLBACK of 20261104000979: restores the exact 20261104000970 bodies of both functions. Run with psql -1.
-- Echo messages recorded while 979 was active stay (they belong to existing conversations); nothing else was written by 979.

create or replace function app.block_kapso_unready_send() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a public.whatsapp_accounts; v_company uuid;
begin
  if new.direction <> 'outbound' or new.sent_by is null then return new; end if;
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

-- Status of an outbound message, and echoes of messages the CRM did not create. Returns false = "cannot be applied yet".
-- p_origin: 'cloud_api' | 'business_app' | 'other_app' | 'meta_business_agent' | NULL (= 'cloud_api').
-- p_is_retry: false from the webhook handler, true from process_webhook_retries.
-- Unknown wamid, origin cloud_api:
--   exactly 1 CRM message in that conversation still waiting for its wamid (same type + body, <= 15 min)  -> attach (no new row);
--   2 or more                                                                                           -> false (never guess);
--   0 and first delivery (not a retry)                                                                  -> false (the API response may still be in flight);
--   0 on a retry                                                                                        -> echo, sent_by NULL.
-- Unknown wamid, origin business_app / other_app / meta_business_agent -> echo, sent_by NULL, immediately.
create or replace function public.apply_kapso_status_v2(
  p_phone_number_id text, p_wa_message_id text, p_status text, p_error_code text, p_error_message text,
  p_to_wa_id text, p_to_bsuid text, p_origin text, p_message_type text, p_body text, p_media jsonb, p_sent_at timestamptz,
  p_is_retry boolean default false
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.whatsapp_accounts; v_owner uuid; v_org text := coalesce(p_origin, 'cloud_api');
  r record; v_cands uuid[];
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if v_org not in ('cloud_api', 'business_app', 'other_app', 'meta_business_agent') then
    raise exception 'kapso.origin_not_ingestable' using errcode = '22023';
  end if;
  if (p_to_wa_id is not null and p_to_wa_id !~ '^[1-9][0-9]{6,14}$')
     or (p_to_bsuid is not null and p_to_bsuid !~ '^[^[:space:]]{1,128}$') then
    raise exception 'whatsapp.invalid_payload' using errcode = '22023';
  end if;
  v_acc := app.kapso_resolve_account(p_phone_number_id);

  if v_acc.environment = 'sandbox' then   -- 0960 behaviour, unchanged
    return public.apply_kapso_status(p_phone_number_id, p_wa_message_id, p_status, p_error_code, p_error_message,
                                     p_to_wa_id, p_message_type, p_body, p_media, p_sent_at);
  end if;

  select c.whatsapp_account_id into v_owner
  from public.messages m join public.conversations c on c.id = m.conversation_id where m.wa_message_id = p_wa_message_id;
  if found then
    if v_owner is distinct from v_acc.id then raise exception 'kapso.message_account_mismatch' using errcode = '42501'; end if;
    return public.apply_whatsapp_status(p_wa_message_id, p_status, p_error_code, p_error_message);
  end if;

  if p_to_wa_id is null and p_to_bsuid is null then return false; end if;   -- customer unknown: never guess

  if v_org = 'cloud_api' then
    select array_agg(m.id) into v_cands
    from public.messages m join public.conversations c on c.id = m.conversation_id
    where c.whatsapp_account_id = v_acc.id and m.direction = 'outbound' and m.wa_message_id is null and m.sent_by is not null
      and m.status = 'queued' and m.created_at > now() - interval '15 minutes'
      and m.message_type = left(coalesce(p_message_type, 'text'), 40) and m.body is not distinct from left(p_body, 4096)
      and ((p_to_wa_id is not null and c.customer_wa_id = p_to_wa_id)
           or (p_to_bsuid is not null and c.customer_bsuid = p_to_bsuid));
    if coalesce(array_length(v_cands, 1), 0) = 1 then
      begin
        update public.messages set wa_message_id = p_wa_message_id where id = v_cands[1] and wa_message_id is null;
      exception when unique_violation then
        null;   -- another row (possibly another account's) carries this wamid: decided by the ownership check below
      end;
      -- The UPDATE may have matched zero rows (the candidate got its wamid or changed concurrently) or been refused by the
      -- unique index. Never apply a status before verifying WHO holds the wamid NOW. Safe between check and apply because
      -- messages.wa_message_id, messages.conversation_id (guard_message_update) and conversations.whatsapp_account_id
      -- (guard_conversation) are immutable once set.
      select c.whatsapp_account_id into v_owner
      from public.messages m join public.conversations c on c.id = m.conversation_id where m.wa_message_id = p_wa_message_id;
      if not found then return false; end if;      -- nobody holds it (candidate changed concurrently): retry-safe, nothing applied
      if v_owner is distinct from v_acc.id then raise exception 'kapso.message_account_mismatch' using errcode = '42501'; end if;
      return public.apply_whatsapp_status(p_wa_message_id, p_status, p_error_code, p_error_message);
    end if;
    if coalesce(array_length(v_cands, 1), 0) > 1 then return false; end if;
    if not p_is_retry then return false; end if;
  end if;

  select * into r from app.kapso_resolve_conversation(v_acc, p_to_wa_id, p_to_bsuid, null);
  insert into public.messages (conversation_id, direction, wa_message_id, message_type, body, media, status, sent_by, sent_at,
                               is_simulated, provider_origin)
  values (r.o_conversation_id, 'outbound', p_wa_message_id, left(coalesce(p_message_type, 'text'), 40), left(p_body, 4096), p_media,
          'sent', null, coalesce(p_sent_at, now()), v_acc.is_simulated, v_org)
  on conflict (wa_message_id) do nothing;
  -- Same class of race as in ingest_kapso_inbound: apply_whatsapp_status looks only at the wamid, so before applying a
  -- status make sure the row that now carries this wamid belongs to THIS account (a concurrent delivery for another
  -- account may have inserted it first).
  if not exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
                 where m.wa_message_id = p_wa_message_id and c.whatsapp_account_id = v_acc.id) then
    raise exception 'kapso.message_account_mismatch' using errcode = '42501';
  end if;
  return public.apply_whatsapp_status(p_wa_message_id, p_status, p_error_code, p_error_message);
end $$;

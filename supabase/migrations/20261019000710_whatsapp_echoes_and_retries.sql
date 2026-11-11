-- =============================================================================
-- 0710 — Coexistence echoes and webhook event bookkeeping.
-- =============================================================================

-- Service role only: a message the business sent from the WhatsApp Business
-- app (coexistence `smb_message_echoes`). It is stored as outbound with NO
-- sender: the platform gives no evidence of which employee typed it, so it is
-- never credited to anyone in performance or response-time reports.
create or replace function public.ingest_whatsapp_echo(
  p_phone_number_id text,
  p_wa_message_id text,
  p_to_wa_id text,
  p_message_type text,
  p_body text,
  p_media jsonb,
  p_sent_at timestamptz
) returns table (message_id uuid, conversation_id uuid, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.whatsapp_accounts;
  v_phone text;
  v_contact uuid;
  v_conv uuid;
  v_msg uuid;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_wa_message_id is null or p_to_wa_id !~ '^[1-9][0-9]{6,14}$' then
    raise exception 'whatsapp.invalid_payload' using errcode = '22023';
  end if;
  select m.id, m.conversation_id into v_msg, v_conv from public.messages m where m.wa_message_id = p_wa_message_id;
  if found then
    return query select v_msg, v_conv, true;
    return;
  end if;
  select * into v_acc from public.whatsapp_accounts where phone_number_id = p_phone_number_id;
  if not found then
    raise exception 'whatsapp.unknown_phone_number_id' using errcode = 'P0002';
  end if;

  v_phone := '+' || p_to_wa_id;
  select id into v_contact from public.contacts where phone_e164 = v_phone and merged_into_id is null;
  if v_contact is null then
    insert into public.contacts (full_name, phone_e164) values (v_phone, v_phone)
    on conflict (phone_e164) where merged_into_id is null and phone_e164 is not null do nothing
    returning id into v_contact;
    if v_contact is null then
      select id into v_contact from public.contacts where phone_e164 = v_phone and merged_into_id is null;
    end if;
  end if;
  perform app.ensure_contact_link(v_contact, v_acc.default_company_id);

  insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, is_simulated)
  values (v_acc.id, v_acc.default_company_id, v_contact, p_to_wa_id, v_acc.is_simulated)
  on conflict (whatsapp_account_id, customer_wa_id) do nothing;
  select id into v_conv from public.conversations
  where whatsapp_account_id = v_acc.id and customer_wa_id = p_to_wa_id;

  insert into public.messages (conversation_id, direction, wa_message_id, message_type, body, media, status,
                               sent_by, sent_at, is_simulated)
  values (v_conv, 'outbound', p_wa_message_id, left(coalesce(p_message_type, 'text'), 40), left(p_body, 4096),
          p_media, 'sent', null, coalesce(p_sent_at, now()), v_acc.is_simulated)
  on conflict (wa_message_id) do nothing
  returning id into v_msg;
  if v_msg is null then
    select m.id into v_msg from public.messages m where m.wa_message_id = p_wa_message_id;
    return query select v_msg, v_conv, true;
    return;
  end if;
  return query select v_msg, v_conv, false;
end $$;

-- Service role only: claim a webhook event for processing.
-- Returns 'new' (process it), 'retry' (previously failed; process again) or
-- 'duplicate' (already processed or ignored; skip).
create or replace function public.claim_webhook_event(
  p_event_key text, p_event_kind text, p_phone_number_id text, p_payload jsonb
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  insert into public.whatsapp_webhook_events (event_key, event_kind, phone_number_id, payload, attempts)
  values (p_event_key, p_event_kind, p_phone_number_id, p_payload, 1)
  on conflict (event_key) do nothing;
  if found then return 'new'; end if;

  select status into v_status from public.whatsapp_webhook_events where event_key = p_event_key for update;
  if v_status in ('processed', 'ignored') then return 'duplicate'; end if;
  update public.whatsapp_webhook_events set attempts = attempts + 1 where event_key = p_event_key;
  return 'retry';
end $$;

-- Service role only: finish an event. Processed events have their payload
-- redacted so message content is not retained in the intake table.
create or replace function public.finish_webhook_event(p_event_key text, p_status text, p_error text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_status not in ('processed', 'failed', 'ignored') then
    raise exception 'webhook.invalid_status' using errcode = '22023';
  end if;
  update public.whatsapp_webhook_events set
    status = p_status,
    last_error = case when p_status = 'failed' then left(p_error, 300) else null end,
    processed_at = case when p_status <> 'failed' then now() else processed_at end,
    payload = case when p_status <> 'failed' then '{}'::jsonb else payload end
  where event_key = p_event_key;
end $$;

-- Failed events that should be retried (oldest first, bounded attempts).
create or replace function public.pending_webhook_retries(p_limit int default 100, p_max_attempts int default 8)
returns table (event_key text, event_kind text, payload jsonb, attempts int)
language sql stable security definer set search_path = '' as $$
  select e.event_key, e.event_kind, e.payload, e.attempts
  from public.whatsapp_webhook_events e
  where app.is_service_context() and e.status = 'failed' and e.attempts < p_max_attempts
  order by e.received_at
  limit least(p_limit, 500)
$$;

-- Retention: drop processed/ignored intake rows after 30 days.
create or replace function public.purge_old_webhook_events(p_days int default 30) returns int
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  delete from public.whatsapp_webhook_events
  where status in ('processed', 'ignored') and received_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v = row_count;
  return v;
end $$;

revoke all on function
  public.ingest_whatsapp_echo(text, text, text, text, text, jsonb, timestamptz),
  public.claim_webhook_event(text, text, text, jsonb),
  public.finish_webhook_event(text, text, text),
  public.pending_webhook_retries(int, int),
  public.purge_old_webhook_events(int)
from public, anon, authenticated;
grant execute on function
  public.ingest_whatsapp_echo(text, text, text, text, text, jsonb, timestamptz),
  public.claim_webhook_event(text, text, text, jsonb),
  public.finish_webhook_event(text, text, text),
  public.pending_webhook_retries(int, int),
  public.purge_old_webhook_events(int)
to service_role;

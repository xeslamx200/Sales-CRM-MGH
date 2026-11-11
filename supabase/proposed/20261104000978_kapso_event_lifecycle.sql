-- =============================================================================================================================
-- PROPOSED 978 (NOT applied automatically). Kapso webhook event lifecycle: no signed item is ever lost, no final state is ever
-- downgraded, a crashed request is recovered. Depends on 20261104000970 (Rev6); used by protocol v2 (src/lib/kapso/store-v2.ts) and by
-- the v1 protocol check (src/server/whatsapp/kapso-store.ts). Additive: 5 new functions + 1 replaced function (asserted string edit of
-- the 970 body of process_webhook_retries). No table, column, constraint, index or policy change; no data is written by the migration.
--
--   kapso_account_protocol    sandbox | production | misconfigured | NULL for a phone_number_id (fail-closed protocol check)
--   claim_kapso_event         claim_webhook_event for v2 events, but a non-final row gets the NEW payload (a fresh parse replaces a
--                             quarantine record, so a later failure leaves real retry work instead of a stale quarantine payload)
--   finish_kapso_event        finish_webhook_event, but processed / ignored are TERMINAL: no later finish changes them (any
--                             requested status -> 'already_final', row untouched); a missing row raises instead of updating nothing
--   record_kapso_held_event   ONE atomic write of a quarantined (failed) or ignored item (no claim/finish crash window); the only row
--                             it may replace is an existing QUARANTINE record (kind kapso_quarantined, pending/failed). A terminal
--                             row or any processable event (pending or failed, kind kapso_inbound_v2 / kapso_status_v2 / any other
--                             event kind) is returned as 'duplicate' and left byte-for-byte unchanged
--   list_kapso_quarantined    quarantine rows of one reason that kept their original item (operator reprocessing)
--   process_webhook_retries   + v2 rows stuck in 'pending' for 15 minutes are retried (same attempt bound, same SKIP LOCKED);
--                             v2 kinds finish through finish_kapso_event, every legacy (Meta / v1) kind through finish_webhook_event
--                             exactly as before
-- All are SECURITY DEFINER, search_path '', service role only (app.is_service_context + EXECUTE grant), like the functions they mirror.
-- Rollback: rollbacks/20261104000978_kapso_event_lifecycle.rollback.sql (drops the 5 functions, restores the 970 body). Rows written
-- through these functions stay valid for 970 (quarantine rows are 'failed' + kind kapso_quarantined, which 970's job already excludes).
-- =============================================================================================================================

-- ------------------------------------------------------------------ 1. protocol / account compatibility
-- phone_number_id is UNIQUE on whatsapp_accounts, so the lookup is unambiguous. No lock: this is a routing decision taken before the
-- webhook transaction; the authoritative checks (with the account-row lock) stay in app.kapso_resolve_account.
create or replace function public.kapso_account_protocol(p_phone_number_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare a public.whatsapp_accounts; v_company_sandbox boolean;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  select * into a from public.whatsapp_accounts w where w.phone_number_id = p_phone_number_id and w.provider = 'kapso';
  if not found or a.status not in ('test', 'active') then return null; end if;
  v_company_sandbox := app.company_is_sandbox(a.default_company_id);
  if a.environment = 'sandbox' and a.connection_mode = 'sandbox' and v_company_sandbox then return 'sandbox'; end if;
  if a.environment = 'production' and a.connection_mode in ('cloud_api', 'coexistence') and not v_company_sandbox then return 'production'; end if;
  return 'misconfigured';
end $$;

-- ------------------------------------------------------------------ 2. claim (v2 events)
create or replace function public.claim_kapso_event(p_event_key text, p_event_kind text, p_phone_number_id text, p_payload jsonb)
returns text
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_event_key is null or p_event_key !~ '^kapso:(msg|status):' or length(p_event_key) > 300 then
    raise exception 'webhook.invalid_event_key' using errcode = '22023';
  end if;
  if coalesce(p_payload ->> 'kind', '') not in ('kapso_inbound_v2', 'kapso_status_v2') then
    raise exception 'webhook.invalid_payload_kind' using errcode = '22023';
  end if;
  insert into public.whatsapp_webhook_events (event_key, event_kind, phone_number_id, payload, attempts)
  values (p_event_key, p_event_kind, p_phone_number_id, p_payload, 1)
  on conflict (event_key) do nothing;
  if found then return 'new'; end if;

  select e.status into v_status from public.whatsapp_webhook_events e where e.event_key = p_event_key for update;
  if not found then   -- deleted between the insert attempt and the lock (retention): the caller retries the delivery
    raise exception 'webhook.claim_conflict' using errcode = '40001';
  end if;
  if v_status in ('processed', 'ignored') then return 'duplicate'; end if;
  update public.whatsapp_webhook_events
     set attempts = attempts + 1, payload = p_payload, event_kind = p_event_kind, phone_number_id = p_phone_number_id
   where event_key = p_event_key;
  return 'retry';
end $$;

-- ------------------------------------------------------------------ 3. finish (never downgrades a final row)
create or replace function public.finish_kapso_event(p_event_key text, p_status text, p_error text default null)
returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('processed', 'failed', 'ignored') then
    raise exception 'webhook.invalid_status' using errcode = '22023';
  end if;
  update public.whatsapp_webhook_events set
    status = p_status,
    last_error = case when p_status = 'failed' then app.safe_error(coalesce(p_error, 'processing_error')) else null end,
    processed_at = case when p_status <> 'failed' then now() else processed_at end,
    payload = case when p_status <> 'failed' then '{}'::jsonb else payload end
  where event_key = p_event_key
    and status not in ('processed', 'ignored');   -- terminal: processed <-> ignored and -> failed are all refused
  -- Concurrent finishes serialize on the row lock of the UPDATE; the second one re-checks this condition on the committed row
  -- (READ COMMITTED re-evaluation), so once a terminal state is committed no later finish can change it.
  if found then return 'finished'; end if;
  if exists (select 1 from public.whatsapp_webhook_events e where e.event_key = p_event_key) then return 'already_final'; end if;
  raise exception 'webhook.event_not_found' using errcode = 'P0002';
end $$;

-- ------------------------------------------------------------------ 4. quarantine / ignore in one statement
create or replace function public.record_kapso_held_event(
  p_event_key text, p_event_kind text, p_phone_number_id text, p_payload jsonb, p_status text, p_reason text
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_status text; v_kind text; v_payload jsonb;
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('failed', 'ignored') then
    raise exception 'webhook.invalid_status' using errcode = '22023';
  end if;
  if p_event_key is null or p_event_key !~ '^kapso:(msg|status|invalid|invalid_payload):' or length(p_event_key) > 300 then
    raise exception 'webhook.invalid_event_key' using errcode = '22023';
  end if;
  if p_status = 'failed' and coalesce(p_payload ->> 'kind', '') <> 'kapso_quarantined' then
    raise exception 'webhook.invalid_payload_kind' using errcode = '22023';   -- a failed held row must never become retry work
  end if;
  if p_reason is null or p_reason !~ '^[a-z_]+(\.[a-z_]+){0,3}$' or length(p_reason) > 120 then
    raise exception 'webhook.invalid_reason' using errcode = '22023';
  end if;
  if pg_column_size(p_payload) > 65536 then
    raise exception 'webhook.payload_too_large' using errcode = '22001';
  end if;
  v_payload := case when p_status = 'ignored' then '{}'::jsonb else p_payload end;   -- ignored rows keep nothing (as finish does)

  insert into public.whatsapp_webhook_events (event_key, event_kind, phone_number_id, payload, status, attempts, last_error, processed_at)
  values (p_event_key, p_event_kind, p_phone_number_id, v_payload, p_status, 1,
          case when p_status = 'failed' then p_reason end, case when p_status = 'ignored' then now() end)
  on conflict (event_key) do nothing;
  if found then return 'recorded'; end if;

  select e.status, e.payload ->> 'kind' into v_status, v_kind from public.whatsapp_webhook_events e where e.event_key = p_event_key for update;
  if not found then raise exception 'webhook.claim_conflict' using errcode = '40001'; end if;
  -- The row is locked (FOR UPDATE above). Protected, returned as 'duplicate' and NOT modified (payload, kind, status, attempts,
  -- last_error, timestamps, phone_number_id): a terminal row, and every row that is not itself a quarantine record - in
  -- particular a processable event that is pending (being processed, or left by a crashed request for the stale-pending sweep)
  -- or failed (retry work). Only an existing quarantine record (pending or failed) is refreshed by a redelivery.
  if v_status in ('processed', 'ignored') or coalesce(v_kind, '') <> 'kapso_quarantined' then
    return 'duplicate';
  end if;
  update public.whatsapp_webhook_events set
    status = p_status, attempts = attempts + 1, payload = v_payload,
    last_error = case when p_status = 'failed' then p_reason end,
    processed_at = case when p_status = 'ignored' then now() else processed_at end,
    phone_number_id = coalesce(p_phone_number_id, phone_number_id)
  where event_key = p_event_key;
  return 'recorded';
end $$;

-- ------------------------------------------------------------------ 5. quarantine rows that can be reprocessed
create or replace function public.list_kapso_quarantined(p_reason text, p_limit int default 100)
returns table (event_key text, payload jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_service_context() then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  return query
    select e.event_key, e.payload from public.whatsapp_webhook_events e
    where e.status = 'failed' and e.payload ->> 'kind' = 'kapso_quarantined' and e.last_error = p_reason
      and jsonb_typeof(e.payload -> 'rawItem') = 'object'
    order by e.received_at
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- ------------------------------------------------------------------ 6. retries (970 body + the stale-pending sweep)
CREATE OR REPLACE FUNCTION public.process_webhook_retries(p_limit integer DEFAULT 100, p_max_attempts integer DEFAULT 8)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  e record;
  p jsonb;
  v_ok boolean;
  v_v2 boolean;
  v_processed int := 0;
  v_failed int := 0;
  v_ignored int := 0;
  v_expired int := 0;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  for e in
    select w.event_key, w.payload from public.whatsapp_webhook_events w
    where (w.status = 'failed'
           -- (978) a v2 event whose webhook request died between claim and finish (row left 'pending'): retried after 15 minutes
           or (w.status = 'pending' and w.received_at < now() - interval '15 minutes'
               and w.payload ->> 'kind' in ('kapso_inbound_v2', 'kapso_status_v2')))
      and w.attempts < p_max_attempts
      and coalesce(w.payload ->> 'kind', '') <> 'kapso_quarantined'   -- quarantined events are never retry work: not selected, not counted, not touched
    order by w.received_at
    limit least(greatest(p_limit, 1), 500)
    for update skip locked
  loop
    p := e.payload;
    v_v2 := (p ->> 'kind') in ('kapso_inbound_v2', 'kapso_status_v2');   -- (978) these finish through finish_kapso_event
    update public.whatsapp_webhook_events set attempts = attempts + 1 where event_key = e.event_key;
    begin
      case p ->> 'kind'
        when 'message' then
          perform public.ingest_whatsapp_message(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'fromWaId',
            p ->> 'profileName', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'echo' then
          perform public.ingest_whatsapp_echo(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'toWaId',
            p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'status' then
          v_ok := public.apply_whatsapp_status(p ->> 'waMessageId', p ->> 'status', p ->> 'errorCode', p ->> 'errorMessage');
        when 'kapso_message' then
          perform public.ingest_kapso_message(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'fromWaId',
            p ->> 'profileName', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'kapso_status' then
          v_ok := public.apply_kapso_status(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'status', p ->> 'errorCode',
            p ->> 'errorMessage', p ->> 'toWaId', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb),
            (p ->> 'sentAt')::timestamptz);
        when 'kapso_inbound_v2' then
          perform public.ingest_kapso_inbound(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'fromWaId', p ->> 'fromBsuid',
            p ->> 'origin', p ->> 'profileName', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb),
            (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'kapso_status_v2' then
          v_ok := public.apply_kapso_status_v2(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'status', p ->> 'errorCode',
            p ->> 'errorMessage', p ->> 'toWaId', p ->> 'toBsuid', p ->> 'origin', p ->> 'messageType', p ->> 'body',
            nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz, true);
        when 'kapso_quarantined' then
          continue;   -- unreachable: excluded by the query above. Kept so that, if the exclusion is ever removed, the payload is NOT wiped by the ELSE branch
        else
          perform public.finish_webhook_event(e.event_key, 'ignored');
          v_ignored := v_ignored + 1;
          continue;
      end case;
      if v_v2 then
        -- (978) v2 events use the 978 lifecycle function. This run holds the row FOR UPDATE (taken by the loop query) until the job
        -- transaction ends, so no webhook can finish it meanwhile and 'already_final' is not expected here; should it ever be
        -- answered, the event is counted neither processed nor failed (never a false success, never a false retry).
        if public.finish_kapso_event(e.event_key, case when v_ok then 'processed' else 'failed' end,
                                     case when v_ok then null else 'status.message_not_found' end) = 'finished' then
          if v_ok then v_processed := v_processed + 1; else v_failed := v_failed + 1; end if;
        end if;
      elsif v_ok then
        perform public.finish_webhook_event(e.event_key, 'processed');
        v_processed := v_processed + 1;
      else
        perform public.finish_webhook_event(e.event_key, 'failed', 'status.message_not_found');
        v_failed := v_failed + 1;
      end if;
    exception when others then
      if v_v2 then
        if public.finish_kapso_event(e.event_key, 'failed', app.safe_error(sqlerrm)) = 'finished' then
          v_failed := v_failed + 1;
        end if;
      else
        perform public.finish_webhook_event(e.event_key, 'failed', app.safe_error(sqlerrm));
        v_failed := v_failed + 1;
      end if;
    end;
  end loop;
  begin   -- the expiry must never undo the retries done above (the whole function is one transaction)
    v_expired := public.expire_unconfirmed_outbound();
  exception when others then
    v_expired := -1;
  end;
  return jsonb_build_object('processed', v_processed, 'failed', v_failed, 'ignored', v_ignored, 'unconfirmed_expired', v_expired);
end $function$;

-- ------------------------------------------------------------------ grants: service role only
revoke all on function
  public.kapso_account_protocol(text),
  public.claim_kapso_event(text, text, text, jsonb),
  public.finish_kapso_event(text, text, text),
  public.record_kapso_held_event(text, text, text, jsonb, text, text),
  public.list_kapso_quarantined(text, int)
from public, anon, authenticated;
grant execute on function
  public.kapso_account_protocol(text),
  public.claim_kapso_event(text, text, text, jsonb),
  public.finish_kapso_event(text, text, text),
  public.record_kapso_held_event(text, text, text, jsonb, text, text),
  public.list_kapso_quarantined(text, int)
to service_role;

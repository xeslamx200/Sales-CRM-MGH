-- Rollback of 20261104000978: restores the exact 970 body of process_webhook_retries, then drops the five functions 978 added.
-- No data is deleted: rows written through 978 are ordinary whatsapp_webhook_events rows (quarantine rows are 'failed' + kind
-- kapso_quarantined, which the 970 job excludes). After the rollback, protocol v2 must not be used (its RPCs are gone: it answers 503).
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
    where w.status = 'failed' and w.attempts < p_max_attempts
      and coalesce(w.payload ->> 'kind', '') <> 'kapso_quarantined'   -- quarantined events are never retry work: not selected, not counted, not touched
    order by w.received_at
    limit least(greatest(p_limit, 1), 500)
    for update skip locked
  loop
    p := e.payload;
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
      if v_ok then
        perform public.finish_webhook_event(e.event_key, 'processed');
        v_processed := v_processed + 1;
      else
        perform public.finish_webhook_event(e.event_key, 'failed', 'status.message_not_found');
        v_failed := v_failed + 1;
      end if;
    exception when others then
      perform public.finish_webhook_event(e.event_key, 'failed', app.safe_error(sqlerrm));
      v_failed := v_failed + 1;
    end;
  end loop;
  begin   -- the expiry must never undo the retries done above (the whole function is one transaction)
    v_expired := public.expire_unconfirmed_outbound();
  exception when others then
    v_expired := -1;
  end;
  return jsonb_build_object('processed', v_processed, 'failed', v_failed, 'ignored', v_ignored, 'unconfirmed_expired', v_expired);
end $function$;
drop function if exists public.list_kapso_quarantined(text, int);
drop function if exists public.record_kapso_held_event(text, text, text, jsonb, text, text);
drop function if exists public.finish_kapso_event(text, text, text);
drop function if exists public.claim_kapso_event(text, text, text, jsonb);
drop function if exists public.kapso_account_protocol(text);

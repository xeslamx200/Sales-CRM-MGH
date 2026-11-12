-- 20261104000999 - queue_outbound accepts voice / audio messages (p_message_type = 'audio'), so a person can record a voice note in the chat.
--
-- queue_outbound is migration 940's definition with exactly two changes: 'audio' joins the accepted message types, and an audio message may not
-- carry a caption (WhatsApp has no caption on audio). Everything else (access, ownership, 24-hour rule, idempotency, storage path pattern) is unchanged.
-- Rollback: supabase/rollbacks/20261104000999_queue_outbound_audio.rollback.sql (restores migration 940's body).

CREATE OR REPLACE FUNCTION public.queue_outbound(p_conversation_id uuid, p_client_request_id uuid, p_message_type text, p_body text DEFAULT NULL::text, p_media jsonb DEFAULT NULL::jsonb, p_template jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(message_id uuid, already_queued boolean, phone_number_id text, to_wa_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_conv public.conversations;
  v_acc public.whatsapp_accounts;
  v_tpl public.whatsapp_templates;
  v_msg uuid;
  v_body text;
  v_media jsonb;
  v_params text[];
begin
  if v_uid is null then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_message_type not in ('text', 'image', 'document', 'audio', 'template') then
    raise exception 'message.invalid_body' using errcode = '23514';
  end if;

  select id into v_msg from public.messages where client_request_id = p_client_request_id;
  if found then
    if not exists (select 1 from public.messages m where m.id = v_msg and m.sent_by = v_uid) then
      raise exception 'message.request_id_conflict' using errcode = '23514';
    end if;
    return query select m.id, true, a.phone_number_id, c.customer_wa_id
      from public.messages m join public.conversations c on c.id = m.conversation_id
      join public.whatsapp_accounts a on a.id = c.whatsapp_account_id where m.id = v_msg;
    return;
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id for update;
  if not found or not app.can_see_conversation_row(v_conv.company_id, v_conv.whatsapp_account_id, v_conv.owner_id) then
    raise exception 'conversation.not_found' using errcode = 'P0002';
  end if;
  select * into v_acc from public.whatsapp_accounts where id = v_conv.whatsapp_account_id;
  if v_acc.status not in ('test', 'active') and not v_acc.is_simulated then
    raise exception 'whatsapp.account_not_active' using errcode = '23514';
  end if;
  if not app.is_super_admin() and not exists (
    select 1 from public.whatsapp_account_access a
    where a.whatsapp_account_id = v_acc.id and a.user_id = v_uid and a.can_reply) then
    raise exception 'whatsapp.no_reply_permission' using errcode = '42501';
  end if;
  if v_conv.owner_id is not null and v_conv.owner_id <> v_uid and not app.is_company_manager(v_conv.company_id) then
    raise exception 'conversation.owned_by_other' using errcode = '42501';
  end if;

  if p_message_type = 'template' then
    -- Templates are the only way to (re)open the conversation after 24 h.
    select * into v_tpl from public.whatsapp_templates t
    where t.whatsapp_account_id = v_acc.id and t.name = p_template ->> 'name' and t.language = p_template ->> 'language'
      and t.status = 'APPROVED';
    if not found then
      raise exception 'whatsapp.template_not_approved' using errcode = '23514';
    end if;
    if not v_tpl.supported then
      raise exception 'whatsapp.template_unsupported' using errcode = '23514';
    end if;
    select coalesce(array_agg(left(x, 1024) order by o), array[]::text[]) into v_params
    from jsonb_array_elements_text(coalesce(p_template -> 'params', '[]'::jsonb)) with ordinality as e(x, o);
    if coalesce(array_length(v_params, 1), 0) <> v_tpl.param_count or exists (select 1 from unnest(v_params) x where btrim(x) = '') then
      raise exception 'whatsapp.template_params_invalid' using errcode = '23514';
    end if;
    v_body := app.render_template(v_tpl.body_text, v_params);
    v_media := jsonb_build_object('template', jsonb_build_object('name', v_tpl.name, 'language', v_tpl.language, 'params', to_jsonb(v_params)));
  else
    if v_conv.last_inbound_at is null or v_conv.last_inbound_at < now() - interval '24 hours' then
      raise exception 'whatsapp.outside_service_window' using errcode = '23514';
    end if;
    if p_message_type = 'text' then
      if p_body is null or btrim(p_body) = '' or length(p_body) > 4096 then
        raise exception 'message.invalid_body' using errcode = '23514';
      end if;
      v_body := p_body;
    else
      -- Uploaded by the server under outbound/<conversation>/… after validating type and size.
      if p_media is null or coalesce(p_media ->> 'storage_path', '') !~ ('^outbound/' || v_conv.id || '/[A-Za-z0-9._-]+/[^/]{1,200}$')
         or coalesce(p_media ->> 'mime_type', '') = '' or length(coalesce(p_body, '')) > 1024
         or (p_message_type = 'audio' and btrim(coalesce(p_body, '')) <> '') then   -- an audio message cannot carry a caption
        raise exception 'message.invalid_media' using errcode = '23514';
      end if;
      v_body := nullif(btrim(coalesce(p_body, '')), '');
      v_media := jsonb_build_object('storage_path', p_media ->> 'storage_path', 'mime_type', p_media ->> 'mime_type',
        'filename', left(coalesce(p_media ->> 'filename', ''), 200), 'size', (p_media ->> 'size')::bigint);
    end if;
  end if;

  if v_conv.owner_id is null and exists (
    select 1 from public.whatsapp_account_access a
    where a.whatsapp_account_id = v_acc.id and a.user_id = v_uid and a.can_reply) then
    perform set_config('app.assign_reason', 'auto: first reply', true);
    update public.conversations set owner_id = v_uid where id = v_conv.id;
    perform set_config('app.assign_reason', '', true);
  end if;

  insert into public.messages (conversation_id, direction, message_type, body, media, status, sent_by,
                               client_request_id, sent_at, is_simulated)
  values (v_conv.id, 'outbound', p_message_type, v_body, v_media, 'queued', v_uid, p_client_request_id, now(), v_acc.is_simulated)
  returning id into v_msg;

  return query select v_msg, false, v_acc.phone_number_id, v_conv.customer_wa_id;
end $function$;

-- Templates the CRM can actually send.
--
-- Found with the real Meta test account: Meta's sample templates include media
-- headers, carousels and buttons with parameters. The CRM sends body
-- parameters only, so Meta would reject those templates. They are still
-- synced and listed for administrators, but marked unsupported, hidden from
-- the composer and refused by queue_outbound.
--
-- Supported: HEADER (text without parameters), BODY (numbered {{n}}
-- parameters), FOOTER, and BUTTONS of type QUICK_REPLY, PHONE_NUMBER or URL
-- without parameters. Anything else (media/location headers, header
-- parameters, named body parameters, carousels, copy-code/OTP/flow buttons,
-- dynamic URLs, limited-time offers) is unsupported.

create or replace function app.template_supported(p_components jsonb)
returns boolean
language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(p_components) = 'array' then p_components else '[]'::jsonb end) c
    where coalesce(c ->> 'type', '') not in ('HEADER', 'BODY', 'FOOTER', 'BUTTONS')
       or (c ->> 'type' = 'HEADER' and (coalesce(c ->> 'format', 'TEXT') <> 'TEXT' or coalesce(c ->> 'text', '') ~ '\{\{'))
       or (c ->> 'type' = 'BODY' and coalesce(c ->> 'text', '') ~ '\{\{[^0-9}]')
       or (c ->> 'type' = 'BUTTONS' and exists (
            select 1 from jsonb_array_elements(case when jsonb_typeof(c -> 'buttons') = 'array' then c -> 'buttons' else '[]'::jsonb end) b
            where coalesce(b ->> 'type', '') not in ('QUICK_REPLY', 'PHONE_NUMBER', 'URL')
               or (b ->> 'type' = 'URL' and coalesce(b ->> 'url', '') ~ '\{\{')))
  )
$$;
revoke all on function app.template_supported(jsonb) from public, anon;
grant execute on function app.template_supported(jsonb) to authenticated, service_role;

alter table public.whatsapp_templates
  add column supported boolean generated always as (app.template_supported(components)) stored;

-- queue_outbound (0890) with one added check after the approval check.
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
  if p_message_type not in ('text', 'image', 'document', 'template') then
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
         or coalesce(p_media ->> 'mime_type', '') = '' or length(coalesce(p_body, '')) > 1024 then
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

-- =============================================================================
-- 0890 — WhatsApp media, approved templates, credential health alerts.
--
-- * Private Storage buckets (created where Supabase Storage exists). Files are
--   only ever served through short-lived signed URLs issued after an RLS
--   check on the owning row.
-- * message_media_cache: where an inbound media file was cached (Meta URLs
--   expire after 5 minutes, webhook media ids after 7 days). Messages stay
--   immutable; the cache is a separate, service-written table.
-- * whatsapp_templates: approved templates synced from Meta per number.
-- * whatsapp_account_health + report_whatsapp_account_health: credential
--   failures (expired / revoked / invalid token) alert super admins and the
--   number's company admins once a day, and are audited.
-- * queue_outbound: one queueing RPC for text, image, document and template
--   messages. Same checks as queue_outbound_message (grant + can_reply,
--   ownership, account active, idempotency); free-form content needs the
--   24-hour window, templates don't. Template text is rendered in SQL from the
--   synced, APPROVED template — callers cannot supply it.
--   queue_outbound_message becomes a thin wrapper (same signature/behaviour).
-- =============================================================================

-- ------------------------------------------------------------------ buckets
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('whatsapp-media', 'whatsapp-media', false, 104857600, array[
      'image/jpeg', 'image/png', 'image/webp', 'audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg',
      'video/mp4', 'video/3gpp', 'application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('attachments', 'attachments', false, 26214400, array[
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

-- -------------------------------------------------------------- media cache
create table public.message_media_cache (
  message_id uuid primary key references public.messages (id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null check (length(mime_type) <= 120),
  size_bytes bigint not null check (size_bytes between 1 and 104857600),
  cached_at timestamptz not null default now()
);
alter table public.message_media_cache enable row level security;
revoke all on public.message_media_cache from anon;
create policy message_media_cache_select on public.message_media_cache for select to authenticated
  using (app.can_access_conversation((select m.conversation_id from public.messages m where m.id = message_id)));
-- No user write policies: written by the server (service role) after an RLS check.

-- ----------------------------------------------------------------- templates
create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  whatsapp_account_id uuid not null references public.whatsapp_accounts (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9_]+$' and length(name) <= 512),
  language text not null check (language ~ '^[a-zA-Z_]{2,15}$'),
  category text not null default 'UTILITY',
  status text not null,
  body_text text not null default '' check (length(body_text) <= 2048),
  param_count int not null default 0 check (param_count between 0 and 20),
  components jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now(),
  unique (whatsapp_account_id, name, language)
);
alter table public.whatsapp_templates enable row level security;
revoke all on public.whatsapp_templates from anon;
create policy whatsapp_templates_select on public.whatsapp_templates for select to authenticated
  using (app.has_wa_account_access(whatsapp_account_id) or exists (
    select 1 from public.whatsapp_accounts a where a.id = whatsapp_account_id and app.is_company_admin(a.default_company_id)));

-- Service only: replace the synced template set of one number.
create or replace function public.sync_whatsapp_templates(p_account_id uuid, p_templates jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_templates) is distinct from 'array' then
    raise exception 'whatsapp.invalid_payload' using errcode = '22023';
  end if;
  delete from public.whatsapp_templates t
  where t.whatsapp_account_id = p_account_id
    and not exists (select 1 from jsonb_array_elements(p_templates) x
                    where x ->> 'name' = t.name and x ->> 'language' = t.language);
  insert into public.whatsapp_templates (whatsapp_account_id, name, language, category, status, body_text, param_count, components, synced_at)
  select p_account_id, x ->> 'name', x ->> 'language', coalesce(x ->> 'category', 'UTILITY'), x ->> 'status',
         left(coalesce(x ->> 'body_text', ''), 2048), coalesce((x ->> 'param_count')::int, 0),
         coalesce(x -> 'components', '[]'::jsonb), now()
  from jsonb_array_elements(p_templates) x
  on conflict (whatsapp_account_id, name, language) do update set
    category = excluded.category, status = excluded.status, body_text = excluded.body_text,
    param_count = excluded.param_count, components = excluded.components, synced_at = excluded.synced_at;
  get diagnostics v = row_count;
  return v;
end $$;

-- {{1}}..{{n}} → parameters.
create or replace function app.render_template(p_body text, p_params text[]) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := p_body;
  i int;
begin
  for i in 1 .. coalesce(array_length(p_params, 1), 0) loop
    v := replace(v, '{{' || i || '}}', p_params[i]);
  end loop;
  return v;
end $$;

-- ------------------------------------------------------------ health / alerts
create table public.whatsapp_account_health (
  whatsapp_account_id uuid primary key references public.whatsapp_accounts (id) on delete cascade,
  status text not null check (status in ('ok', 'error')),
  error_code text check (error_code is null or length(error_code) <= 60),
  failing_since timestamptz,
  checked_at timestamptz not null default now()
);
alter table public.whatsapp_account_health enable row level security;
revoke all on public.whatsapp_account_health from anon;
create policy whatsapp_account_health_select on public.whatsapp_account_health for select to authenticated
  using (app.has_wa_account_access(whatsapp_account_id) or exists (
    select 1 from public.whatsapp_accounts a where a.id = whatsapp_account_id and app.is_company_admin(a.default_company_id)));

-- Service only. Called after any Graph API call that proves the credentials
-- work (p_ok) or fail with an auth error (expired / revoked / invalid token,
-- missing permission).
create or replace function public.report_whatsapp_account_health(p_account_id uuid, p_ok boolean, p_error_code text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.whatsapp_account_health;
  v_acc public.whatsapp_accounts;
  r record;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  select * into v_acc from public.whatsapp_accounts where id = p_account_id;
  if not found then return; end if;
  select * into v_prev from public.whatsapp_account_health where whatsapp_account_id = p_account_id for update;

  insert into public.whatsapp_account_health (whatsapp_account_id, status, error_code, failing_since, checked_at)
  values (p_account_id, case when p_ok then 'ok' else 'error' end, case when p_ok then null else left(p_error_code, 60) end,
          case when p_ok then null else now() end, now())
  on conflict (whatsapp_account_id) do update set
    status = excluded.status, error_code = excluded.error_code, checked_at = excluded.checked_at,
    failing_since = case when excluded.status = 'ok' then null
                         else coalesce(public.whatsapp_account_health.failing_since, excluded.failing_since) end;

  if not p_ok then
    if v_prev.status is distinct from 'error' then
      perform app.write_audit(v_acc.default_company_id, 'whatsapp.credentials_failed', 'whatsapp_account', p_account_id,
        jsonb_build_object('error_code', left(p_error_code, 60)));
    end if;
    -- At most one alert per person, number and day.
    for r in
      select p.id as user_id from public.profiles p where p.is_super_admin and p.is_active
      union
      select m.user_id from public.company_memberships m join public.profiles p on p.id = m.user_id and p.is_active
      where m.company_id = v_acc.default_company_id and m.role = 'company_admin' and m.is_active
    loop
      perform app.notify(r.user_id, v_acc.default_company_id, 'whatsapp_credentials',
        'خلل في ربط رقم واتساب: ' || v_acc.display_name,
        'رمز الوصول منتهي أو ملغى أو غير صالح (' || coalesce(left(p_error_code, 60), '?') || '). الإرسال والوسائط متوقفة لهذا الرقم.',
        'whatsapp_account', p_account_id, 'wa-cred:' || p_account_id || ':' || current_date);
    end loop;
  elsif v_prev.status = 'error' then
    perform app.write_audit(v_acc.default_company_id, 'whatsapp.credentials_restored', 'whatsapp_account', p_account_id, '{}'::jsonb);
  end if;
end $$;

-- ----------------------------------------------------------- outbound queue
create or replace function public.queue_outbound(
  p_conversation_id uuid, p_client_request_id uuid, p_message_type text,
  p_body text default null, p_media jsonb default null, p_template jsonb default null
) returns table (message_id uuid, already_queued boolean, phone_number_id text, to_wa_id text)
language plpgsql security definer set search_path = '' as $$
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
end $$;

create or replace function public.queue_outbound_message(
  p_conversation_id uuid, p_body text, p_client_request_id uuid
) returns table (message_id uuid, already_queued boolean, phone_number_id text, to_wa_id text)
language sql security invoker set search_path = '' as $$
  select * from public.queue_outbound(p_conversation_id, p_client_request_id, 'text', p_body, null, null)
$$;

revoke execute on function public.sync_whatsapp_templates(uuid, jsonb), public.report_whatsapp_account_health(uuid, boolean, text),
  public.queue_outbound(uuid, uuid, text, text, jsonb, jsonb) from public, anon;
revoke execute on function public.sync_whatsapp_templates(uuid, jsonb), public.report_whatsapp_account_health(uuid, boolean, text)
  from authenticated;
grant execute on function public.sync_whatsapp_templates(uuid, jsonb), public.report_whatsapp_account_health(uuid, boolean, text)
  to service_role;
grant execute on function public.queue_outbound(uuid, uuid, text, text, jsonb, jsonb) to authenticated, service_role;
revoke all on function app.render_template(text, text[]) from public, anon;
grant execute on function app.render_template(text, text[]) to authenticated, service_role;

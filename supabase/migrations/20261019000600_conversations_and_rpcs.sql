-- =============================================================================
-- 0600 — Conversations, messages, WhatsApp ingestion, and transactional RPCs.
-- RPCs in `public` are callable through the Supabase Data API. Each one checks
-- authorization explicitly; SECURITY INVOKER ones additionally run under RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Conversations: guarded ownership and company changes.
-- -----------------------------------------------------------------------------
create or replace function app.guard_conversation() returns trigger
language plpgsql as $$
declare
  v_service boolean := app.is_service_context() or app.in_system_op();
begin
  if (new.whatsapp_account_id, new.customer_wa_id, new.is_simulated, new.created_at)
     is distinct from (old.whatsapp_account_id, old.customer_wa_id, old.is_simulated, old.created_at) then
    raise exception 'conversation.immutable_field' using errcode = '42501';
  end if;
  if v_service then return new; end if;

  if new.contact_id is distinct from old.contact_id
     and coalesce(current_setting('app.merging_contacts', true), '') <> 'on' then
    raise exception 'conversation.immutable_field' using errcode = '42501';
  end if;
  if (new.last_message_at, new.last_inbound_at, new.last_outbound_at)
     is distinct from (old.last_message_at, old.last_inbound_at, old.last_outbound_at) then
    raise exception 'conversation.system_field' using errcode = '42501';
  end if;
  if new.unread_count is distinct from old.unread_count and new.unread_count <> 0 then
    raise exception 'conversation.unread_can_only_be_cleared' using errcode = '42501';
  end if;
  if new.company_id is distinct from old.company_id
     and not (app.is_company_manager(old.company_id) and app.is_company_manager(new.company_id)) then
    raise exception 'conversation.company_change_forbidden' using errcode = '42501';
  end if;
  if new.owner_id is distinct from old.owner_id then
    if new.owner_id is not null and not (
      app.is_company_member(new.company_id, new.owner_id)
      and exists (select 1 from public.whatsapp_account_access a
                  where a.whatsapp_account_id = new.whatsapp_account_id and a.user_id = new.owner_id)
    ) then
      raise exception 'conversation.owner_needs_number_access' using errcode = '23514';
    end if;
    if not (
      app.is_company_manager(new.company_id)
      or (old.owner_id is null and new.owner_id = auth.uid() and app.has_wa_account_access(new.whatsapp_account_id))
      or (old.owner_id = auth.uid() and new.owner_id is null)
    ) then
      raise exception 'conversation.assign_forbidden' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger conversations_guard before update on public.conversations
  for each row execute function app.guard_conversation();

create or replace function app.after_conversation_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := app.actor_id();
  v_reason text := nullif(current_setting('app.assign_reason', true), '');
begin
  if new.owner_id is distinct from old.owner_id then
    insert into public.conversation_assignments (conversation_id, from_user_id, to_user_id, assigned_by, reason)
    values (new.id, old.owner_id, new.owner_id, v_actor, v_reason);
    perform app.write_audit(new.company_id, 'conversation.assigned', 'conversation', new.id,
      jsonb_build_object('from_user_id', old.owner_id, 'to_user_id', new.owner_id));
    if new.owner_id is not null and new.owner_id is distinct from v_actor then
      perform app.notify(new.owner_id, new.company_id, 'conversation_assigned', 'تم إسناد محادثة واتساب إليك',
                         null, 'conversation', new.id);
    end if;
  end if;
  if new.company_id is distinct from old.company_id then
    perform app.write_audit(new.company_id, 'conversation.company_changed', 'conversation', new.id,
      jsonb_build_object('from_company_id', old.company_id, 'to_company_id', new.company_id));
    perform app.ensure_contact_link(new.contact_id, new.company_id);
  end if;
  return null;
end $$;
create trigger conversations_after after update on public.conversations
  for each row execute function app.after_conversation_update();

-- Messages keep the conversation's denormalized timestamps current
-- (used for inbox ordering and the 24-hour customer-service window).
create or replace function app.after_message_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.begin_system_op();
  if new.direction = 'inbound' then
    update public.conversations set
      last_message_at = greatest(coalesce(last_message_at, new.sent_at), new.sent_at),
      last_inbound_at = greatest(coalesce(last_inbound_at, new.sent_at), new.sent_at),
      unread_count = unread_count + 1,
      status = case when status = 'resolved' then 'open'::public.conversation_status else status end
    where id = new.conversation_id;
  else
    update public.conversations set
      last_message_at = greatest(coalesce(last_message_at, new.sent_at), new.sent_at),
      last_outbound_at = greatest(coalesce(last_outbound_at, new.sent_at), new.sent_at)
    where id = new.conversation_id;
  end if;
  perform app.end_system_op();
  return null;
end $$;
create trigger messages_after_insert after insert on public.messages
  for each row execute function app.after_message_insert();

-- Message content and authorship are immutable; only delivery state moves,
-- and only forwards (webhooks can arrive out of order).
create or replace function app.message_status_rank(p public.message_status) returns int
language sql immutable as $$
  select case p when 'received' then 0 when 'queued' then 1 when 'sent' then 2
                when 'delivered' then 3 when 'read' then 4 when 'failed' then 5 end
$$;

create or replace function app.guard_message_update() returns trigger
language plpgsql as $$
begin
  if (new.conversation_id, new.direction, new.body, new.media, new.sent_by, new.client_request_id,
      new.message_type, new.is_simulated, new.created_at)
     is distinct from
     (old.conversation_id, old.direction, old.body, old.media, old.sent_by, old.client_request_id,
      old.message_type, old.is_simulated, old.created_at) then
    raise exception 'message.immutable_field' using errcode = '42501';
  end if;
  if old.wa_message_id is not null and new.wa_message_id is distinct from old.wa_message_id then
    raise exception 'message.immutable_field' using errcode = '42501';
  end if;
  -- `failed` may only follow queued/sent; never regress a delivered/read message.
  if new.status is distinct from old.status then
    if old.status in ('read', 'failed') then
      new.status := old.status;
    elsif new.status = 'failed' and old.status not in ('queued', 'sent') then
      new.status := old.status;
    elsif new.status <> 'failed' and app.message_status_rank(new.status) < app.message_status_rank(old.status) then
      new.status := old.status;
    end if;
  end if;
  return new;
end $$;
create trigger messages_guard before update on public.messages
  for each row execute function app.guard_message_update();

-- =============================================================================
-- RPC: find or create a contact and link it to a company.
-- Exact E.164 match = same person (linked, never duplicated). Same e-mail or
-- same name without a phone match = possible duplicate, queued for review.
-- =============================================================================
create or replace function public.find_or_create_contact(
  p_company_id uuid,
  p_full_name text,
  p_phone_e164 text default null,
  p_email text default null
) returns table (contact_id uuid, matched_existing boolean, open_leads_in_company int, possible_duplicates int)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_contact uuid;
  v_matched boolean := false;
  v_dups int := 0;
  v_role public.app_role;
  r record;
begin
  if v_uid is null or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_full_name is null or btrim(p_full_name) = '' then
    raise exception 'contact.name_required' using errcode = '23514';
  end if;
  p_phone_e164 := nullif(btrim(p_phone_e164), '');
  p_email := nullif(lower(btrim(p_email)), '');
  v_role := app.company_role(p_company_id);

  if p_phone_e164 is not null then
    select c.id into v_contact from public.contacts c
    where c.phone_e164 = p_phone_e164 and c.merged_into_id is null;
    v_matched := found;
  end if;

  if v_contact is null then
    insert into public.contacts (full_name, phone_e164, email, created_by)
    values (btrim(p_full_name), p_phone_e164, p_email, v_uid)
    returning id into v_contact;

    for r in
      select c.id, case when c.email = p_email then 'same_email' else 'same_name' end as reason
      from public.contacts c
      where c.id <> v_contact and c.merged_into_id is null
        and ((p_email is not null and c.email = p_email)
          or lower(c.full_name) = lower(btrim(p_full_name)))
      limit 20
    loop
      insert into public.contact_duplicate_reviews (contact_a_id, contact_b_id, reason)
      values (least(v_contact, r.id), greatest(v_contact, r.id), r.reason)
      on conflict do nothing;
      v_dups := v_dups + 1;
    end loop;
  end if;

  -- Link to the company; agents become the company-level owner of contacts
  -- they bring in so they can see them.
  insert into public.contact_companies (contact_id, company_id, owner_id, created_by)
  values (v_contact, p_company_id,
          case when v_role in ('sales_agent', 'cs_agent') then v_uid end, v_uid)
  on conflict on constraint contact_companies_contact_id_company_id_key do update
    set owner_id = coalesce(public.contact_companies.owner_id, excluded.owner_id);

  return query select v_contact, v_matched,
    (select count(*)::int from public.leads l
     where l.contact_id = v_contact and l.company_id = p_company_id
       and l.archived_at is null and l.status not in ('converted', 'lost', 'unqualified')),
    v_dups;
end $$;

-- =============================================================================
-- RPC: assign / reassign a lead with a reason (history row records it).
-- SECURITY INVOKER: RLS + the lead guard decide whether it is allowed.
-- =============================================================================
create or replace function public.assign_lead(p_lead_id uuid, p_owner_id uuid, p_team_id uuid default null, p_reason text default null)
returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform set_config('app.assign_reason', coalesce(left(p_reason, 1000), ''), true);
  update public.leads set owner_id = p_owner_id, team_id = coalesce(p_team_id, team_id)
  where id = p_lead_id;
  if not found then
    raise exception 'lead.not_found' using errcode = 'P0002';
  end if;
  perform set_config('app.assign_reason', '', true);
end $$;

-- =============================================================================
-- RPC: convert a lead into a deal atomically.
-- =============================================================================
create or replace function public.convert_lead_to_deal(
  p_lead_id uuid,
  p_title text default null,
  p_amount numeric default 0,
  p_pipeline_id uuid default null,
  p_stage_id uuid default null,
  p_expected_close_date date default null,
  p_owner_id uuid default null
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_lead public.leads;
  v_pipeline uuid := p_pipeline_id;
  v_stage uuid := p_stage_id;
  v_deal uuid;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead.not_found' using errcode = 'P0002';
  end if;
  if v_lead.status = 'converted' then
    raise exception 'lead.already_converted' using errcode = '23514';
  end if;
  if v_lead.archived_at is not null then
    raise exception 'lead.archived' using errcode = '23514';
  end if;
  if v_pipeline is null then
    select id into v_pipeline from public.pipelines
    where company_id = v_lead.company_id and kind = 'deal' and is_default and is_active;
  end if;
  if v_stage is null then
    select id into v_stage from public.pipeline_stages
    where pipeline_id = v_pipeline and stage_type = 'open' and is_active
    order by position limit 1;
  end if;
  if v_pipeline is null or v_stage is null then
    raise exception 'deal.no_pipeline' using errcode = '23514';
  end if;

  insert into public.deals (company_id, lead_id, contact_id, pipeline_id, stage_id, title, amount,
                            expected_close_date, owner_id, created_by)
  values (v_lead.company_id, v_lead.id, v_lead.contact_id, v_pipeline, v_stage,
          coalesce(nullif(btrim(p_title), ''), v_lead.title), coalesce(p_amount, 0),
          p_expected_close_date, coalesce(p_owner_id, v_lead.owner_id, auth.uid()), auth.uid())
  returning id into v_deal;

  update public.leads set status = 'converted' where id = v_lead.id;
  return v_deal;
end $$;

-- =============================================================================
-- RPC: assign / claim / release a conversation.
-- =============================================================================
create or replace function public.assign_conversation(p_conversation_id uuid, p_owner_id uuid, p_reason text default null)
returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform set_config('app.assign_reason', coalesce(left(p_reason, 1000), ''), true);
  update public.conversations set owner_id = p_owner_id where id = p_conversation_id;
  if not found then
    raise exception 'conversation.not_found' using errcode = 'P0002';
  end if;
  perform set_config('app.assign_reason', '', true);
end $$;

-- =============================================================================
-- RPC: queue an outbound WhatsApp text reply.
-- The server action calls this with the user's session, then sends the
-- message to Meta with the service role and records the result through
-- public.record_outbound_result. The authenticated user is recorded as sender.
-- =============================================================================
create or replace function public.queue_outbound_message(
  p_conversation_id uuid, p_body text, p_client_request_id uuid
) returns table (message_id uuid, already_queued boolean, phone_number_id text, to_wa_id text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_conv public.conversations;
  v_acc public.whatsapp_accounts;
  v_msg uuid;
begin
  if v_uid is null then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 4096 then
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
  -- WhatsApp only allows free-form replies within 24h of the customer's last message.
  if v_conv.last_inbound_at is null or v_conv.last_inbound_at < now() - interval '24 hours' then
    raise exception 'whatsapp.outside_service_window' using errcode = '23514';
  end if;

  -- First reply claims an unassigned conversation (only for users holding a
  -- grant on the number, since owners must have one).
  if v_conv.owner_id is null and exists (
    select 1 from public.whatsapp_account_access a
    where a.whatsapp_account_id = v_acc.id and a.user_id = v_uid) then
    perform set_config('app.assign_reason', 'auto: first reply', true);
    update public.conversations set owner_id = v_uid where id = v_conv.id;
    perform set_config('app.assign_reason', '', true);
  end if;

  insert into public.messages (conversation_id, direction, message_type, body, status, sent_by,
                               client_request_id, sent_at, is_simulated)
  values (v_conv.id, 'outbound', 'text', p_body, 'queued', v_uid, p_client_request_id, now(), v_acc.is_simulated)
  returning id into v_msg;

  return query select v_msg, false, v_acc.phone_number_id, v_conv.customer_wa_id;
end $$;

-- Service role only: record what Meta answered for an outbound send.
create or replace function public.record_outbound_result(
  p_message_id uuid, p_wa_message_id text, p_error_code text default null, p_error_message text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_wa_message_id is not null then
    update public.messages set wa_message_id = p_wa_message_id, status = 'sent', status_updated_at = now()
    where id = p_message_id and wa_message_id is null;
  else
    update public.messages set status = 'failed', error_code = left(p_error_code, 60),
      error_message = left(p_error_message, 1000), status_updated_at = now()
    where id = p_message_id;
  end if;
end $$;

-- =============================================================================
-- Service role only: idempotent ingestion of one inbound WhatsApp message.
-- Returns the message id and whether it was a duplicate delivery.
-- =============================================================================
create or replace function public.ingest_whatsapp_message(
  p_phone_number_id text,
  p_wa_message_id text,
  p_from_wa_id text,
  p_profile_name text,
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
  if p_wa_message_id is null or p_from_wa_id !~ '^[1-9][0-9]{6,14}$' then
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

  v_phone := '+' || p_from_wa_id;
  select id into v_contact from public.contacts where phone_e164 = v_phone and merged_into_id is null;
  if v_contact is null then
    insert into public.contacts (full_name, phone_e164)
    values (coalesce(nullif(btrim(left(p_profile_name, 200)), ''), v_phone), v_phone)
    on conflict (phone_e164) where merged_into_id is null and phone_e164 is not null do nothing
    returning id into v_contact;
    if v_contact is null then
      select id into v_contact from public.contacts where phone_e164 = v_phone and merged_into_id is null;
    end if;
  end if;
  perform app.ensure_contact_link(v_contact, v_acc.default_company_id);

  insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, is_simulated)
  values (v_acc.id, v_acc.default_company_id, v_contact, p_from_wa_id, v_acc.is_simulated)
  on conflict (whatsapp_account_id, customer_wa_id) do nothing;
  select id into v_conv from public.conversations
  where whatsapp_account_id = v_acc.id and customer_wa_id = p_from_wa_id;

  insert into public.messages (conversation_id, direction, wa_message_id, message_type, body, media, status, sent_at, is_simulated)
  values (v_conv, 'inbound', p_wa_message_id, left(coalesce(p_message_type, 'text'), 40), left(p_body, 4096),
          p_media, 'received', coalesce(p_sent_at, now()), v_acc.is_simulated)
  on conflict (wa_message_id) do nothing
  returning id into v_msg;

  if v_msg is null then   -- lost a race with a concurrent duplicate delivery
    select m.id into v_msg from public.messages m where m.wa_message_id = p_wa_message_id;
    return query select v_msg, v_conv, true;
    return;
  end if;
  return query select v_msg, v_conv, false;
end $$;

-- Service role only: apply a delivery status update. Unknown IDs are ignored
-- (status for a message sent outside this system, or arriving before the send
-- result was recorded) and reported back so the caller can retry later.
create or replace function public.apply_whatsapp_status(
  p_wa_message_id text, p_status text, p_error_code text default null, p_error_message text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_status public.message_status;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  v_status := case p_status when 'sent' then 'sent' when 'delivered' then 'delivered'
                            when 'read' then 'read' when 'failed' then 'failed' end;
  if v_status is null then return false; end if;
  update public.messages set
    status = v_status,
    status_updated_at = now(),
    error_code = case when v_status = 'failed' then left(p_error_code, 60) else error_code end,
    error_message = case when v_status = 'failed' then left(p_error_message, 1000) else error_message end
  where wa_message_id = p_wa_message_id and direction = 'outbound';
  return found;
end $$;

-- =============================================================================
-- RPC: merge two contacts after human review.
-- Allowed only for someone who administers every company linked to either
-- contact, so a merge can never expose another company's data.
-- =============================================================================
create or replace function public.merge_contacts(p_keep_id uuid, p_merge_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_keep public.contacts;
  v_merge public.contacts;
begin
  if auth.uid() is null then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_keep_id = p_merge_id then
    raise exception 'contact.merge_same' using errcode = '23514';
  end if;
  select * into v_keep from public.contacts where id = p_keep_id for update;
  select * into v_merge from public.contacts where id = p_merge_id for update;
  if v_keep.id is null or v_merge.id is null or v_keep.merged_into_id is not null or v_merge.merged_into_id is not null then
    raise exception 'contact.not_found' using errcode = 'P0002';
  end if;
  if not app.is_super_admin() and exists (
    select 1 from public.contact_companies cc
    where cc.contact_id in (p_keep_id, p_merge_id) and not app.is_company_admin(cc.company_id)) then
    raise exception 'contact.merge_forbidden' using errcode = '42501';
  end if;
  if v_keep.phone_e164 is not null and v_merge.phone_e164 is not null and v_keep.phone_e164 <> v_merge.phone_e164 then
    raise exception 'contact.merge_conflicting_phones' using errcode = '23514';
  end if;

  perform set_config('app.merging_contacts', 'on', true);

  update public.contacts set merged_into_id = p_keep_id where id = p_merge_id;
  update public.contacts set
    phone_e164 = coalesce(phone_e164, v_merge.phone_e164),
    email = coalesce(email, v_merge.email)
  where id = p_keep_id;

  update public.leads set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.deals set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.tasks set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.activities set contact_id = p_keep_id where contact_id = p_merge_id;
  update public.conversations set contact_id = p_keep_id where contact_id = p_merge_id;

  -- Company links: keep the surviving contact's link; move the others.
  update public.contact_companies cc set contact_id = p_keep_id
  where cc.contact_id = p_merge_id
    and not exists (select 1 from public.contact_companies k
                    where k.contact_id = p_keep_id and k.company_id = cc.company_id);
  delete from public.contact_companies where contact_id = p_merge_id;

  update public.contact_duplicate_reviews set status = 'merged', resolved_by = auth.uid(), resolved_at = now()
  where status = 'pending' and (contact_a_id in (p_keep_id, p_merge_id) or contact_b_id in (p_keep_id, p_merge_id));

  perform set_config('app.merging_contacts', '', true);

  perform app.write_audit(null, 'contact.merged', 'contact', p_keep_id,
    jsonb_build_object('merged_contact_id', p_merge_id));
end $$;

create or replace function public.dismiss_duplicate_review(p_review_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_r public.contact_duplicate_reviews;
begin
  select * into v_r from public.contact_duplicate_reviews where id = p_review_id for update;
  if not found or not (app.can_see_contact(v_r.contact_a_id) and app.can_see_contact(v_r.contact_b_id)) then
    raise exception 'review.not_found' using errcode = 'P0002';
  end if;
  if not app.is_super_admin() and not exists (
    select 1 from public.contact_companies cc
    where cc.contact_id in (v_r.contact_a_id, v_r.contact_b_id) and app.is_company_manager(cc.company_id)) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  update public.contact_duplicate_reviews set status = 'dismissed', resolved_by = auth.uid(), resolved_at = now()
  where id = p_review_id;
end $$;

-- =============================================================================
-- Notifications
-- =============================================================================
create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns int
language sql security invoker set search_path = '' as $$
  with u as (
    update public.notifications set read_at = now()
    where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids))
    returning 1
  ) select count(*)::int from u
$$;

-- Scheduled (service role / pg_cron): due-soon and overdue task reminders.
-- Dedupe keys make repeated runs safe.
create or replace function public.generate_task_reminders(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_count int := 0;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  for r in
    select t.id, t.company_id, t.assigned_to, t.title, t.due_at
    from public.tasks t
    where t.status in ('open', 'in_progress') and t.assigned_to is not null
      and t.due_at is not null and t.due_at <= p_now + interval '1 hour'
  loop
    if r.due_at > p_now then
      perform app.notify(r.assigned_to, r.company_id, 'task_due_soon', 'مهمة مستحقة قريباً', r.title,
                         'task', r.id, 'task_due_soon:' || r.id);
    else
      perform app.notify(r.assigned_to, r.company_id, 'task_overdue', 'مهمة متأخرة', r.title,
                         'task', r.id, 'task_overdue:' || r.id);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

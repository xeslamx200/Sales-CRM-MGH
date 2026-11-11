-- Kapso Sandbox, Phase 1 (inbound events only): isolation by construction.
--
-- Sandbox traffic can only ever land in a dedicated SANDBOX COMPANY, so no real
-- company can contain a sandbox row and none of its metrics, KPIs or reports can
-- include one. That is stronger and easier to prove than flagging rows inside real
-- companies, where every child join (deals, tasks and activities of a sandbox
-- lead, targets, aggregates) would need auditing.
--   * companies.is_sandbox (immutable) marks the sandbox company;
--   * whatsapp_accounts.provider ('meta' default | 'kapso') and is_sandbox, with the
--     rule is_sandbox = (provider = 'kapso') and account.is_sandbox = company.is_sandbox;
--   * is_sandbox flags on contacts, conversations, messages and leads (derived by
--     triggers; users cannot set them);
--   * sandbox companies are excluded from app.report_scope() (the scope of five of the
--     six report functions) and from report_whatsapp_workload;
--   * service-only wrappers for the Kapso adapter validate provider, sandbox flag and
--     account ownership in the database, then reuse the existing intake functions
--     UNCHANGED (ingest_whatsapp_message / ingest_whatsapp_echo / apply_whatsapp_status);
--   * employees cannot send from sandbox conversations in Phase 1 (no outbound via Kapso).
-- Additive and reversible: supabase/rollbacks/20261021000960_kapso_sandbox.rollback.sql.
-- Existing objects touched (CREATE OR REPLACE, same signatures and grants): app.report_scope,
-- public.report_whatsapp_workload, public.process_webhook_retries (an additive Kapso branch).

-- ------------------------------------------------------------------ columns
alter table public.companies add column is_sandbox boolean not null default false;
alter table public.whatsapp_accounts
  add column provider text not null default 'meta' check (provider in ('meta', 'kapso')),
  add column is_sandbox boolean not null default false,
  add constraint whatsapp_accounts_sandbox_chk check (is_sandbox = (provider = 'kapso'));
alter table public.contacts add column is_sandbox boolean not null default false;
alter table public.conversations add column is_sandbox boolean not null default false;
alter table public.messages add column is_sandbox boolean not null default false;
alter table public.leads add column is_sandbox boolean not null default false;

-- ------------------------------------------------------------------ helpers
create or replace function app.company_is_sandbox(p_company_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select c.is_sandbox from public.companies c where c.id = p_company_id), false)
$$;

create or replace function app.conversation_is_sandbox(p_conversation_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select c.is_sandbox from public.conversations c where c.id = p_conversation_id), false)
$$;
revoke all on function app.company_is_sandbox(uuid), app.conversation_is_sandbox(uuid) from public, anon;
grant execute on function app.company_is_sandbox(uuid), app.conversation_is_sandbox(uuid) to authenticated, service_role;

-- --------------------------------------------------------------------- guards
-- A company's sandbox flag is fixed at creation: it can never be flipped while data exists.
create or replace function app.guard_company_sandbox() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.is_sandbox is distinct from old.is_sandbox then
    raise exception 'company.sandbox_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger companies_sandbox_guard before update of is_sandbox on public.companies
  for each row execute function app.guard_company_sandbox();

-- A sandbox account lives in a sandbox company and only there; a real account never does.
create or replace function app.guard_account_sandbox() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_sandbox is distinct from app.company_is_sandbox(new.default_company_id) then
    raise exception 'whatsapp.sandbox_company_mismatch' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.provider is distinct from old.provider or new.is_sandbox is distinct from old.is_sandbox)
     and exists (select 1 from public.conversations c where c.whatsapp_account_id = new.id) then
    raise exception 'whatsapp.provider_immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger whatsapp_accounts_sandbox_guard before insert or update on public.whatsapp_accounts
  for each row execute function app.guard_account_sandbox();

-- Row flags are derived, never taken from input.
create or replace function app.set_company_sandbox_flag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.is_sandbox := app.company_is_sandbox(new.company_id);
  return new;
end $$;
create or replace function app.set_message_sandbox_flag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.is_sandbox := app.conversation_is_sandbox(new.conversation_id);
  return new;
end $$;
create trigger conversations_sandbox_flag before insert or update of company_id, is_sandbox on public.conversations
  for each row execute function app.set_company_sandbox_flag();
create trigger leads_sandbox_flag before insert or update of company_id, is_sandbox on public.leads
  for each row execute function app.set_company_sandbox_flag();
create trigger messages_sandbox_flag before insert or update of conversation_id, is_sandbox on public.messages
  for each row execute function app.set_message_sandbox_flag();

-- Contacts are global: a user can never set the flag; only the sandbox intake (system op) can,
-- and only for contacts it just created.
create or replace function app.guard_contact_sandbox() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not (app.is_service_context() or app.in_system_op()) then
    new.is_sandbox := case tg_op when 'INSERT' then false else old.is_sandbox end;
  end if;
  return new;
end $$;
create trigger contacts_sandbox_guard before insert or update of is_sandbox on public.contacts
  for each row execute function app.guard_contact_sandbox();

-- Contacts are shared by phone number, so the same person can later write to a real company's number.
-- A contact is flagged only while every company it belongs to is a sandbox: the first link to a real
-- company (intake, manual link or contact merge) clears the flag. The flag is a display hint; metrics
-- never read it (they exclude sandbox companies by company_id).
create or replace function app.unflag_contact_on_real_link() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('app.system_op', true), '');
begin
  if not app.company_is_sandbox(new.company_id) then
    perform set_config('app.system_op', 'on', true);
    update public.contacts set is_sandbox = false where id = new.contact_id and is_sandbox;
    perform set_config('app.system_op', v_prev, true);
  end if;
  return new;
end $$;
create trigger contact_companies_unflag_sandbox after insert or update of company_id, contact_id on public.contact_companies
  for each row execute function app.unflag_contact_on_real_link();

-- A conversation can never cross the sandbox boundary (sandbox <-> real company).
create or replace function app.guard_conversation_sandbox_move() returns trigger
language plpgsql set search_path = '' as $$
begin
  if app.company_is_sandbox(new.company_id) is distinct from app.company_is_sandbox(old.company_id) then
    raise exception 'conversation.sandbox_boundary' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger conversations_sandbox_move_guard before update of company_id on public.conversations
  for each row execute function app.guard_conversation_sandbox_move();

-- Phase 1: no outbound through Kapso. An employee message in a sandbox conversation is refused here
-- (the intake's echoes have no sender and are allowed).
create or replace function app.block_sandbox_employee_send() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.direction = 'outbound' and new.sent_by is not null and app.conversation_is_sandbox(new.conversation_id) then
    raise exception 'whatsapp.sandbox_send_disabled' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger messages_sandbox_send_guard before insert on public.messages
  for each row execute function app.block_sandbox_employee_send();

-- ------------------------------------------------------------- Kapso wrappers
-- The account of a verified Kapso sandbox phone_number_id; refuses everything else (Meta accounts,
-- disabled/pending accounts, accounts outside a sandbox company).
create or replace function app.kapso_account(p_phone_number_id text) returns public.whatsapp_accounts
language plpgsql stable security definer set search_path = '' as $$
declare v public.whatsapp_accounts;
begin
  select * into v from public.whatsapp_accounts a
  where a.phone_number_id = p_phone_number_id and a.provider = 'kapso' and a.is_sandbox and a.status in ('test', 'active');
  if not found then
    raise exception 'kapso.unknown_account' using errcode = 'P0002';
  end if;
  if not app.company_is_sandbox(v.default_company_id) then
    raise exception 'kapso.account_not_sandbox' using errcode = '42501';
  end if;
  return v;
end $$;

-- Marks a contact the sandbox intake just created, but only while every company it is linked to is a sandbox.
create or replace function app.mark_new_sandbox_contact(p_phone text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('app.system_op', true), '');
begin
  perform app.begin_system_op();
  update public.contacts k set is_sandbox = true
  where k.phone_e164 = p_phone and k.merged_into_id is null and not k.is_sandbox
    and not exists (select 1 from public.contact_companies cc where cc.contact_id = k.id and not app.company_is_sandbox(cc.company_id));
  perform set_config('app.system_op', v_prev, true);
end $$;

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

-- Status of an outbound message. Kapso reports messages the CRM did not create (sent from Kapso itself):
-- when the message is unknown and the payload tells us the customer, it is recorded as an echo (no
-- employee credited) and the status applied. Returns false when it cannot be applied yet (retried).
create or replace function public.apply_kapso_status(
  p_phone_number_id text, p_wa_message_id text, p_status text, p_error_code text default null,
  p_error_message text default null, p_to_wa_id text default null, p_message_type text default null, p_body text default null,
  p_media jsonb default null, p_sent_at timestamptz default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.whatsapp_accounts;
  v_owner uuid;
  v_known boolean := false;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  v_acc := app.kapso_account(p_phone_number_id);
  select c.whatsapp_account_id, true into v_owner, v_known
  from public.messages m join public.conversations c on c.id = m.conversation_id
  where m.wa_message_id = p_wa_message_id;
  if v_known then
    if v_owner is distinct from v_acc.id then
      raise exception 'kapso.message_account_mismatch' using errcode = '42501';
    end if;
    return public.apply_whatsapp_status(p_wa_message_id, p_status, p_error_code, p_error_message);
  end if;
  if p_to_wa_id is null or p_to_wa_id !~ '^[1-9][0-9]{6,14}$' then
    return false;
  end if;
  perform public.ingest_kapso_echo(p_phone_number_id, p_wa_message_id, p_to_wa_id, p_message_type, p_body, p_media, p_sent_at);
  return public.apply_whatsapp_status(p_wa_message_id, p_status, p_error_code, p_error_message);
end $$;

revoke all on function app.kapso_account(text), app.mark_new_sandbox_contact(text) from public, anon, authenticated;
revoke all on function
  public.ingest_kapso_message(text, text, text, text, text, text, jsonb, timestamptz),
  public.ingest_kapso_echo(text, text, text, text, text, jsonb, timestamptz),
  public.apply_kapso_status(text, text, text, text, text, text, text, text, jsonb, timestamptz)
from public, anon, authenticated;
grant execute on function
  public.ingest_kapso_message(text, text, text, text, text, text, jsonb, timestamptz),
  public.ingest_kapso_echo(text, text, text, text, text, jsonb, timestamptz),
  public.apply_kapso_status(text, text, text, text, text, text, text, text, jsonb, timestamptz)
to service_role;

-- ------------------------------------------- metrics: sandbox companies are out of scope
-- app.report_scope() feeds report_company_kpis, report_daily_series, report_target_progress,
-- report_whatsapp_response and (through app.report_users) report_employee_performance.
CREATE OR REPLACE FUNCTION app.report_scope()
 RETURNS TABLE(company_id uuid, see_all boolean, owners uuid[], include_unowned boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  r record;
  v_role public.app_role;
begin
  if v_uid is null then return; end if;
  for r in select id from app.accessible_company_ids() as t(id) where not app.company_is_sandbox(t.id) loop
    if app.is_super_admin() then
      return query select r.id, true, array[]::uuid[], true;
      continue;
    end if;
    v_role := app.company_role(r.id);
    if v_role = 'company_admin' then
      return query select r.id, true, array[]::uuid[], true;
    elsif v_role = 'sales_manager' then
      return query select r.id, false,
        array_append(coalesce((
          select array_agg(distinct tm.user_id)
          from public.teams t join public.team_memberships tm on tm.team_id = t.id
          where t.company_id = r.id and t.is_active and t.manager_id = v_uid), array[]::uuid[]), v_uid),
        true;
    else
      return query select r.id, false, array[v_uid], false;
    end if;
  end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.report_whatsapp_workload(p_company_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(whatsapp_account_id uuid, display_name text, company_id uuid, open_conversations bigint, unassigned_conversations bigint, unread_conversations bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select a.id, a.display_name, c.company_id,
    count(*) filter (where c.status <> 'resolved'),
    count(*) filter (where c.status <> 'resolved' and c.owner_id is null),
    count(*) filter (where c.unread_count > 0)
  from public.conversations c join public.whatsapp_accounts a on a.id = c.whatsapp_account_id
  where (p_company_ids is null or c.company_id = any (p_company_ids))
    and not app.company_is_sandbox(c.company_id)
  group by a.id, a.display_name, c.company_id
  order by a.display_name
$function$;

-- ------------------------------------------------------------ retries (additive)
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
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  for e in
    select w.event_key, w.payload from public.whatsapp_webhook_events w
    where w.status = 'failed' and w.attempts < p_max_attempts
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
  return jsonb_build_object('processed', v_processed, 'failed', v_failed, 'ignored', v_ignored);
end $function$;

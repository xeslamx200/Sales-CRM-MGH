-- =============================================================================
-- PROPOSED REVISION 6 (NOT APPLIED, NOT EXECUTED ANYWHERE): rollback of 20261104000970_kapso_production.sql
-- Suggested file name: supabase/rollbacks/20261104000970_kapso_production.rollback.sql
-- Manual, never automatic. Run as ONE transaction (psql -1 / the migration runner): any failure undoes everything.
--
-- Principle (same as 0960's rollback): it REFUSES, with counts, instead of deleting or discarding anything that
-- production or sandbox traffic produced through the new code. It never deletes a row.
-- The three function bodies below (guard_conversation, merge_contacts, process_webhook_retries) are the exact
-- pre-migration definitions from the live schema (pg_get_functiondef, read-only), inserted by _build/build.mjs.
-- guard_account_sandbox is the exact 0960 text.
--
-- Not discarded silently, but dropped by design (telemetry only, regenerated on the next migration):
--   whatsapp_accounts.connection_state / connection_state_at / last_inbound_event_at.
-- =============================================================================

-- Freeze the tables the checks read, so nothing can slip in between check and drop.
lock table public.whatsapp_accounts, public.conversations, public.messages, public.contact_identities,
           public.whatsapp_webhook_events in share row exclusive mode;

do $$
declare
  v_events bigint; v_acc bigint; v_out bigint; v_ident bigint; v_conv_null bigint; v_conv_bsuid bigint;
  v_origin bigint; v_unconf bigint;
begin
  -- 1. webhook events that only the NEW retry branches can process (pending or failed => still needed)
  select count(*) into v_events from public.whatsapp_webhook_events w
  where w.status in ('pending', 'failed')
    and w.payload ->> 'kind' in ('kapso_inbound_v2', 'kapso_status_v2', 'kapso_quarantined');
  -- 2. data that exists only because of the new model (production OR sandbox, nothing is distinguished)
  select count(*) into v_acc    from public.whatsapp_accounts where provider = 'kapso' and environment = 'production';
  select count(*) into v_out    from public.whatsapp_accounts where outbound_enabled;
  select count(*) into v_ident  from public.contact_identities;
  select count(*) into v_conv_null  from public.conversations where customer_wa_id is null;
  select count(*) into v_conv_bsuid from public.conversations where customer_bsuid is not null;
  select count(*) into v_origin from public.messages where provider_origin is not null;
  select count(*) into v_unconf from public.messages where status = 'queued' and error_code = 'send.unconfirmed';
  if v_events + v_acc + v_out + v_ident + v_conv_null + v_conv_bsuid + v_origin + v_unconf > 0 then
    raise exception 'rollback.blocked: pending/failed new-kind webhook events=%, kapso production accounts=%, outbound-enabled accounts=%, bsuid identities=%, conversations without phone=%, conversations with bsuid=%, messages with provider_origin=%, unconfirmed outbound=%. Nothing was changed. Resolve this data deliberately (let retries finish, export, disable) and run again.',
      v_events, v_acc, v_out, v_ident, v_conv_null, v_conv_bsuid, v_origin, v_unconf;
  end if;
end $$;

-- ---- restore pre-migration function bodies FIRST (they must not reference objects dropped below)
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

CREATE OR REPLACE FUNCTION app.guard_conversation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
      and app.user_has_wa_access(new.whatsapp_account_id, new.owner_id)
    ) then
      raise exception 'conversation.owner_needs_number_access' using errcode = '23514';
    end if;
    if not (
      app.is_company_manager(new.company_id)
      or (old.owner_id is null and new.owner_id = auth.uid() and exists (
        select 1 from public.whatsapp_account_access a
        where a.whatsapp_account_id = new.whatsapp_account_id and a.user_id = auth.uid() and a.can_reply))
      or (old.owner_id = auth.uid() and new.owner_id is null)
    ) then
      raise exception 'conversation.assign_forbidden' using errcode = '42501';
    end if;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.merge_contacts(p_keep_id uuid, p_merge_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_keep public.contacts;
  v_merge public.contacts;
  v_companies uuid[];
begin
  if auth.uid() is null or not app.is_active_user() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_keep_id = p_merge_id then
    raise exception 'contact.merge_same' using errcode = '23514';
  end if;
  select * into v_keep from public.contacts where id = p_keep_id for update;
  select * into v_merge from public.contacts where id = p_merge_id for update;
  if v_keep.id is null or v_merge.id is null or v_keep.merged_into_id is not null or v_merge.merged_into_id is not null
     or not app.can_see_contact(p_keep_id) or not app.can_see_contact(p_merge_id) then
    raise exception 'contact.not_found' using errcode = 'P0002';
  end if;

  -- Every company whose data references either contact.
  select array_agg(distinct x.company_id) into v_companies from (
    select company_id from public.contact_companies where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.leads where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.deals where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.tasks where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.activities where contact_id in (p_keep_id, p_merge_id)
    union select company_id from public.conversations where contact_id in (p_keep_id, p_merge_id)
  ) x;

  if not app.is_super_admin() then
    if v_companies is null then
      -- No company footprint: only the person who created both may merge.
      if v_keep.created_by is distinct from auth.uid() or v_merge.created_by is distinct from auth.uid() then
        raise exception 'contact.merge_forbidden' using errcode = '42501';
      end if;
    elsif exists (select 1 from unnest(v_companies) c(id) where not app.is_company_admin(c.id)) then
      raise exception 'contact.merge_forbidden' using errcode = '42501';
    end if;
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
end $function$;

-- ---- drop new objects, dependants first
drop trigger if exists messages_kapso_send_guard on public.messages;
drop trigger if exists conversations_a_account_lock on public.conversations;
drop function if exists app.lock_account_for_conversation();
drop function if exists app.block_kapso_unready_send();
drop function if exists public.ingest_kapso_inbound(text, text, text, text, text, text, text, text, jsonb, timestamptz);
drop function if exists public.apply_kapso_status_v2(text, text, text, text, text, text, text, text, text, text, jsonb, timestamptz, boolean);
drop function if exists public.record_outbound_unconfirmed(uuid);
drop function if exists public.expire_unconfirmed_outbound(integer);
drop function if exists public.touch_kapso_account(text);
drop function if exists app.kapso_resolve_conversation(public.whatsapp_accounts, text, text, text);
drop function if exists app.kapso_resolve_account(text);
-- the helper is referenced by the NEW guard_conversation body only; that body was already replaced by the original above
drop function if exists app.is_kapso_production_account(uuid);

drop index if exists public.conversations_account_bsuid_uidx;
alter table public.conversations drop constraint conversations_customer_identity_chk;
alter table public.conversations drop column customer_bsuid;
alter table public.conversations alter column customer_wa_id set not null;   -- safe: the check above proved there is no NULL
drop table public.contact_identities;                                        -- safe: the check above proved it is empty
alter table public.messages drop column provider_origin;

drop trigger if exists whatsapp_accounts_a_derive_env on public.whatsapp_accounts;
drop function if exists app.derive_account_environment();

-- exact 0960 body of the account guard
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

alter table public.whatsapp_accounts
  drop constraint wa_accounts_pnid_shape_chk, drop constraint wa_accounts_prod_not_simulated_chk,
  drop constraint wa_accounts_outbound_chk, drop constraint wa_accounts_mode_env_chk,
  drop constraint wa_accounts_provider_env_chk, drop constraint wa_accounts_is_sandbox_env_chk,
  drop constraint wa_accounts_state_chk, drop constraint wa_accounts_mode_chk, drop constraint wa_accounts_environment_chk;
-- every remaining account is a sandbox Kapso or a Meta row (checked above: no production Kapso account), so 0960's rule holds
alter table public.whatsapp_accounts add constraint whatsapp_accounts_sandbox_chk check (is_sandbox = (provider = 'kapso'));
alter table public.whatsapp_accounts
  drop column last_inbound_event_at, drop column connection_state_at, drop column connection_state,
  drop column outbound_enabled, drop column connection_mode, drop column environment;

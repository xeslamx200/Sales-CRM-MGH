-- =============================================================================
-- 0860 — A read-only number grant no longer allows claiming conversations.
--
-- Users with can_reply = false could claim an unassigned conversation. A
-- claimed conversation leaves the shared queue (other agents stop seeing it),
-- so a user who cannot answer could hide conversations from those who can.
-- Self-claim now requires can_reply. Managers may still assign deliberately
-- (e.g. to a read-only reviewer). Body otherwise identical to the live 0720
-- version; guard_conversation is SECURITY INVOKER, and the grant row checked
-- is the caller's own (visible to them under RLS).
-- =============================================================================
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

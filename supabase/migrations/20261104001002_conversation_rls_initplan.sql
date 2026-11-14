-- 20261104001002 - Conversations, messages and contacts for sales managers and agents: the security rules evaluated a function for EVERY row.
--
-- Measured on Staging (3,916 conversations, read-only, each person's own permissions): the conversation list took 0.7 s for the super admin,
-- 1.8 s for a company admin, but 7 s for a sales manager or agent (the database cuts statements at 8 s: the "retry" page), the contacts list
-- 4.9 s and conversation_leads 1.2-2.6 s. Cause: app.can_see_conversation_row (plpgsql, several queries) ran once per row. Migration 820 fixed
-- leads, deals, tasks, contacts and activities the same way; conversations were left on the per-row function.
--
-- Same rules, evaluated once per statement:
--   * super admin / company admin of the company : every conversation of it
--   * otherwise a member with a grant on the number : sales manager sees all of them, others their own plus unassigned ones
--   * messages follow their conversation (messages_select asks the conversations policy with a primary-key lookup instead of a function call)
--   * app.visible_contact_ids (contacts reachable through a conversation) uses the same rule
-- app.can_see_conversation_row / app.can_access_conversation are NOT changed (RPCs and guards keep using them for single rows).
-- Equivalence, row for row for every fixture user: supabase/tests/db/40_conversation_rls_equivalence.sql.
-- Rollback: supabase/rollbacks/20261104001002_conversation_rls_initplan.rollback.sql

create or replace function app.granted_account_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select a.whatsapp_account_id from public.whatsapp_account_access a
  where a.user_id = auth.uid() and app.is_active_user()
$$;
revoke all on function app.granted_account_ids() from public, anon;
grant execute on function app.granted_account_ids() to authenticated, service_role;

drop policy conversations_select on public.conversations;
drop policy conversations_update on public.conversations;
create policy conversations_select on public.conversations for select to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.accessible_company_ids())
      and whatsapp_account_id in (select app.granted_account_ids())
      and (company_id in (select app.sales_manager_company_ids()) or owner_id is null or owner_id = (select auth.uid())))
);
create policy conversations_update on public.conversations for update to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.accessible_company_ids())
      and whatsapp_account_id in (select app.granted_account_ids())
      and (company_id in (select app.sales_manager_company_ids()) or owner_id is null or owner_id = (select auth.uid())))
) with check (app.has_company_access(company_id));

drop policy messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using (
  exists (select 1 from public.conversations c where c.id = messages.conversation_id)
);

create or replace function app.visible_contact_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.contacts c
  where c.created_by = auth.uid() and app.is_active_user()
  union
  select cc.contact_id from public.contact_companies cc
  where cc.company_id in (select app.admin_company_ids())
     or cc.company_id in (select app.sales_manager_company_ids())
     or (cc.owner_id = auth.uid() and cc.company_id in (select app.accessible_company_ids()))
  union
  select l.contact_id from public.leads l
  where l.company_id in (select app.admin_company_ids())
  union
  select l.contact_id from public.leads l
  where l.company_id in (select app.accessible_company_ids())
    and (l.owner_id = auth.uid()
         or (l.owner_id is null and l.created_by = auth.uid())
         or (l.company_id in (select app.sales_manager_company_ids())
             and (l.owner_id is null
                  or (l.company_id, l.owner_id) in (select p.company_id, p.user_id from app.managed_user_pairs() p)
                  or l.team_id in (select app.managed_team_ids()))))
  union
  select d.contact_id from public.deals d
  where d.company_id in (select app.admin_company_ids())
  union
  select d.contact_id from public.deals d
  where d.company_id in (select app.accessible_company_ids())
    and (d.owner_id = auth.uid()
         or (d.owner_id is null and d.created_by = auth.uid())
         or (d.company_id in (select app.sales_manager_company_ids())
             and (d.owner_id is null
                  or (d.company_id, d.owner_id) in (select p.company_id, p.user_id from app.managed_user_pairs() p))))
  union
  select cv.contact_id from public.conversations cv
  where cv.company_id in (select app.accessible_company_ids())
    and (cv.company_id in (select app.admin_company_ids())
         or (cv.whatsapp_account_id in (select app.granted_account_ids())
             and (cv.company_id in (select app.sales_manager_company_ids()) or cv.owner_id is null or cv.owner_id = auth.uid())))
$$;

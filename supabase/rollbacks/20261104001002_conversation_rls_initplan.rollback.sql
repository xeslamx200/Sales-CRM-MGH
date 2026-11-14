-- ROLLBACK of 20261104001002: the per-row function policies of migration 300 and the 820 body of app.visible_contact_ids. Run with psql -1.
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
    and app.can_see_conversation_row(cv.company_id, cv.whatsapp_account_id, cv.owner_id)
$$;

drop policy messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using (app.can_access_conversation(conversation_id));
drop policy conversations_select on public.conversations;
drop policy conversations_update on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (app.can_see_conversation_row(company_id, whatsapp_account_id, owner_id));
create policy conversations_update on public.conversations for update to authenticated
  using (app.can_see_conversation_row(company_id, whatsapp_account_id, owner_id))
  with check (app.has_company_access(company_id));
drop function app.granted_account_ids();

-- =============================================================================
-- 0820 — RLS performance at volume (same rules, cheaper evaluation).
--
-- Measured with ~50k leads (supabase/tests/perf/volume.sql): the original
-- policies call per-row SECURITY DEFINER predicates (can_see_owned_record,
-- can_see_task, can_see_activity, can_see_contact) that run several queries
-- each (~0.5 ms/row). Because RLS quals run before non-leakproof user quals
-- (e.g. ILIKE), searches and counts paid that cost on every row: global
-- search 30–50 s, contacts list 27 s, manager lead count 8 s.
--
-- The policies below express exactly the same rules with the caller's scope
-- computed ONCE per statement: every `(select app.…())` is uncorrelated, so
-- PostgreSQL evaluates it as an initPlan / hashed subplan and the per-row
-- work becomes hash lookups.
--
-- Equivalence with the original predicates is tested row-for-row for every
-- fixture user in supabase/tests/db/09_rls_equivalence.sql. The original
-- predicate functions are unchanged (guards and RPCs still use them for
-- single-row checks).
-- =============================================================================

-- ------------------------------------------------- statement-level scope sets
-- Companies where the caller has full access: every company for a super
-- admin; companies where they are an active company admin.
create or replace function app.admin_company_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.companies c where app.is_super_admin()
  union
  select m.company_id
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id and p.is_active
  join public.companies c on c.id = m.company_id and c.is_active
  where m.user_id = auth.uid() and m.is_active and m.role = 'company_admin'
$$;

-- Companies where the caller is an active sales manager.
create or replace function app.sales_manager_company_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.company_id
  from public.company_memberships m
  join public.profiles p on p.id = m.user_id and p.is_active
  join public.companies c on c.id = m.company_id and c.is_active
  where m.user_id = auth.uid() and m.is_active and m.role = 'sales_manager'
$$;

-- (company, user) pairs a sales manager manages: active agents in active
-- teams they manage (same rule as app.manages_user after 0720).
create or replace function app.managed_user_pairs() returns table (company_id uuid, user_id uuid)
language sql stable security definer set search_path = '' as $$
  select t.company_id, tm.user_id
  from public.teams t
  join public.team_memberships tm on tm.team_id = t.id
  join public.company_memberships m on m.company_id = t.company_id and m.user_id = tm.user_id
  where t.is_active and t.manager_id = auth.uid()
    and m.is_active and m.role in ('sales_agent', 'cs_agent')
    and t.company_id in (select app.sales_manager_company_ids())
$$;

-- Active teams a sales manager manages (same rule as app.manages_team).
create or replace function app.managed_team_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.teams t
  where t.is_active and t.manager_id = auth.uid()
    and t.company_id in (select app.sales_manager_company_ids())
$$;

-- Contacts visible to the caller (same rule as app.can_see_contact), as one
-- set. A super admin is handled in the policy itself, so the set stays small.
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

revoke all on function app.admin_company_ids(), app.sales_manager_company_ids(), app.managed_user_pairs(),
  app.managed_team_ids(), app.visible_contact_ids() from public, anon;
grant execute on function app.admin_company_ids(), app.sales_manager_company_ids(), app.managed_user_pairs(),
  app.managed_team_ids(), app.visible_contact_ids() to authenticated, service_role;

-- ---------------------------------------------------------------- leads
drop policy leads_select on public.leads;
drop policy leads_update on public.leads;
create policy leads_select on public.leads for select to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.accessible_company_ids())
      and (owner_id = (select auth.uid()) or (owner_id is null and created_by = (select auth.uid()))))
  or (company_id in (select app.sales_manager_company_ids())
      and (owner_id is null
           or (company_id, owner_id) in (select p.company_id, p.user_id from app.managed_user_pairs() p)
           or team_id in (select app.managed_team_ids())))
);
create policy leads_update on public.leads for update to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.accessible_company_ids())
      and (owner_id = (select auth.uid()) or (owner_id is null and created_by = (select auth.uid()))))
  or (company_id in (select app.sales_manager_company_ids())
      and (owner_id is null
           or (company_id, owner_id) in (select p.company_id, p.user_id from app.managed_user_pairs() p)
           or team_id in (select app.managed_team_ids())))
) with check (app.has_company_access(company_id));

-- ---------------------------------------------------------------- deals
drop policy deals_select on public.deals;
drop policy deals_update on public.deals;
create policy deals_select on public.deals for select to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.accessible_company_ids())
      and (owner_id = (select auth.uid()) or (owner_id is null and created_by = (select auth.uid()))))
  or (company_id in (select app.sales_manager_company_ids())
      and (owner_id is null
           or (company_id, owner_id) in (select p.company_id, p.user_id from app.managed_user_pairs() p)))
);
create policy deals_update on public.deals for update to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.accessible_company_ids())
      and (owner_id = (select auth.uid()) or (owner_id is null and created_by = (select auth.uid()))))
  or (company_id in (select app.sales_manager_company_ids())
      and (owner_id is null
           or (company_id, owner_id) in (select p.company_id, p.user_id from app.managed_user_pairs() p)))
) with check (app.has_company_access(company_id));

-- ---------------------------------------------------------------- tasks
drop policy tasks_select on public.tasks;
drop policy tasks_update on public.tasks;
create policy tasks_select on public.tasks for select to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.accessible_company_ids())
      and (assigned_to = (select auth.uid()) or created_by = (select auth.uid())))
  or (company_id in (select app.sales_manager_company_ids())
      and (assigned_to is null
           or (company_id, assigned_to) in (select p.company_id, p.user_id from app.managed_user_pairs() p)))
);
create policy tasks_update on public.tasks for update to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.accessible_company_ids())
      and (assigned_to = (select auth.uid()) or created_by = (select auth.uid())))
  or (company_id in (select app.sales_manager_company_ids())
      and (assigned_to is null
           or (company_id, assigned_to) in (select p.company_id, p.user_id from app.managed_user_pairs() p)))
) with check (app.has_company_access(company_id));

-- ----------------------------------------------------------- activities
drop policy activities_select on public.activities;
create policy activities_select on public.activities for select to authenticated using (
  company_id in (select app.admin_company_ids())
  or (company_id in (select app.sales_manager_company_ids())
      and (company_id, actor_id) in (select p.company_id, p.user_id from app.managed_user_pairs() p))
  or (company_id in (select app.accessible_company_ids())
      and (actor_id = (select auth.uid())
           or (lead_id is not null and app.can_access_lead(lead_id))
           or (deal_id is not null and app.can_access_deal(deal_id))))
);

-- ------------------------------------------------------------- contacts
drop policy contacts_select on public.contacts;
drop policy contacts_update on public.contacts;
create policy contacts_select on public.contacts for select to authenticated using (
  (select app.is_super_admin()) or id in (select app.visible_contact_ids())
);
create policy contacts_update on public.contacts for update to authenticated
  using ((select app.is_super_admin()) or id in (select app.visible_contact_ids()))
  with check ((select app.is_super_admin()) or id in (select app.visible_contact_ids()));

drop policy contact_companies_select on public.contact_companies;
create policy contact_companies_select on public.contact_companies for select to authenticated using (
  company_id in (select app.accessible_company_ids())
  and (company_id in (select app.admin_company_ids())
       or company_id in (select app.sales_manager_company_ids())
       or contact_id in (select app.visible_contact_ids()))
);

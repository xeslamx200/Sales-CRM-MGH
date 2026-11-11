-- =============================================================================
-- 0300 — Row Level Security.
--
-- Every table in `public` has RLS enabled. `anon` gets no table privileges at
-- all. Policies only grant; anything not granted here is denied. Column-level
-- guards (who may change owner, status, roles, ...) are enforced by triggers
-- in 0400 because RLS cannot compare old and new values.
-- =============================================================================

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- RLS is enabled but not FORCED: the table owner (`postgres`) is used only by
-- SECURITY DEFINER helper functions, which must read membership tables
-- without recursing through these policies.

-- -----------------------------------------------------------------------------
-- companies
-- -----------------------------------------------------------------------------
create policy companies_select on public.companies for select to authenticated
  using (app.has_company_access(id));
create policy companies_insert on public.companies for insert to authenticated
  with check (app.is_super_admin());
create policy companies_update on public.companies for update to authenticated
  using (app.is_company_admin(id)) with check (app.is_company_admin(id));
create policy companies_delete on public.companies for delete to authenticated
  using (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or app.is_super_admin() or app.shares_company_with(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or app.is_super_admin())
  with check (id = auth.uid() or app.is_super_admin());

-- -----------------------------------------------------------------------------
-- memberships and teams
-- -----------------------------------------------------------------------------
create policy memberships_select on public.company_memberships for select to authenticated
  using (user_id = auth.uid() or app.has_company_access(company_id));
create policy memberships_insert on public.company_memberships for insert to authenticated
  with check (app.is_company_admin(company_id));
create policy memberships_update on public.company_memberships for update to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));
create policy memberships_delete on public.company_memberships for delete to authenticated
  using (app.is_company_admin(company_id));

create policy teams_select on public.teams for select to authenticated
  using (app.has_company_access(company_id));
create policy teams_write on public.teams for all to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));

create policy team_memberships_select on public.team_memberships for select to authenticated
  using (app.has_company_access(company_id));
create policy team_memberships_insert on public.team_memberships for insert to authenticated
  with check (app.manages_team(company_id, team_id));
create policy team_memberships_delete on public.team_memberships for delete to authenticated
  using (app.manages_team(company_id, team_id));

-- -----------------------------------------------------------------------------
-- contacts
-- -----------------------------------------------------------------------------
create policy contacts_select on public.contacts for select to authenticated
  using (app.can_see_contact(id));
create policy contacts_insert on public.contacts for insert to authenticated
  with check (created_by = auth.uid() and app.is_active_user());
create policy contacts_update on public.contacts for update to authenticated
  using (app.can_see_contact(id)) with check (app.can_see_contact(id));
create policy contacts_delete on public.contacts for delete to authenticated
  using (app.is_super_admin());

create policy contact_companies_select on public.contact_companies for select to authenticated
  using (app.has_company_access(company_id)
         and (app.is_company_manager(company_id) or app.can_see_contact(contact_id)));
create policy contact_companies_insert on public.contact_companies for insert to authenticated
  with check (app.has_company_access(company_id) and app.can_see_contact(contact_id));
create policy contact_companies_update on public.contact_companies for update to authenticated
  using (app.is_company_manager(company_id) or (owner_id = auth.uid() and app.has_company_access(company_id)))
  with check (app.has_company_access(company_id));
create policy contact_companies_delete on public.contact_companies for delete to authenticated
  using (app.is_company_admin(company_id));

create policy duplicate_reviews_select on public.contact_duplicate_reviews for select to authenticated
  using (app.can_see_contact(contact_a_id) and app.can_see_contact(contact_b_id));
-- Reviews are resolved only through public.merge_contacts / dismiss RPCs.

-- -----------------------------------------------------------------------------
-- pipelines
-- -----------------------------------------------------------------------------
create policy pipelines_select on public.pipelines for select to authenticated
  using (app.has_company_access(company_id));
create policy pipelines_write on public.pipelines for all to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));

create policy stages_select on public.pipeline_stages for select to authenticated
  using (app.has_company_access(company_id));
create policy stages_write on public.pipeline_stages for all to authenticated
  using (app.is_company_admin(company_id)) with check (app.is_company_admin(company_id));

-- -----------------------------------------------------------------------------
-- leads (+ history: read-only, written by triggers)
-- -----------------------------------------------------------------------------
create policy leads_select on public.leads for select to authenticated
  using (app.can_see_owned_record(company_id, owner_id, team_id, created_by));
create policy leads_insert on public.leads for insert to authenticated
  with check (app.has_company_access(company_id) and created_by = auth.uid());
create policy leads_update on public.leads for update to authenticated
  using (app.can_see_owned_record(company_id, owner_id, team_id, created_by))
  with check (app.has_company_access(company_id));
create policy leads_delete on public.leads for delete to authenticated
  using (app.is_super_admin());

create policy lead_assignments_select on public.lead_assignments for select to authenticated
  using (app.can_access_lead(lead_id));
create policy lead_status_history_select on public.lead_status_history for select to authenticated
  using (app.can_access_lead(lead_id));

-- -----------------------------------------------------------------------------
-- deals
-- -----------------------------------------------------------------------------
create policy deals_select on public.deals for select to authenticated
  using (app.can_see_owned_record(company_id, owner_id, null, created_by));
create policy deals_insert on public.deals for insert to authenticated
  with check (app.has_company_access(company_id) and created_by = auth.uid());
create policy deals_update on public.deals for update to authenticated
  using (app.can_see_owned_record(company_id, owner_id, null, created_by))
  with check (app.has_company_access(company_id));
create policy deals_delete on public.deals for delete to authenticated
  using (app.is_super_admin());

create policy deal_stage_history_select on public.deal_stage_history for select to authenticated
  using (app.can_access_deal(deal_id));

-- -----------------------------------------------------------------------------
-- tasks and activities
-- -----------------------------------------------------------------------------
create policy tasks_select on public.tasks for select to authenticated
  using (app.can_see_task(company_id, assigned_to, created_by));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (app.has_company_access(company_id) and created_by = auth.uid());
create policy tasks_update on public.tasks for update to authenticated
  using (app.can_see_task(company_id, assigned_to, created_by))
  with check (app.has_company_access(company_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (app.is_company_admin(company_id));

create policy activities_select on public.activities for select to authenticated
  using (app.can_see_activity(company_id, actor_id, lead_id, deal_id));
create policy activities_insert on public.activities for insert to authenticated
  with check (app.has_company_access(company_id) and actor_id = auth.uid());
create policy activities_update on public.activities for update to authenticated
  using (actor_id = auth.uid()) with check (actor_id = auth.uid());
create policy activities_delete on public.activities for delete to authenticated
  using (app.is_super_admin());

-- -----------------------------------------------------------------------------
-- sales targets
-- -----------------------------------------------------------------------------
create policy targets_select on public.sales_targets for select to authenticated
  using (
    app.is_company_manager(company_id)
    or (app.has_company_access(company_id) and (
      user_id = auth.uid()
      or (user_id is null and team_id is null)
      or exists (select 1 from public.team_memberships tm
                 where tm.team_id = sales_targets.team_id and tm.user_id = auth.uid())
    ))
  );
create policy targets_write on public.sales_targets for all to authenticated
  using (
    app.is_company_admin(company_id)
    or app.manages_user(company_id, user_id)
    or app.manages_team(company_id, team_id)
  )
  with check (
    app.is_company_admin(company_id)
    or app.manages_user(company_id, user_id)
    or app.manages_team(company_id, team_id)
  );

-- -----------------------------------------------------------------------------
-- WhatsApp
-- -----------------------------------------------------------------------------
create policy wa_accounts_select on public.whatsapp_accounts for select to authenticated
  using (app.is_company_admin(default_company_id) or app.has_wa_account_access(id));
create policy wa_accounts_write on public.whatsapp_accounts for all to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());

create policy wa_access_select on public.whatsapp_account_access for select to authenticated
  using (user_id = auth.uid() or app.is_super_admin() or exists (
    select 1 from public.whatsapp_accounts a
    where a.id = whatsapp_account_id and app.is_company_admin(a.default_company_id)));
create policy wa_access_write on public.whatsapp_account_access for all to authenticated
  using (app.is_super_admin() or exists (
    select 1 from public.whatsapp_accounts a
    where a.id = whatsapp_account_id and app.is_company_admin(a.default_company_id)))
  with check (app.is_super_admin() or exists (
    select 1 from public.whatsapp_accounts a
    where a.id = whatsapp_account_id and app.is_company_admin(a.default_company_id)));

create policy conversations_select on public.conversations for select to authenticated
  using (app.can_see_conversation_row(company_id, whatsapp_account_id, owner_id));
create policy conversations_update on public.conversations for update to authenticated
  using (app.can_see_conversation_row(company_id, whatsapp_account_id, owner_id))
  with check (app.has_company_access(company_id));

create policy conversation_assignments_select on public.conversation_assignments for select to authenticated
  using (app.can_access_conversation(conversation_id));

-- Messages: read-only for users. Outbound messages are created by the server
-- after an authorization check (public.queue_outbound_message); inbound ones
-- by the webhook processor with the service role.
create policy messages_select on public.messages for select to authenticated
  using (app.can_access_conversation(conversation_id));

create policy conversation_notes_select on public.conversation_notes for select to authenticated
  using (app.can_access_conversation(conversation_id));
create policy conversation_notes_insert on public.conversation_notes for insert to authenticated
  with check (author_id = auth.uid() and app.can_access_conversation(conversation_id));

-- whatsapp_webhook_events: no policies => service role only.

-- -----------------------------------------------------------------------------
-- notifications, audit, attachments, auth events
-- -----------------------------------------------------------------------------
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy audit_select on public.audit_logs for select to authenticated
  using (app.is_super_admin() or (company_id is not null and app.is_company_admin(company_id)));
-- No insert/update/delete policies: written only by SECURITY DEFINER functions,
-- and an immutability trigger (0400) blocks UPDATE/DELETE for every role.

create policy attachments_select on public.attachments for select to authenticated
  using (app.has_company_access(company_id) and app.can_access_entity(entity_type, entity_id));
create policy attachments_insert on public.attachments for insert to authenticated
  with check (uploaded_by = auth.uid() and app.has_company_access(company_id)
              and app.can_access_entity(entity_type, entity_id));
create policy attachments_delete on public.attachments for delete to authenticated
  using (uploaded_by = auth.uid() or app.is_company_admin(company_id));

create policy auth_events_select on public.auth_events for select to authenticated
  using (app.can_view_user_performance(user_id));
create policy auth_events_insert on public.auth_events for insert to authenticated
  with check (user_id = auth.uid());

-- =============================================================================
-- 0840 — Fixes from the pre-launch security review (Session 3).
--
-- 1. merge_contacts: authorization was vacuous for contacts without company
--    links (any signed-in user could merge them and re-point leads, deals and
--    conversations of companies they don't administer), and visibility was
--    never checked. Now: both contacts must be visible, and the caller must
--    administer EVERY company that touches either contact (links, leads,
--    deals, tasks, activities, conversations). Contacts with no company
--    footprint can only be merged by a super admin or their creator.
-- 2. auth_events: users could insert their own sign_in / password_changed
--    rows through the Data API and inflate the "sign-ins" metric. Sign-ins and
--    password changes are now recorded from Supabase Auth itself (triggers on
--    auth.sessions / auth.users); users may only record their own sign_out.
-- 3. report_target_progress: company-wide and team targets returned their
--    actual values to everyone who could see the target, disclosing company /
--    team aggregates beyond the caller's report scope (agents: self only).
--    Actuals are now returned only when the people counted are in scope.
-- 4. purge_old_webhook_events: failed intake rows (which keep the payload for
--    retries) were never purged; they are now removed after the same period.
-- =============================================================================

-- ------------------------------------------------------------------ 1. merge
create or replace function public.merge_contacts(p_keep_id uuid, p_merge_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
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
end $$;

-- ------------------------------------------------------------ 2. auth events
create or replace function app.record_auth_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles where id = new.user_id) then
    insert into public.auth_events (user_id, event) values (new.user_id, 'sign_in');
  end if;
  return null;
end $$;

create or replace function app.record_password_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles where id = new.id) then
    insert into public.auth_events (user_id, event) values (new.id, 'password_changed');
  end if;
  return null;
end $$;

do $$
begin
  -- Supabase Auth creates one auth.sessions row per sign-in (password, OTP,
  -- invite or recovery link); token refreshes update the row instead.
  if to_regclass('auth.sessions') is not null then
    drop trigger if exists crm_record_sign_in on auth.sessions;
    create trigger crm_record_sign_in after insert on auth.sessions
      for each row execute function app.record_auth_session();
  end if;
end $$;

drop trigger if exists crm_record_password_change on auth.users;
create trigger crm_record_password_change after update of encrypted_password on auth.users
  for each row when (old.encrypted_password is distinct from new.encrypted_password and new.encrypted_password is not null)
  execute function app.record_password_change();

drop policy if exists auth_events_insert on public.auth_events;
create policy auth_events_insert on public.auth_events for insert to authenticated
  with check (user_id = auth.uid() and event = 'sign_out');

revoke all on function app.record_auth_session(), app.record_password_change() from public, anon, authenticated;

-- -------------------------------------------------------- 3. target progress
create or replace function public.report_target_progress(p_company_id uuid, p_on date default current_date)
returns table (target_id uuid, metric public.target_metric, user_id uuid, team_id uuid,
               period_start date, period_end date, target_value numeric, actual_value numeric, attainment numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_scope record;
begin
  if auth.uid() is null or not app.has_company_access(p_company_id) then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  select * into v_scope from app.report_scope() s where s.company_id = p_company_id;
  return query
  with tg as (
    select st.*, app.period_start(st.company_id, st.period_start) as t0,
           app.period_start(st.company_id, st.period_end + 1) as t1,
           -- Actuals are shown only when everyone counted is within the
           -- caller's report scope (same rule as the other reports).
           coalesce(v_scope.see_all
            or st.user_id = any (v_scope.owners)
            or (st.team_id is not null and app.manages_team(p_company_id, st.team_id)), false) as in_scope
    from public.sales_targets st
    where st.company_id = p_company_id and p_on between st.period_start and st.period_end
      and (v_scope.see_all
           or st.user_id = any (v_scope.owners)
           or (st.user_id is null and st.team_id is null)
           or (st.team_id is not null and (app.manages_team(p_company_id, st.team_id) or exists (
               select 1 from public.team_memberships tm where tm.team_id = st.team_id and tm.user_id = auth.uid()))))
  ),
  people as (
    select tg.id as tid, x.uid
    from tg cross join lateral (
      select tg.user_id as uid where tg.user_id is not null
      union all select tm.user_id from public.team_memberships tm where tm.team_id = tg.team_id
      union all select m.user_id from public.company_memberships m
                where tg.user_id is null and tg.team_id is null and m.company_id = p_company_id
    ) x
    where tg.in_scope
  ),
  actual as (
    select tg.id as tid,
      case when not tg.in_scope then null else
      case tg.metric
        when 'won_revenue' then (select coalesce(sum(d.amount), 0) from public.deals d
          where d.company_id = p_company_id and d.status = 'won' and d.archived_at is null
            and d.won_at >= tg.t0 and d.won_at < tg.t1 and d.owner_id in (select uid from people where tid = tg.id))
        when 'deals_won' then (select count(*) from public.deals d
          where d.company_id = p_company_id and d.status = 'won' and d.archived_at is null
            and d.won_at >= tg.t0 and d.won_at < tg.t1 and d.owner_id in (select uid from people where tid = tg.id))
        when 'leads_created' then (select count(*) from public.leads l
          where l.company_id = p_company_id and l.created_at >= tg.t0 and l.created_at < tg.t1
            and l.created_by in (select uid from people where tid = tg.id))
        when 'leads_contacted' then (select count(distinct a.lead_id) from public.activities a
          where a.company_id = p_company_id and a.lead_id is not null and a.type in ('call', 'meeting', 'email', 'whatsapp')
            and a.occurred_at >= tg.t0 and a.occurred_at < tg.t1 and a.actor_id in (select uid from people where tid = tg.id))
        when 'calls_logged' then (select count(*) from public.activities a
          where a.company_id = p_company_id and a.type = 'call'
            and a.occurred_at >= tg.t0 and a.occurred_at < tg.t1 and a.actor_id in (select uid from people where tid = tg.id))
        when 'meetings_logged' then (select count(*) from public.activities a
          where a.company_id = p_company_id and a.type = 'meeting'
            and a.occurred_at >= tg.t0 and a.occurred_at < tg.t1 and a.actor_id in (select uid from people where tid = tg.id))
        when 'tasks_completed' then (select count(*) from public.tasks t
          where t.company_id = p_company_id and t.status = 'completed'
            and t.completed_at >= tg.t0 and t.completed_at < tg.t1 and t.completed_by in (select uid from people where tid = tg.id))
      end end::numeric as v
    from tg
  )
  select tg.id, tg.metric, tg.user_id, tg.team_id, tg.period_start, tg.period_end, tg.target_value,
         a.v, case when a.v is null then null else round(a.v / tg.target_value, 4) end
  from tg join actual a on a.tid = tg.id
  order by tg.metric, tg.period_start;
end $$;

-- ------------------------------------------------------- 4. intake retention
create or replace function public.purge_old_webhook_events(p_days int default 30) returns int
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  -- Failed rows keep their payload for retries; past the retention period
  -- they are dead letters and must not keep customer content indefinitely.
  delete from public.whatsapp_webhook_events
  where status in ('processed', 'ignored', 'failed')
    and received_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v = row_count;
  return v;
end $$;

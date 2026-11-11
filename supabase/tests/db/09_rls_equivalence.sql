-- 0820 rewrote the hot RLS policies for performance. This file proves the
-- new policies grant exactly the same rows as the original predicate
-- functions, row for row, for every fixture user, on a matrix of edge cases.
begin;
select tests.logout();   -- table owner: builds data without RLS

do $$
declare
  a uuid := tests.ref('alpha'); b uuid := tests.ref('beta');
  t1 uuid := tests.ref('team_a1'); t2 uuid := tests.ref('team_a2'); t3 uuid;
  owners_a uuid[] := array[null, tests.uid('agent_a1'), tests.uid('agent_a2'), tests.uid('shared'),
                           tests.uid('mgr_a'), tests.uid('admin_a'), tests.uid('inactive')];
  owners_b uuid[] := array[null, tests.uid('agent_b'), tests.uid('cs_b'), tests.uid('shared'), tests.uid('admin_b')];
  creators_a uuid[] := array[tests.uid('agent_a1'), tests.uid('agent_a2'), tests.uid('mgr_a')];
  creators_b uuid[] := array[tests.uid('agent_b'), tests.uid('shared')];
  teams_a uuid[];
  o uuid; cr uuid; tm uuid; ct uuid; l uuid; d uuid;
  stage_a uuid; pipe_a uuid; stage_b uuid; pipe_b uuid;
  i int := 0;
begin
  -- Edge cases: an inactive team managed by mgr_a, and a company admin placed
  -- in mgr_a's team (managers must never "manage" an admin).
  insert into public.teams (company_id, name, manager_id, is_active) values (a, 'Alpha Inactive', tests.uid('mgr_a'), false)
  returning id into t3;
  insert into public.team_memberships (team_id, company_id, user_id) values
    (t3, a, tests.uid('agent_a2')), (t1, a, tests.uid('admin_a'));
  teams_a := array[null, t1, t2, t3];
  -- Records owned by someone who is deactivated LATER (a real situation):
  -- reactivate the fixture user while inserting, deactivate again below.
  update public.profiles set is_active = true where id = tests.uid('inactive');

  select p.id, s.id into pipe_a, stage_a from public.pipelines p join public.pipeline_stages s on s.pipeline_id = p.id
  where p.company_id = a and p.kind = 'deal' and p.is_default and s.stage_type = 'open' order by s.position limit 1;
  select p.id, s.id into pipe_b, stage_b from public.pipelines p join public.pipeline_stages s on s.pipeline_id = p.id
  where p.company_id = b and p.kind = 'deal' and p.is_default and s.stage_type = 'open' order by s.position limit 1;

  foreach o in array owners_a loop
    foreach cr in array creators_a loop
      foreach tm in array teams_a loop
        i := i + 1;
        insert into public.contacts (full_name, phone_e164, created_by)
        values ('EQ A ' || i, '+97466' || lpad(i::text, 6, '0'), case when i % 5 = 0 then cr end) returning id into ct;
        -- Most contacts are linked to the company; some are deliberately not.
        if i % 4 <> 0 then
          insert into public.contact_companies (contact_id, company_id, owner_id)
          values (ct, a, case when i % 3 = 0 then o end);
        end if;
        insert into public.leads (company_id, contact_id, title, owner_id, team_id, created_by)
        values (a, ct, 'EQ lead A ' || i, o, tm, cr) returning id into l;
        if i % 2 = 0 then
          insert into public.deals (company_id, lead_id, contact_id, pipeline_id, stage_id, title, currency, owner_id, created_by)
          values (a, l, ct, pipe_a, stage_a, 'EQ deal A ' || i, 'QAR', o, cr) returning id into d;
        end if;
        insert into public.tasks (company_id, title, lead_id, deal_id, assigned_to, created_by)
        values (a, 'EQ task A ' || i, case when i % 3 = 0 then l end, case when i % 3 = 1 then d end, o, cr);
        insert into public.activities (company_id, type, actor_id, lead_id, deal_id, contact_id)
        values (a, 'call', cr, case when i % 2 = 0 then l end, case when i % 2 = 1 then d end, ct);
      end loop;
    end loop;
  end loop;

  foreach o in array owners_b loop
    foreach cr in array creators_b loop
      i := i + 1;
      insert into public.contacts (full_name, phone_e164) values ('EQ B ' || i, '+97466' || lpad(i::text, 6, '0'))
      returning id into ct;
      insert into public.contact_companies (contact_id, company_id, owner_id) values (ct, b, o);
      insert into public.leads (company_id, contact_id, title, owner_id, created_by)
      values (b, ct, 'EQ lead B ' || i, o, cr) returning id into l;
      insert into public.deals (company_id, lead_id, contact_id, pipeline_id, stage_id, title, currency, owner_id, created_by)
      values (b, l, ct, pipe_b, stage_b, 'EQ deal B ' || i, 'QAR', o, cr);
      insert into public.tasks (company_id, title, assigned_to, created_by) values (b, 'EQ task B ' || i, o, cr);
      insert into public.activities (company_id, type, actor_id, lead_id) values (b, 'note', cr, l);
    end loop;
  end loop;

  update public.profiles set is_active = false where id = tests.uid('inactive');

  -- Contacts reachable only through a WhatsApp conversation.
  insert into public.contacts (full_name, phone_e164) values ('EQ convo only', '+97466999001') returning id into ct;
  insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id)
  values (tests.ref('wa_alpha'), a, ct, '97466999001');
  insert into public.contacts (full_name, phone_e164) values ('EQ convo owned', '+97466999002') returning id into ct;
  insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, owner_id)
  values (tests.ref('wa_beta'), b, ct, '97466999002', tests.uid('cs_b'));
end $$;

-- Reference: the ORIGINAL predicate functions, evaluated over all rows
-- (SECURITY DEFINER bypasses RLS; auth.uid() is still the logged-in user).
create function tests.old_ids(p_table text) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare v uuid[];
begin
  execute case p_table
    when 'leads' then 'select array_agg(id order by id) from public.leads l
                       where app.can_see_owned_record(l.company_id, l.owner_id, l.team_id, l.created_by)'
    when 'deals' then 'select array_agg(id order by id) from public.deals d
                       where app.can_see_owned_record(d.company_id, d.owner_id, null, d.created_by)'
    when 'tasks' then 'select array_agg(id order by id) from public.tasks t
                       where app.can_see_task(t.company_id, t.assigned_to, t.created_by)'
    when 'activities' then 'select array_agg(id order by id) from public.activities x
                       where app.can_see_activity(x.company_id, x.actor_id, x.lead_id, x.deal_id)'
    when 'contacts' then 'select array_agg(id order by id) from public.contacts c where app.can_see_contact(c.id)'
    when 'contact_companies' then 'select array_agg(id order by id) from public.contact_companies cc
                       where app.has_company_access(cc.company_id)
                         and (app.is_company_manager(cc.company_id) or app.can_see_contact(cc.contact_id))'
  end into v;
  return coalesce(v, '{}');
end $$;

-- Actual: what the NEW policies return to the user.
create function tests.new_ids(p_table text) returns uuid[]
language plpgsql stable security invoker set search_path = '' as $$
declare v uuid[];
begin
  execute format('select array_agg(id order by id) from public.%I', p_table) into v;
  return coalesce(v, '{}');
end $$;
grant execute on function tests.old_ids(text), tests.new_ids(text) to authenticated;

do $$
declare
  u text; t text; n int := 0;
  expected uuid[]; actual uuid[];
begin
  foreach u in array array['super', 'admin_a', 'admin_b', 'mgr_a', 'agent_a1', 'agent_a2', 'shared', 'cs_b',
                           'agent_b', 'outsider', 'inactive'] loop
    perform tests.login(u);
    foreach t in array array['leads', 'deals', 'tasks', 'activities', 'contacts', 'contact_companies'] loop
      expected := tests.old_ids(t);
      actual := tests.new_ids(t);
      if expected is distinct from actual then
        raise exception 'FAIL: % / % differs (old % rows, new % rows)', u, t, cardinality(expected), cardinality(actual);
      end if;
      n := n + 1;
    end loop;
  end loop;
  perform tests.logout();
  raise notice 'ok - new policies match the original predicates for 11 users x 6 tables (% comparisons)', n;
end $$;

-- Write paths: rows a user can UPDATE must match the original rules
-- (old USING predicate AND the unchanged WITH CHECK). A no-op update is
-- executed as each user; the affected ids are compared, then rolled back.
create function tests.old_update_ids(p_table text) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare v uuid[];
begin
  execute case p_table
    when 'leads' then 'select array_agg(id order by id) from public.leads l
      where app.can_see_owned_record(l.company_id, l.owner_id, l.team_id, l.created_by) and app.has_company_access(l.company_id)'
    when 'deals' then 'select array_agg(id order by id) from public.deals d
      where app.can_see_owned_record(d.company_id, d.owner_id, null, d.created_by) and app.has_company_access(d.company_id)'
    when 'tasks' then 'select array_agg(id order by id) from public.tasks t
      where app.can_see_task(t.company_id, t.assigned_to, t.created_by) and app.has_company_access(t.company_id)'
    when 'contacts' then 'select array_agg(id order by id) from public.contacts c where app.can_see_contact(c.id)'
  end into v;
  return coalesce(v, '{}');
end $$;
grant execute on function tests.old_update_ids(text) to authenticated;

do $$
declare
  u text; t text; n int := 0;
  expected uuid[]; actual uuid[];
  col text;
begin
  foreach u in array array['super', 'admin_a', 'admin_b', 'mgr_a', 'agent_a1', 'agent_a2', 'shared', 'cs_b',
                           'agent_b', 'outsider', 'inactive'] loop
    perform tests.login(u);
    foreach t in array array['leads', 'deals', 'tasks', 'contacts'] loop
      col := case t when 'tasks' then 'title' when 'contacts' then 'full_name' else 'notes' end;
      expected := tests.old_update_ids(t);
      execute format('with x as (update public.%I set %I = %I returning id) select coalesce(array_agg(id order by id), ''{}'') from x',
                     t, col, col) into actual;
      if expected is distinct from actual then
        raise exception 'FAIL: % can update % differently (old % rows, new % rows)', u, t, cardinality(expected), cardinality(actual);
      end if;
      n := n + 1;
    end loop;
  end loop;
  perform tests.logout();
  raise notice 'ok - UPDATE authorization matches the original rules for 11 users x 4 tables (% comparisons)', n;
end $$;

-- Sanity: the matrix exercises non-trivial visibility (not "all" or "none").
select tests.login('mgr_a');
select tests.ok(cardinality(tests.new_ids('leads')) > 0, 'manager sees a non-empty set of leads');
select tests.ok(not exists (
  select 1 from public.leads where owner_id = tests.uid('admin_a') and team_id is distinct from tests.ref('team_a1')),
  'a company admin in the manager''s team is never "managed": only leads tagged with the managed team are visible');
select tests.ok(not exists (
  select 1 from public.leads l where l.owner_id = tests.uid('agent_a2') and l.team_id is distinct from tests.ref('team_a1')),
  'an inactive team grants nothing');
select tests.login('agent_a1');
select tests.ok(not exists (select 1 from public.leads where company_id = tests.ref('beta')), 'agent sees nothing in another company');

rollback;

-- Migration 1002 rewrote the conversation / message security rules (set-based instead of a function per row).
-- This proves the new rules grant exactly the rows the original predicate functions grant, row for row, for every fixture user,
-- on a matrix of owners x numbers x companies, for conversations (read and update), messages and the contacts reached through a conversation.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with supabase/migrations + _helpers.sql + _fixtures.sql> -f supabase/tests/db/40_conversation_rls_equivalence.sql
begin;
select tests.logout();

do $$
declare
  a uuid := tests.ref('alpha'); b uuid := tests.ref('beta');
  wa_a uuid := tests.ref('wa_alpha'); wa_b uuid := tests.ref('wa_beta');
  owners uuid[] := array[null, tests.uid('agent_a1'), tests.uid('agent_a2'), tests.uid('mgr_a'), tests.uid('admin_a'), tests.uid('cs_b'),
                         tests.uid('shared'), tests.uid('admin_b'), tests.uid('inactive')];
  o uuid; ct uuid; cv uuid; i int := 0; st text;
begin
  -- a number the "shared" user holds in Beta but whose conversations belong to Alpha (company and number do not have to agree)
  foreach o in array owners loop
    foreach st in array array['open', 'resolved'] loop
      -- Alpha conversations on Alpha's number
      i := i + 1;
      insert into public.contacts (full_name, phone_e164) values ('CV A ' || i, '+97477' || lpad(i::text, 6, '0')) returning id into ct;
      insert into public.contact_companies (contact_id, company_id) values (ct, a);
      insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, owner_id, status)
      values (wa_a, a, ct, '97477' || lpad(i::text, 6, '0'), o, st::public.conversation_status) returning id into cv;
      insert into public.messages (conversation_id, direction, message_type, body, status) values (cv, 'inbound', 'text', 'hi ' || i, 'received');
      -- Beta conversations on Beta's number
      i := i + 1;
      insert into public.contacts (full_name, phone_e164) values ('CV B ' || i, '+97477' || lpad(i::text, 6, '0')) returning id into ct;
      insert into public.contact_companies (contact_id, company_id) values (ct, b);
      insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, owner_id, status)
      values (wa_b, b, ct, '97477' || lpad(i::text, 6, '0'), o, st::public.conversation_status) returning id into cv;
      insert into public.messages (conversation_id, direction, message_type, body, status) values (cv, 'inbound', 'text', 'hi ' || i, 'received');
      -- a conversation of Alpha on Beta's number, and of Beta on Alpha's number (grants and company disagree)
      i := i + 1;
      insert into public.contacts (full_name, phone_e164) values ('CV X ' || i, '+97477' || lpad(i::text, 6, '0')) returning id into ct;
      insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, owner_id, status)
      values (wa_b, a, ct, '97477' || lpad(i::text, 6, '0'), o, st::public.conversation_status) returning id into cv;
      insert into public.messages (conversation_id, direction, message_type, body, status) values (cv, 'inbound', 'text', 'hi ' || i, 'received');
      i := i + 1;
      insert into public.contacts (full_name, phone_e164) values ('CV Y ' || i, '+97477' || lpad(i::text, 6, '0')) returning id into ct;
      insert into public.conversations (whatsapp_account_id, company_id, contact_id, customer_wa_id, owner_id, status)
      values (wa_a, b, ct, '97477' || lpad(i::text, 6, '0'), o, st::public.conversation_status) returning id into cv;
      insert into public.messages (conversation_id, direction, message_type, body, status) values (cv, 'inbound', 'text', 'hi ' || i, 'received');
    end loop;
  end loop;
end $$;

-- Reference: the ORIGINAL predicate functions over all rows (SECURITY DEFINER bypasses RLS; auth.uid() is still the logged-in user)
create function tests.old_conv(p_what text) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare v uuid[];
begin
  execute case p_what
    when 'conversations' then 'select array_agg(id order by id) from public.conversations c where app.can_see_conversation_row(c.company_id, c.whatsapp_account_id, c.owner_id)'
    when 'update' then 'select array_agg(id order by id) from public.conversations c where app.can_see_conversation_row(c.company_id, c.whatsapp_account_id, c.owner_id) and app.has_company_access(c.company_id)'
    when 'messages' then 'select array_agg(id order by id) from public.messages m where app.can_access_conversation(m.conversation_id)'
    when 'contacts' then 'select array_agg(id order by id) from public.contacts c where app.can_see_contact(c.id)'
  end into v;
  return coalesce(v, '{}');
end $$;
create function tests.new_conv(p_table text) returns uuid[]
language plpgsql stable security invoker set search_path = '' as $$
declare v uuid[];
begin
  execute format('select array_agg(id order by id) from public.%I', p_table) into v;
  return coalesce(v, '{}');
end $$;
grant execute on function tests.old_conv(text), tests.new_conv(text) to authenticated;

do $$
declare u text; n int := 0; expected uuid[]; actual uuid[]; t text; nonempty int := 0; sizes text := '';
begin
  foreach u in array array['super', 'admin_a', 'admin_b', 'mgr_a', 'agent_a1', 'agent_a2', 'shared', 'cs_b', 'agent_b', 'outsider', 'inactive'] loop
    perform tests.login(u);
    foreach t in array array['conversations', 'messages', 'contacts'] loop
      expected := tests.old_conv(t);
      actual := tests.new_conv(t);
      if expected is distinct from actual then
        raise exception 'FAIL: % / % differs (old % rows, new % rows)', u, t, cardinality(expected), cardinality(actual);
      end if;
      n := n + 1;
      if t = 'conversations' and cardinality(actual) > 0 then nonempty := nonempty + 1; end if;
      if t = 'conversations' then sizes := sizes || u || '=' || cardinality(actual) || ' '; end if;
    end loop;
  end loop;
  perform tests.logout();
  raise notice 'ok - conversations, messages and contacts match the original predicates for 11 users x 3 tables (% comparisons); visible conversations: %', n, sizes;
  if nonempty < 5 then raise exception 'FAIL: the matrix is too trivial (% users see conversations)', nonempty; end if;
end $$;

-- Write path: the conversations a user can UPDATE (a no-op update returns the affected ids, then everything is rolled back)
do $$
declare u text; expected uuid[]; actual uuid[]; n int := 0;
begin
  foreach u in array array['super', 'admin_a', 'admin_b', 'mgr_a', 'agent_a1', 'agent_a2', 'shared', 'cs_b', 'agent_b', 'outsider', 'inactive'] loop
    perform tests.login(u);
    expected := tests.old_conv('update');
    with x as (update public.conversations set status = status returning id) select coalesce(array_agg(id order by id), '{}') into actual from x;
    if expected is distinct from actual then
      raise exception 'FAIL: % can update conversations differently (old % rows, new % rows)', u, cardinality(expected), cardinality(actual);
    end if;
    n := n + 1;
  end loop;
  perform tests.logout();
  raise notice 'ok - UPDATE authorization of conversations matches the original rule for 11 users (% comparisons)', n;
end $$;

-- Sanity of the matrix: each kind of user sees a different, non-trivial set
select tests.login('agent_a1');
select tests.ok(not exists (select 1 from public.conversations where owner_id = tests.uid('agent_a2')), 'an agent does not see a colleague''s conversation');
select tests.ok(exists (select 1 from public.conversations where owner_id is null and whatsapp_account_id = tests.ref('wa_alpha')), 'an agent sees unassigned conversations of a number they hold');
select tests.ok(not exists (select 1 from public.conversations where whatsapp_account_id = tests.ref('wa_beta')), 'no access to a number without a grant');
select tests.login('mgr_a');
select tests.ok(exists (select 1 from public.conversations where owner_id = tests.uid('agent_a1')), 'a sales manager sees every conversation on their number');
select tests.login('outsider');
select tests.eq((select count(*) from public.conversations), 0::bigint, 'an outsider sees no conversation');
select tests.eq((select count(*) from public.messages), 0::bigint, '... and no message');
rollback;

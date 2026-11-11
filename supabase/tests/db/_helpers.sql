-- Test helpers (local test database only; never part of migrations).
create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

create table if not exists tests.users (key text primary key, id uuid not null);
grant select on tests.users to anon, authenticated, service_role;

create or replace function tests.uid(p_key text) returns uuid
language sql stable as $$ select id from tests.users where key = p_key $$;

create or replace function tests.create_user(p_key text, p_full_name text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into auth.users (email, raw_user_meta_data)
  values (p_key || '@test.local', jsonb_build_object('full_name', p_full_name))
  returning id into v_id;
  insert into tests.users values (p_key, v_id);
  return v_id;
end $$;

-- Become an authenticated user, like a Supabase API request with that JWT.
create or replace function tests.login(p_key text) returns void
language plpgsql as $$
declare v_id uuid := tests.uid(p_key);
begin
  if v_id is null then raise exception 'unknown test user %', p_key; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

create or replace function tests.login_anon() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, false);
  execute 'set role anon';
end $$;

-- Back to a trusted maintenance context (like the service role).
create or replace function tests.logout() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', false);
end $$;

create or replace function tests.service() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, false);
  execute 'set role service_role';
end $$;

create or replace function tests.ok(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_msg;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

create or replace function tests.eq(p_actual anyelement, p_expected anyelement, p_msg text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % (expected %, got %)', p_msg, p_expected, p_actual;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Run SQL and require it to fail with a message matching p_pattern.
create or replace function tests.throws(p_sql text, p_pattern text, p_msg text) returns void
language plpgsql as $$
declare v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'FAIL: % (expected an error matching "%", but the statement succeeded)', p_msg, p_pattern;
  end if;
  if v_err !~* p_pattern then
    raise exception 'FAIL: % (expected error matching "%", got "%")', p_msg, p_pattern, v_err;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Run SQL and require it to succeed.
create or replace function tests.lives(p_sql text, p_msg text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise exception 'FAIL: % (unexpected error: %)', p_msg, sqlerrm;
  end;
  raise notice 'ok - %', p_msg;
end $$;

-- Count rows visible to the current role.
create or replace function tests.count(p_sql text) returns bigint
language plpgsql as $$
declare v bigint;
begin
  execute 'select count(*) from (' || p_sql || ') q' into v;
  return v;
end $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

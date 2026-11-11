-- =============================================================================
-- 0810 — Rate limiting for sensitive endpoints (sign-in, password reset,
-- message send, CSV import/export).
--
-- Fixed-window counters in schema `app` (not exposed by the Data API).
-- Abuse-resistant by construction:
--   * a signed-in caller always counts against THEIR OWN bucket
--     (action + auth.uid()); any key they pass is ignored, so nobody can
--     exhaust another user's quota;
--   * keyed buckets (unauthenticated endpoints: sign-in, reset) are only
--     available to the service role; the server sends a hash, never a raw
--     e-mail or IP address.
-- =============================================================================

create table app.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, window_start)
);
revoke all on app.rate_limits from public, anon, authenticated;

-- Returns true when the call is allowed (counted), false when over the limit.
create or replace function public.rate_limit_hit(
  p_action text, p_key text, p_limit int, p_window_seconds int
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_bucket text;
  v_window timestamptz;
  v_hits int;
begin
  if p_action !~ '^[a-z_]{1,40}$' or p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'rate_limit.invalid_arguments' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    v_bucket := p_action || ':u:' || auth.uid()::text;
  elsif app.is_service_context() then
    if p_key is null or p_key !~ '^[A-Za-z0-9_:.-]{1,128}$' then
      raise exception 'rate_limit.invalid_arguments' using errcode = '22023';
    end if;
    v_bucket := p_action || ':k:' || p_key;
  else
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into app.rate_limits as r (bucket, window_start, hits) values (v_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- Service role only (maintenance cron): drop expired windows.
create or replace function public.purge_rate_limits() returns int
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  delete from app.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v = row_count;
  return v;
end $$;

revoke execute on function public.rate_limit_hit(text, text, int, int), public.purge_rate_limits() from public, anon;
grant execute on function public.rate_limit_hit(text, text, int, int) to authenticated, service_role;
revoke execute on function public.purge_rate_limits() from authenticated;
grant execute on function public.purge_rate_limits() to service_role;

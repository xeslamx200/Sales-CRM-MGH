-- =============================================================================
-- 0870 — Supabase-native scheduled jobs (pg_cron), no paid plan required.
--
-- Everything the scheduled work needs is already in SQL (idempotent ingest /
-- echo / status functions, task reminders, retention), so it runs inside the
-- database: no HTTP hop, no Vercel Cron (Hobby only allows daily crons), no
-- external automation platform.
--
--   webhook_retries  every 5 min  re-dispatch failed webhook events (bounded attempts)
--   task_reminders   every 15 min due/overdue task notifications (deduplicated)
--   retention        daily        purge intake rows and rate-limit windows
--
-- Properties:
--   * authenticated: functions are service-only; pg_cron runs them as the
--     database owner (service context). Users cannot call them.
--   * idempotent / safe to retry: every step deduplicates (event-key claims,
--     wa_message_id uniqueness, forward-only statuses, reminder dedupe keys);
--     concurrent runs skip rows another run holds (FOR UPDATE SKIP LOCKED).
--   * observable: every run is logged in app.job_runs (counts, duration,
--     error code); super admins read it via public.job_status().
-- =============================================================================

create table app.job_runs (
  id bigint generated always as identity primary key,
  job text not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  ok boolean,
  details jsonb not null default '{}'::jsonb,
  error text
);
create index job_runs_job_idx on app.job_runs (job, started_at desc);
revoke all on app.job_runs from public, anon, authenticated;

-- Stable error code only (never message content).
create or replace function app.safe_error(p_msg text) returns text
language sql immutable set search_path = '' as $$
  select case when p_msg ~ '^[a-z_]+(\.[a-z_]+){1,3}$' and length(p_msg) <= 120 then p_msg else 'processing_error' end
$$;

-- ------------------------------------------------------------- webhook retries
-- Payloads are the processor's serialized events (src/lib/whatsapp/processor.ts
-- serializeEvent): camelCase keys, ISO timestamps.
create or replace function public.process_webhook_retries(p_limit int default 100, p_max_attempts int default 8)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e record;
  p jsonb;
  v_ok boolean;
  v_processed int := 0;
  v_failed int := 0;
  v_ignored int := 0;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  for e in
    select w.event_key, w.payload from public.whatsapp_webhook_events w
    where w.status = 'failed' and w.attempts < p_max_attempts
    order by w.received_at
    limit least(greatest(p_limit, 1), 500)
    for update skip locked
  loop
    p := e.payload;
    update public.whatsapp_webhook_events set attempts = attempts + 1 where event_key = e.event_key;
    begin
      case p ->> 'kind'
        when 'message' then
          perform public.ingest_whatsapp_message(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'fromWaId',
            p ->> 'profileName', p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'echo' then
          perform public.ingest_whatsapp_echo(p ->> 'phoneNumberId', p ->> 'waMessageId', p ->> 'toWaId',
            p ->> 'messageType', p ->> 'body', nullif(p -> 'media', 'null'::jsonb), (p ->> 'sentAt')::timestamptz);
          v_ok := true;
        when 'status' then
          v_ok := public.apply_whatsapp_status(p ->> 'waMessageId', p ->> 'status', p ->> 'errorCode', p ->> 'errorMessage');
        else
          perform public.finish_webhook_event(e.event_key, 'ignored');
          v_ignored := v_ignored + 1;
          continue;
      end case;
      if v_ok then
        perform public.finish_webhook_event(e.event_key, 'processed');
        v_processed := v_processed + 1;
      else
        perform public.finish_webhook_event(e.event_key, 'failed', 'status.message_not_found');
        v_failed := v_failed + 1;
      end if;
    exception when others then
      perform public.finish_webhook_event(e.event_key, 'failed', app.safe_error(sqlerrm));
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('processed', v_processed, 'failed', v_failed, 'ignored', v_ignored);
end $$;

-- ------------------------------------------------------------------ dispatcher
create or replace function public.run_scheduled_job(p_job text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run bigint;
  v_details jsonb;
  v_purged int;
begin
  if not app.is_service_context() then
    raise exception 'auth.forbidden' using errcode = '42501';
  end if;
  if p_job not in ('webhook_retries', 'task_reminders', 'retention') then
    raise exception 'job.unknown' using errcode = '22023';
  end if;
  insert into app.job_runs (job) values (p_job) returning id into v_run;
  begin
    if p_job = 'webhook_retries' then
      v_details := public.process_webhook_retries();
    elsif p_job = 'task_reminders' then
      v_details := jsonb_build_object('notifications', public.generate_task_reminders());
    else
      delete from app.job_runs where started_at < now() - interval '30 days';
      get diagnostics v_purged = row_count;
      v_details := jsonb_build_object(
        'webhook_events_purged', public.purge_old_webhook_events(30),
        'rate_limit_windows_purged', public.purge_rate_limits(),
        'job_runs_purged', v_purged);
    end if;
    update app.job_runs set finished_at = clock_timestamp(), ok = true, details = v_details where id = v_run;
  exception when others then
    -- Not re-raised: that would roll back this log row too. The failure is
    -- visible in app.job_runs / public.job_status() with a stable code.
    v_details := jsonb_build_object('error', app.safe_error(sqlerrm));
    update app.job_runs set finished_at = clock_timestamp(), ok = false, error = v_details ->> 'error' where id = v_run;
  end;
  return v_details;
end $$;

-- Super admins: last run of each job (for the system status panel).
create or replace function public.job_status()
returns table (job text, last_started_at timestamptz, last_finished_at timestamptz, last_ok boolean,
               last_error text, last_details jsonb, runs_24h bigint, failures_24h bigint)
language sql stable security definer set search_path = '' as $$
  select j.job, l.started_at, l.finished_at, l.ok, l.error, l.details,
    (select count(*) from app.job_runs r where r.job = j.job and r.started_at > now() - interval '24 hours'),
    (select count(*) from app.job_runs r where r.job = j.job and r.started_at > now() - interval '24 hours' and r.ok is false)
  from (values ('webhook_retries'), ('task_reminders'), ('retention')) j(job)
  left join lateral (select * from app.job_runs r where r.job = j.job order by r.started_at desc limit 1) l on true
  where app.is_super_admin()
$$;

revoke execute on function public.process_webhook_retries(int, int), public.run_scheduled_job(text), public.job_status()
  from public, anon;
revoke execute on function public.process_webhook_retries(int, int), public.run_scheduled_job(text) from authenticated;
grant execute on function public.process_webhook_retries(int, int), public.run_scheduled_job(text) to service_role;
grant execute on function public.job_status() to authenticated;
revoke all on function app.safe_error(text) from public, anon;

-- ------------------------------------------------------------------ schedules
-- Created only where pg_cron exists (Supabase; not the plain test database).
-- cron.schedule(name, …) updates an existing job of the same name, so
-- re-running this migration is harmless.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('crm-webhook-retries', '*/5 * * * *', 'select public.run_scheduled_job(''webhook_retries'')');
    perform cron.schedule('crm-task-reminders', '*/15 * * * *', 'select public.run_scheduled_job(''task_reminders'')');
    perform cron.schedule('crm-retention', '17 3 * * *', 'select public.run_scheduled_job(''retention'')');
  end if;
end $$;

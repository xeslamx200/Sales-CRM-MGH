-- =============================================================================
-- 0690 — Function privileges.
-- PostgreSQL grants EXECUTE to PUBLIC on every new function; tighten that.
-- =============================================================================

-- Internal helpers: callable by API roles (RLS policies and invoker triggers
-- need them), never by anon. The `app` schema is not exposed by the Data API.
revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated, service_role;

-- Mutating internals are only ever called from SECURITY DEFINER code (which
-- runs as the owner), so API roles do not need them at all.
revoke execute on function
  app.write_audit(uuid, text, text, uuid, jsonb),
  app.notify(uuid, uuid, text, text, text, text, uuid, text),
  app.notify_team_managers(uuid, uuid, text, text, text, text, uuid),
  app.ensure_contact_link(uuid, uuid),
  app.begin_system_op(),
  app.end_system_op()
from authenticated, service_role;

-- Public RPCs: never for anon.
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.find_or_create_contact(uuid, text, text, text),
  public.assign_lead(uuid, uuid, uuid, text),
  public.convert_lead_to_deal(uuid, text, numeric, uuid, uuid, date, uuid),
  public.assign_conversation(uuid, uuid, text),
  public.queue_outbound_message(uuid, text, uuid),
  public.merge_contacts(uuid, uuid),
  public.dismiss_duplicate_review(uuid),
  public.mark_notifications_read(uuid[])
to authenticated;

-- Service-only RPCs (webhook processor, send pipeline, scheduler).
revoke execute on function
  public.record_outbound_result(uuid, text, text, text),
  public.ingest_whatsapp_message(text, text, text, text, text, text, jsonb, timestamptz),
  public.apply_whatsapp_status(text, text, text, text),
  public.generate_task_reminders(timestamptz)
from authenticated;
grant execute on all functions in schema public to service_role;

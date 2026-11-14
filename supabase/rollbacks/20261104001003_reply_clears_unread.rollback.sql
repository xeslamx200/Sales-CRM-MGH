-- ROLLBACK of 20261104001003: the body of migration 600 (a reply no longer clears the unread counter). Run with psql -1.
create or replace function app.after_message_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.begin_system_op();
  if new.direction = 'inbound' then
    update public.conversations set
      last_message_at = greatest(coalesce(last_message_at, new.sent_at), new.sent_at),
      last_inbound_at = greatest(coalesce(last_inbound_at, new.sent_at), new.sent_at),
      unread_count = unread_count + 1,
      status = case when status = 'resolved' then 'open'::public.conversation_status else status end
    where id = new.conversation_id;
  else
    update public.conversations set
      last_message_at = greatest(coalesce(last_message_at, new.sent_at), new.sent_at),
      last_outbound_at = greatest(coalesce(last_outbound_at, new.sent_at), new.sent_at)
    where id = new.conversation_id;
  end if;
  perform app.end_system_op();
  return null;
end $$;

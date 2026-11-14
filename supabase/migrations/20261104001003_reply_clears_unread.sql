-- 20261104001003 - A reply clears the conversation's unread counter.
--
-- Reading a chat on the phone sends NO event (Kapso and Meta document none), so the CRM kept showing "unread" for chats the team had already
-- read and answered on the phone. What does arrive is the echo of a message typed on the phone (kapso origin "business_app"): that is an
-- outbound message, and a reply sent after the customer's latest message proves the chat was read. The same applies to a reply sent from
-- the CRM. Outbound rows OLDER than the latest inbound message (imported history) clear nothing.
-- Only the outbound branch of app.after_message_insert changes. Rollback: supabase/rollbacks/20261104001003_reply_clears_unread.rollback.sql
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
      last_outbound_at = greatest(coalesce(last_outbound_at, new.sent_at), new.sent_at),
      -- a reply (from the CRM or typed on the phone and echoed back) sent after the customer's latest message means someone read it;
      -- older outbound rows (imported history) do not clear anything
      unread_count = case when new.sent_at >= coalesce(last_inbound_at, new.sent_at) then 0 else unread_count end
    where id = new.conversation_id;
  end if;
  perform app.end_system_op();
  return null;
end $$;

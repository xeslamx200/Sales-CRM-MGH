-- Migration 1003: a reply sent after the customer's latest message clears the unread counter; older outbound rows (history) do not.
begin;
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RU1', '97455557070', 'Read Test', 'text', 'first', null, now() - interval '3 hours');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RU2', '97455557070', 'Read Test', 'text', 'second', null, now() - interval '2 hours');
select tests.logout();
insert into tests.refs select 'ru', id from public.conversations where customer_wa_id = '97455557070';
select tests.eq((select unread_count from public.conversations where id = tests.ref('ru')), 2, 'two inbound messages: two unread');
-- an OLD outbound row (imported history) from before the latest inbound message
insert into public.messages (conversation_id, direction, message_type, body, status, sent_at) values (tests.ref('ru'), 'outbound', 'text', 'old reply', 'sent', now() - interval '2.5 hours');
select tests.eq((select unread_count from public.conversations where id = tests.ref('ru')), 2, 'an outbound message older than the latest inbound one clears nothing');
-- a reply typed on the phone, echoed back after the latest inbound message
insert into public.messages (conversation_id, direction, message_type, body, status, sent_at) values (tests.ref('ru'), 'outbound', 'text', 'phone reply', 'sent', now() - interval '1 hour');
select tests.eq((select unread_count from public.conversations where id = tests.ref('ru')), 0, 'a reply after the latest inbound message clears the unread counter');
-- a new inbound message after it is unread again
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.RU3', '97455557070', 'Read Test', 'text', 'third', null, now() - interval '10 minutes');
select tests.logout();
select tests.eq((select unread_count from public.conversations where id = tests.ref('ru')), 1, 'a newer inbound message counts as unread again');
rollback;

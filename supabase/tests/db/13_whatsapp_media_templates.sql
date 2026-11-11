-- WhatsApp templates, media queueing, credential health alerts (0890).
begin;
select tests.service();
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.T1', '97455553030', 'Template Customer', 'text', 'old question', null, now() - interval '3 days');
select * from public.ingest_whatsapp_message('PNID_ALPHA', 'wamid.T2', '97455553031', 'Fresh Customer', 'text', 'new question', null, now() - interval '1 hour');
select tests.logout();
insert into tests.refs select 'stale', id from public.conversations where customer_wa_id = '97455553030';
insert into tests.refs select 'fresh', id from public.conversations where customer_wa_id = '97455553031';

-- ------------------------------------------------------------------ templates
select tests.service();
select tests.eq(public.sync_whatsapp_templates(tests.ref('wa_alpha'), jsonb_build_array(
  jsonb_build_object('name', 'follow_up', 'language', 'ar', 'status', 'APPROVED', 'category', 'UTILITY',
                     'body_text', 'مرحباً {{1}}، نود متابعة طلبك رقم {{2}}.', 'param_count', 2),
  jsonb_build_object('name', 'promo', 'language', 'ar', 'status', 'PENDING', 'body_text', 'عرض', 'param_count', 0),
  -- 0940: shaped like Meta's sample "jaspers_market_image_cta_v1" (image header + buttons).
  jsonb_build_object('name', 'image_cta', 'language', 'en_US', 'status', 'APPROVED', 'body_text', 'Fresh produce', 'param_count', 0,
    'components', '[{"type":"HEADER","format":"IMAGE"},{"type":"BODY","text":"Fresh produce"},{"type":"BUTTONS","buttons":[{"type":"QUICK_REPLY","text":"Shop"}]}]'::jsonb)
)), 3, 'templates synced');
select tests.login('agent_a1');
select tests.eq(tests.count('select * from public.whatsapp_templates'), 3::bigint, 'agent with a grant sees the number''s templates');
select tests.login('agent_b');
select tests.eq(tests.count('select * from public.whatsapp_templates'), 0::bigint, 'others do not');
select tests.throws($q$select public.sync_whatsapp_templates(tests.ref('wa_alpha'), '[]'::jsonb)$q$, 'permission denied',
  'users cannot write templates');

select tests.login('agent_a1');
select tests.throws($q$select * from public.queue_outbound(tests.ref('stale'), gen_random_uuid(), 'text', 'hello again')$q$,
  'whatsapp.outside_service_window', 'free text is refused after 24 hours');
select tests.throws($q$select * from public.queue_outbound(tests.ref('stale'), gen_random_uuid(), 'template', null, null,
  '{"name":"follow_up","language":"ar","params":["Sara"]}'::jsonb)$q$, 'whatsapp.template_params_invalid', 'parameter count must match');
select tests.throws($q$select * from public.queue_outbound(tests.ref('stale'), gen_random_uuid(), 'template', null, null,
  '{"name":"promo","language":"ar","params":[]}'::jsonb)$q$, 'whatsapp.template_not_approved', 'unapproved templates cannot be sent');
select tests.throws($q$select * from public.queue_outbound(tests.ref('stale'), gen_random_uuid(), 'template', null, null,
  '{"name":"image_cta","language":"en_US","params":[]}'::jsonb)$q$, 'whatsapp.template_unsupported',
  'an approved template that needs media or button parameters is refused (Meta would reject it)');
select tests.ok((select not supported from public.whatsapp_templates where name = 'image_cta')
  and (select supported from public.whatsapp_templates where name = 'follow_up'), 'supported flag is derived from the components');
select tests.eq(array[
    app.template_supported('[{"type":"HEADER","format":"TEXT","text":"Hello"},{"type":"BODY","text":"Hi {{1}}"},{"type":"FOOTER","text":"x"},{"type":"BUTTONS","buttons":[{"type":"URL","url":"https://example.com/a"},{"type":"QUICK_REPLY","text":"ok"}]}]'),
    app.template_supported('[{"type":"HEADER","format":"TEXT","text":"Order {{1}}"},{"type":"BODY","text":"x"}]'),
    app.template_supported('[{"type":"BODY","text":"Hi {{first_name}}"}]'),
    app.template_supported('[{"type":"BODY","text":"x"},{"type":"BUTTONS","buttons":[{"type":"URL","url":"https://example.com/{{1}}"}]}]'),
    app.template_supported('[{"type":"BODY","text":"x"},{"type":"BUTTONS","buttons":[{"type":"COPY_CODE"}]}]'),
    app.template_supported('[{"type":"BODY","text":"x"},{"type":"CAROUSEL","cards":[]}]'),
    app.template_supported('[]')],
  array[true, false, false, false, false, false, true], 'template_supported: static parts only; header/named/URL params, copy-code and carousels are not');
create temp table q as select * from public.queue_outbound(tests.ref('stale'), gen_random_uuid(), 'template', 'IGNORED TEXT', null,
  '{"name":"follow_up","language":"ar","params":["سارة","1042"]}'::jsonb);
select tests.eq((select body from public.messages where id = (select message_id from q)), 'مرحباً سارة، نود متابعة طلبك رقم 1042.',
  'an approved template is allowed outside 24 hours and its text is rendered by the database (caller text ignored)');
select tests.eq((select media -> 'template' ->> 'name' from public.messages where id = (select message_id from q)), 'follow_up',
  'template name/params are stored for sending');
drop table q;

select tests.login('agent_a2');   -- read-only grant
select tests.throws($q$select * from public.queue_outbound(tests.ref('stale'), gen_random_uuid(), 'template', null, null,
  '{"name":"follow_up","language":"ar","params":["a","b"]}'::jsonb)$q$, '(whatsapp.no_reply_permission|conversation.not_found)',
  'a read-only user cannot send templates');

-- ---------------------------------------------------------------------- media
select tests.login('agent_a1');
select tests.throws(format($q$select * from public.queue_outbound(%L, gen_random_uuid(), 'image', null,
  '{"storage_path":"outbound/someone-else/x/a.jpg","mime_type":"image/jpeg"}'::jsonb)$q$, tests.ref('fresh')),
  'message.invalid_media', 'media must come from this conversation''s upload area');
create temp table mq as select * from public.queue_outbound(tests.ref('fresh'), gen_random_uuid(), 'image', 'صورة العرض',
  jsonb_build_object('storage_path', 'outbound/' || tests.ref('fresh') || '/abc123/offer.jpg', 'mime_type', 'image/jpeg',
                     'filename', 'offer.jpg', 'size', 2048, 'evil', 'dropped'));
select tests.eq((select media - 'storage_path' from public.messages where id = (select message_id from mq)),
  '{"size": 2048, "filename": "offer.jpg", "mime_type": "image/jpeg"}'::jsonb, 'media metadata is whitelisted');
select tests.eq((select body from public.messages where id = (select message_id from mq)), 'صورة العرض', 'caption kept');
select tests.lives($q$select * from public.queue_outbound_message(tests.ref('fresh'), 'text still works', gen_random_uuid())$q$,
  'the original text RPC still works (wrapper)');

-- ----------------------------------------------------------- media cache RLS
select tests.logout();
insert into public.message_media_cache (message_id, storage_path, mime_type, size_bytes)
select id, 'inbound/x/' || id || '/file.pdf', 'application/pdf', 100 from public.messages where wa_message_id = 'wamid.T2';
select tests.login('agent_a1');
select tests.eq(tests.count('select * from public.message_media_cache'), 1::bigint, 'conversation viewers see the cache entry');
select tests.throws($q$insert into public.message_media_cache (message_id, storage_path, mime_type, size_bytes)
  values (gen_random_uuid(), 'x', 'a/b', 1)$q$, 'row-level security', 'users cannot write cache entries');
select tests.login('admin_b');
select tests.eq(tests.count('select * from public.message_media_cache'), 0::bigint, 'other companies do not');

-- ------------------------------------------------------- credential health
select tests.service();
select public.report_whatsapp_account_health(tests.ref('wa_alpha'), false, '190');
select public.report_whatsapp_account_health(tests.ref('wa_alpha'), false, '190');
select tests.logout();
select tests.eq((select count(*) from public.notifications where type = 'whatsapp_credentials' and user_id = tests.uid('admin_a')), 1::bigint,
  'the number''s company admin is alerted once per day');
select tests.eq((select count(*) from public.notifications where type = 'whatsapp_credentials' and user_id = tests.uid('super')), 1::bigint,
  'super admins are alerted');
select tests.eq((select count(*) from public.notifications where type = 'whatsapp_credentials' and user_id = tests.uid('agent_a1')), 0::bigint,
  'agents are not alerted');
select tests.eq((select count(*) from public.audit_logs where action = 'whatsapp.credentials_failed'), 1::bigint, 'failure audited once');
select tests.login('agent_a1');
select tests.eq((select status || '/' || error_code from public.whatsapp_account_health where whatsapp_account_id = tests.ref('wa_alpha')),
  'error/190', 'people with access can see the number is failing');
select tests.throws($q$select public.report_whatsapp_account_health(tests.ref('wa_alpha'), true)$q$, 'permission denied',
  'users cannot clear the alert');
select tests.service();
select public.report_whatsapp_account_health(tests.ref('wa_alpha'), true);
select tests.logout();
select tests.eq((select status from public.whatsapp_account_health where whatsapp_account_id = tests.ref('wa_alpha')), 'ok', 'recovery recorded');
select tests.eq((select count(*) from public.audit_logs where action = 'whatsapp.credentials_restored'), 1::bigint, 'recovery audited');

rollback;

-- Company branding (proposed migration 992). Lives outside supabase/tests/db.
-- Run: psql -v ON_ERROR_STOP=1 -d <scratch db with 27 migrations + 970..992 + _helpers.sql + _fixtures.sql> -f supabase/tests/db/32_company_branding.sql
begin;
select tests.logout();
select tests.eq((select count(*) from public.company_branding), 0::bigint, 'a fresh database has no branding (applying the migration changes nothing)');

-- who may change it ----------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.throws($q$select public.set_company_branding(tests.ref('alpha'), '#0b2a52', '#f9c846', '#1a468a', false)$q$, 'auth.forbidden', 'an agent cannot change the colours');
select tests.throws($q$select public.set_company_logo(tests.ref('alpha'), '\x89504e470d0a1a0a00'::bytea, 'image/png')$q$, 'auth.forbidden', 'an agent cannot set the logo');
select tests.throws($q$select public.reset_company_branding(tests.ref('alpha'))$q$, 'auth.forbidden', 'an agent cannot reset');
select tests.login('mgr_a');
select tests.throws($q$select public.set_company_branding(tests.ref('alpha'), '#0b2a52', '#f9c846', '#1a468a', false)$q$, 'auth.forbidden', 'a sales manager cannot (company admins only)');
select tests.login('admin_b');
select tests.throws($q$select public.set_company_branding(tests.ref('alpha'), '#0b2a52', '#f9c846', '#1a468a', false)$q$, 'auth.forbidden', 'another company''s admin cannot');

-- colours ------------------------------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select tests.throws($q$select public.set_company_branding(tests.ref('alpha'), 'red', '#f9c846', '#1a468a', false)$q$, 'branding.invalid_color', 'a colour name is refused');
select tests.throws($q$select public.set_company_branding(tests.ref('alpha'), '#0b2a5', '#f9c846', '#1a468a', false)$q$, 'branding.invalid_color', 'a short hex is refused');
select tests.throws($q$select public.set_company_branding(tests.ref('alpha'), '#0b2a52', '#f9c846; drop', '#1a468a', false)$q$, 'branding.invalid_color', 'anything but #rrggbb is refused (no injection into a style)');
select tests.throws($q$select public.set_company_branding(tests.ref('alpha'), '#0b2a52', '#f9c846', null, false)$q$, 'branding.invalid_color', 'a missing colour is refused');
select tests.throws($q$insert into public.company_branding (company_id) values (tests.ref('alpha'))$q$, 'permission denied', 'no direct write');
select tests.eq((select count(*) from public.company_branding), 0::bigint, 'failed attempts stored nothing');
select public.set_company_branding(tests.ref('alpha'), '#0A3D2E', '#F2B705', '#1F6F54', true);
select tests.eq((select brand_navy || ' ' || brand_gold || ' ' || brand_blue || ' ' || logo_plate::text from public.company_branding where company_id = tests.ref('alpha')), '#0a3d2e #f2b705 #1f6f54 true', 'saved in lower case');
select public.set_company_branding(tests.ref('alpha'), '#0a3d2e', '#f2b705', '#1f6f54', false);
select tests.eq((select count(*) from public.company_branding), 1::bigint, 'one row per company');

-- logo -------------------------------------------------------------------------------------------------------------------------------------------
select tests.throws($q$select public.set_company_logo(tests.ref('alpha'), '\x89504e470d0a1a0a00'::bytea, 'image/gif')$q$, 'branding.logo_type', 'only PNG / JPEG / WebP');
select tests.throws($q$select public.set_company_logo(tests.ref('alpha'), '\x89504e470d0a1a0a00'::bytea, 'image/svg+xml')$q$, 'branding.logo_type', 'SVG is refused on purpose');
select tests.throws($q$select public.set_company_logo(tests.ref('alpha'), '\x3c7376672f3e'::bytea, 'image/png')$q$, 'branding.logo_invalid', 'a file that is not really a PNG is refused (its first bytes are checked)');
select tests.throws($q$select public.set_company_logo(tests.ref('alpha'), '\x89504e470d0a1a0a00'::bytea, 'image/jpeg')$q$, 'branding.logo_invalid', 'a PNG declared as JPEG is refused');
select tests.throws($q$select public.set_company_logo(tests.ref('alpha'), decode('89504e470d0a1a0a', 'hex') || repeat('a', 524289)::bytea, 'image/png')$q$, 'branding.logo_too_large', 'more than 512 KB is refused');
select public.set_company_logo(tests.ref('alpha'), '\x89504e470d0a1a0a0000'::bytea, 'image/png');
select public.set_company_logo(tests.ref('alpha'), '\xffd8ffe000'::bytea, 'image/jpeg');
select public.set_company_logo(tests.ref('alpha'), '\x52494646000000005745425000'::bytea, 'image/webp');
select tests.eq((select logo_type from public.company_logo(tests.ref('alpha'))), 'image/webp', 'a JPEG and a WebP with the right first bytes are accepted (the last one is kept)');
select tests.eq((select brand_navy from public.company_branding where company_id = tests.ref('alpha')), '#0a3d2e', 'setting the logo keeps the colours');

-- who can read ---------------------------------------------------------------------------------------------------------------------------------
select tests.login('agent_a1');
select tests.eq((select brand_navy || ' ' || coalesce(logo_type, '-') from public.company_branding), '#0a3d2e image/webp', 'an employee reads the colours and the logo type');
select tests.throws($q$select logo from public.company_branding$q$, 'permission denied', 'but never the logo bytes through the table');
select tests.eq((select count(*) from public.company_logo(tests.ref('alpha'))), 1::bigint, 'the logo comes through company_logo for a member');
select tests.login('admin_b');
select tests.eq((select count(*) from public.company_branding), 0::bigint, 'another company sees nothing');
select tests.throws($q$select * from public.company_logo(tests.ref('alpha'))$q$, 'auth.forbidden', 'and cannot fetch the logo');
select tests.login_anon();
select tests.throws($q$select * from public.company_logo(tests.ref('alpha'))$q$, 'permission denied', 'anonymous cannot');

-- clear + reset + audit -------------------------------------------------------------------------------------------------------------------------
select tests.login('admin_a');
select public.set_company_logo(tests.ref('alpha'), null, null);
select tests.eq((select count(*) from public.company_logo(tests.ref('alpha'))), 0::bigint, 'clearing the logo removes it');
select tests.eq((select brand_gold from public.company_branding where company_id = tests.ref('alpha')), '#f2b705', 'and keeps the colours');
select public.reset_company_branding(tests.ref('alpha'));
select tests.eq((select count(*) from public.company_branding), 0::bigint, 'reset deletes the row (back to the built-in look)');
select tests.eq((select count(*) from public.audit_logs where company_id = tests.ref('alpha') and action in ('company.branding_set', 'company.logo_set', 'company.logo_cleared', 'company.branding_reset')), 7::bigint, 'every change is audited (2 colour saves, 3 logo saves, 1 clear, 1 reset)');
select tests.logout();
rollback;

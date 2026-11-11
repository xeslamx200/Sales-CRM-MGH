-- PROPOSED, NOT APPLIED ANYWHERE BUT DISPOSABLE SCRATCH DATABASES. Apply only with explicit approval; psql -1.
-- 20261104000992 - Company branding controlled by the company admin from the CRM: three brand colours (dark navy = sidebar and dark cards, highlight = the
-- gold accent, primary = buttons and links) and the company logo. Purely additive: one table and four functions. A company WITHOUT a row keeps the
-- built-in MGH look, so applying this migration changes nothing until an admin saves.
--  * company_branding: one row per company. Members read the colours (column-level grant); the logo bytes are NOT readable through the table, only
--    through company_logo(), which checks company membership. Nobody writes the table directly.
--  * set_company_branding / set_company_logo / reset_company_branding: company admins and super admins only; audited ('company.branding_set',
--    'company.logo_set', 'company.logo_cleared', 'company.branding_reset'). Colours must be #rrggbb. A logo must be PNG, JPEG or WebP (checked by its
--    first bytes, not only by the declared type) and at most 512 KB; SVG is refused on purpose (it can carry scripts).
-- Rollback: supabase/proposed/rollbacks/20261104000992_company_branding.rollback.sql (refuses while any row exists)

create table public.company_branding (
  company_id uuid primary key references public.companies (id) on delete cascade,
  brand_navy text not null default '#0b2a52' check (brand_navy ~ '^#[0-9a-f]{6}$'),
  brand_gold text not null default '#f9c846' check (brand_gold ~ '^#[0-9a-f]{6}$'),
  brand_blue text not null default '#1a468a' check (brand_blue ~ '^#[0-9a-f]{6}$'),
  logo bytea,
  logo_type text check (logo_type in ('image/png', 'image/jpeg', 'image/webp')),
  logo_plate boolean not null default false,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((logo is null) = (logo_type is null)),
  check (logo is null or octet_length(logo) <= 524288)
);
alter table public.company_branding enable row level security;
revoke all on public.company_branding from public, anon, authenticated;
grant select (company_id, brand_navy, brand_gold, brand_blue, logo_type, logo_plate, updated_at) on public.company_branding to authenticated;
grant all on public.company_branding to service_role;
create policy company_branding_select on public.company_branding for select to authenticated using (app.has_company_access(company_id));

create or replace function public.set_company_branding(p_company_id uuid, p_navy text, p_gold text, p_blue text, p_logo_plate boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_n text := lower(btrim(coalesce(p_navy, ''))); v_g text := lower(btrim(coalesce(p_gold, ''))); v_b text := lower(btrim(coalesce(p_blue, '')));
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if v_n !~ '^#[0-9a-f]{6}$' or v_g !~ '^#[0-9a-f]{6}$' or v_b !~ '^#[0-9a-f]{6}$' then raise exception 'branding.invalid_color' using errcode = '23514'; end if;
  insert into public.company_branding (company_id, brand_navy, brand_gold, brand_blue, logo_plate, updated_by)
  values (p_company_id, v_n, v_g, v_b, coalesce(p_logo_plate, false), auth.uid())
  on conflict (company_id) do update set brand_navy = excluded.brand_navy, brand_gold = excluded.brand_gold, brand_blue = excluded.brand_blue,
    logo_plate = excluded.logo_plate, updated_by = excluded.updated_by, updated_at = now();
  perform app.write_audit(p_company_id, 'company.branding_set', 'company', p_company_id, jsonb_build_object('navy', v_n, 'gold', v_g, 'blue', v_b, 'logo_plate', coalesce(p_logo_plate, false)));
end $$;

-- Set the logo (bytes + declared type) or clear it (p_logo null). Colours already saved are kept.
create or replace function public.set_company_logo(p_company_id uuid, p_logo bytea, p_type text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_head bytea;
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  if p_logo is null then
    update public.company_branding set logo = null, logo_type = null, updated_by = auth.uid(), updated_at = now() where company_id = p_company_id;
    perform app.write_audit(p_company_id, 'company.logo_cleared', 'company', p_company_id, '{}'::jsonb);
    return;
  end if;
  if octet_length(p_logo) > 524288 then raise exception 'branding.logo_too_large' using errcode = '23514'; end if;
  if p_type is null or p_type not in ('image/png', 'image/jpeg', 'image/webp') then raise exception 'branding.logo_type' using errcode = '23514'; end if;
  v_head := substring(p_logo from 1 for 12);
  if not ((p_type = 'image/png' and substring(v_head from 1 for 8) = '\x89504e470d0a1a0a'::bytea)
       or (p_type = 'image/jpeg' and substring(v_head from 1 for 3) = '\xffd8ff'::bytea)
       or (p_type = 'image/webp' and substring(v_head from 1 for 4) = '\x52494646'::bytea and substring(v_head from 9 for 4) = '\x57454250'::bytea)) then
    raise exception 'branding.logo_invalid' using errcode = '23514';
  end if;
  insert into public.company_branding (company_id, logo, logo_type, updated_by) values (p_company_id, p_logo, p_type, auth.uid())
  on conflict (company_id) do update set logo = excluded.logo, logo_type = excluded.logo_type, updated_by = excluded.updated_by, updated_at = now();
  perform app.write_audit(p_company_id, 'company.logo_set', 'company', p_company_id, jsonb_build_object('type', p_type, 'bytes', octet_length(p_logo)));
end $$;

-- Back to the built-in look (colours and logo).
create or replace function public.reset_company_branding(p_company_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_active_user() or not app.is_company_admin(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  delete from public.company_branding where company_id = p_company_id;
  perform app.write_audit(p_company_id, 'company.branding_reset', 'company', p_company_id, '{}'::jsonb);
end $$;

-- The logo bytes, for the members of the company only.
create or replace function public.company_logo(p_company_id uuid) returns table (logo bytea, logo_type text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_active_user() or not app.has_company_access(p_company_id) then raise exception 'auth.forbidden' using errcode = '42501'; end if;
  return query select b.logo, b.logo_type, b.updated_at from public.company_branding b where b.company_id = p_company_id and b.logo is not null;
end $$;

revoke all on function public.set_company_branding(uuid, text, text, text, boolean), public.set_company_logo(uuid, bytea, text), public.reset_company_branding(uuid), public.company_logo(uuid) from public, anon;
grant execute on function public.set_company_branding(uuid, text, text, text, boolean), public.set_company_logo(uuid, bytea, text), public.reset_company_branding(uuid), public.company_logo(uuid) to authenticated, service_role;

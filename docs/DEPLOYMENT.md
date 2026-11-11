# Deployment

Target: **staging first** (`crm-dev` Supabase project + Vercel Preview), then production at `https://crm.YOURDOMAIN.com` (placeholder — replaced only once you give the real domain). WordPress stays on `https://YOURDOMAIN.com`, untouched.

> **Status (21 Oct 2026):** everything below is prepared and checked locally — build, migrations (dry-run + safety check), CI workflow, health endpoint, staging seed safeguards. **Nothing has been deployed.** Each step marked 🔐 needs your account; each step marked ✋ needs your explicit approval before it runs.

## 0. What you need to create (owner actions)

| # | Item | Where | Notes |
|---|---|---|---|
| 1 | Private GitHub repository | github.com → New repository → **Private** | 🔐 I can push once you create it and give me access (or you push; see §2). |
| 2 | Supabase project **`crm-dev`** (staging) | supabase.com → New project | 🔐 Region near Qatar (e.g. `eu-central-1` Frankfurt or `ap-south-1` Mumbai). Free plan is fine for staging. |
| 3 | Supabase project **`crm-prod`** | same | 🔐 Pro plan recommended (daily backups + PITR add-on). Create later. |
| 4 | Vercel project | vercel.com → Add New → Project → import the repo | 🔐 No Vercel Cron is needed (scheduled jobs run in the database). **Plan:** Vercel's Hobby plan is for personal, non-commercial use only (their fair-use policy), so use Pro for this business CRM, or ask Vercel Support whether an internal staging project qualifies; see `docs/STAGING_PLAN.md`. |
| 5 | Domain decision | — | Tell me the real domain; I replace `YOURDOMAIN.com` in this file. DNS change is ✋. |
| 6 | Meta app + WhatsApp test number | see `docs/WHATSAPP_INTEGRATION.md` §Test setup | 🔐 |

## 1. Configuration inventory

Never paste values in chat. Put them in Vercel (per environment) and your local `.env.local` only.

| Variable | Scope | Where to find it | Required for |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Supabase → Project Settings → API → Project URL | everything (checked at startup) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | Supabase → Project Settings → API → `anon` `public` key | everything (checked at startup) |
| `APP_URL` | server | the site URL, e.g. `https://crm-dev-xyz.vercel.app` (staging) | invites, password reset links (checked at startup) |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Supabase → API → `service_role` key | invites, webhook, send results, sign-in rate limits |
| `CRON_SECRET` | server only | generate: `openssl rand -hex 32` | manual job trigger routes (`/api/cron/*`) |
| `WHATSAPP_APP_SECRET` | server only | Meta app → App settings → Basic → App secret | webhook signature |
| `WHATSAPP_VERIFY_TOKEN` | server only | any long random string you choose | webhook handshake |
| `WHATSAPP_ACCESS_TOKEN` | server only | Meta Business Settings → System users → generate token | sending, media |
| `WHATSAPP_GRAPH_API_VERSION` | server | default `v26.0` | Graph API calls |

Rules: never prefix a server-only variable with `NEXT_PUBLIC_`. CI runs `scripts/check-client-bundle.mjs`, which fails the build if any server-only **value** or a `service_role` JWT appears in the browser bundle. The app validates the first three at startup and reports missing variables by **name only**; the others are checked when a feature first needs them (`/api/health` shows which groups are configured, without values).

Not needed in Vercel: database passwords, the JWT secret, `SEED_*` (local/staging seeding only).

## 2. GitHub

1. 🔐 Create a **private** repository (no README/license — the repo already has them).
2. Push (you, or me once access is granted):
   ```bash
   git add -A && git commit -m "Initial import"        # ✋ commits only when you ask
   git branch -M main
   git remote add origin git@github.com:<owner>/<repo>.git
   git push -u origin main
   ```
   `.gitignore` already excludes `.env*` (except `.env.example`), `.next`, test output and Supabase temp files. Verified: no secrets in tracked files.
3. Branch protection on `main` (Settings → Branches): require a pull request and these status checks from `.github/workflows/ci.yml`:
   * `DB tests (Postgres 16)`, `DB tests (Postgres 17)`
   * `Unit · typecheck · lint · build` (includes the migration safety check)
   * `API security · bundle scan · E2E (local Supabase)`
4. CI needs **no secrets**: it starts its own local Supabase with demo keys.

## 3. Supabase (staging first)

### 3.1 Project settings (dashboard)
* **Authentication → Sign In / Providers**: Email **enabled**; *Allow new users to sign up* **off** (invite-only); *Confirm email* on; minimum password length **10**.
* **Authentication → URL Configuration**: Site URL = `APP_URL`; Redirect URLs = `APP_URL/**` (staging: also `http://localhost:3000/**` if you test locally against it).
* **Authentication → Emails → Templates**: paste `supabase/templates/invite.html` into *Invite user* and `supabase/templates/recovery.html` into *Reset password* (subjects in `supabase/config.toml`). Their links go to `/auth/confirm?token_hash=…`; the default templates do not work with this flow.
* **Authentication → SMTP**: configure your own sender before inviting real users (the built-in sender is heavily rate-limited).
* **API → Exposed schemas**: keep `public` and `graphql_public` only. **Never expose `app`.**

### 3.2 Migrations (forward-only)
From a trusted machine with the Supabase CLI (`npx supabase`):
```bash
npx supabase login
npx supabase link --project-ref <crm-dev ref>
npm run check:migrations              # must pass: no unreviewed destructive statements
npx supabase db push --dry-run        # lists exactly which migrations would be applied
npx supabase db push                  # applies them in order
```
* All current migrations are additive (create/replace functions and policies, new tables, new indexes); none drops or rewrites data. `0870` creates the `pg_cron` extension and three jobs (§3.4). `0890` creates the private Storage buckets `whatsapp-media` and `attachments` (keep them private; add no Storage policies). Two statements replace objects that hold no data: `0920` replaces the `attachments_delete` policy (stricter), and `0930` drops and immediately recreates the stateless `report_whatsapp_response` function because its return columns change (marked `-- destructive-ok:`). Both run inside the migration's transaction. `0950` (automatic leads) replaces three functions (`ingest_whatsapp_message`, `guard_lead`, `after_lead_change`), relaxes `leads.created_by` to nullable for automatic leads only, and uses `ON DELETE SET NULL (column)` (PostgreSQL 15+; Supabase and the CI matrix are 15+). It changes no existing row. Its rollback is `supabase/rollbacks/20261021000950_auto_leads.rollback.sql` (see `docs/WHATSAPP_AUTO_LEADS.md`); run `npm run check:migrations` and the dry-run before applying it to any hosted project.
* **Production**: ✋ I will show you the dry-run output and wait for written approval before `db push` to `crm-prod`. Any future migration flagged by `check:migrations` gets a written justification and a backup first.
* **Never** run `supabase/tests/**` or the shim against a hosted project.

### 3.3 First super admin (once per project)
Invite yourself (Authentication → Users → Invite), accept the e-mail, then in the SQL editor:
```sql
update public.profiles set is_super_admin = true where email = 'you@yourdomain.com';
```
Everyone else is invited from inside the CRM (*Administration → Users & memberships*).

### 3.4 Scheduled jobs — Supabase-native (no paid plan, no external platform)
Migration `0870` schedules with `pg_cron` (runs inside the database as the owner — authenticated by construction, not callable by users):

| Job | Schedule | What it does |
|---|---|---|
| `crm-webhook-retries` | every 5 min | re-dispatches failed WhatsApp webhook events in SQL (≤ 8 attempts, `SKIP LOCKED`, idempotent) |
| `crm-task-reminders` | every 15 min | due/overdue task notifications (deduplicated) |
| `crm-retention` | daily 03:17 UTC | purges processed/dead intake rows (30 d), rate-limit windows, old job logs |

Every run is logged (`app.job_runs`); super admins see the last run, errors and 24 h counts at *Administration → System status*. Supabase also keeps `cron.job_run_details`. Verify after deploy:
```sql
select jobname, schedule, active from cron.job;                      -- 3 rows
select job, ok, details, started_at from app.job_runs order by id desc limit 5;
```
**Why not Vercel Cron:** Vercel Hobby runs crons at most once a day (sub-daily schedules need Pro, ~US$20/user/month), which is too slow for retries and reminders, and it adds an HTTP hop. The routes `/api/cron/whatsapp-retry` and `/api/cron/maintenance` remain as **manual/backup triggers** (header `Authorization: Bearer <CRON_SECRET>`), running the same SQL jobs.

### 3.5 Staging seed (optional, fictional data)
Lets you sign in as the seed roles on staging and run smoke tests. Refused unless all safeguards hold:
```bash
SEED_TARGET_PROJECT_REF=<crm-dev ref> \
SEED_DATABASE_URL='postgresql://postgres.<ref>:<db password>@<pooler host>:5432/postgres' \
SEED_PASSWORD='<a strong random password, ≥16 chars>' \
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service key> \
node scripts/seed-dev.ts
```
(Session pooler or direct connection; requires local `psql`.) The SQL refuses if any real company exists. **Never seed `crm-prod`.**

## 4. Vercel

1. 🔐 Import the GitHub repo. Framework: **Next.js** (auto). Node.js: **22.x** (Project Settings → General). Build command / output: defaults.
2. Function region (Settings → Functions): the region closest to your Supabase project (`fra1` for Frankfurt, `bom1` for Mumbai).
3. Environment variables (Settings → Environment Variables), per environment:
   * **Preview** → `crm-dev` values; **Production** → `crm-prod` values. `APP_URL` = that environment's URL.
4. Deploy. Then verify:
   ```bash
   curl https://<deployment>/api/health        # {"ok":true,"checks":{...}} — no values shown
   curl -I https://<deployment>/login          # CSP, HSTS, X-Frame-Options present
   ```
5. Rollback: Vercel → Deployments → *Promote* a previous build. Database changes stay backward compatible for one release.

## 5. Custom subdomain (Hostinger DNS) — WordPress-safe ✋

Prepared, not executed. Only after you give the real domain **and** approve:

1. In Vercel → Project → Settings → Domains, add `crm.YOURDOMAIN.com`. Vercel shows the **exact** record, normally `CNAME  crm  →  <value Vercel shows>`.
2. **Before any change**: export/screenshot the full current DNS zone.
3. In Hostinger → Domains → DNS: **add that one CNAME only**.
4. **Do not change**: the root `@` A/AAAA records, `www`, MX, SPF/DKIM/DMARC TXT records, or nameservers.
5. Wait for *Valid Configuration* (Vercel issues HTTPS automatically).
6. Verify: CRM loads over HTTPS; `https://YOURDOMAIN.com` and `www` still serve WordPress; send and receive one e-mail; compare the zone with the export from step 2.
7. Update Supabase Site URL / Redirect URLs and `APP_URL` to the new domain.

## 6. Smoke test (staging, then production)

1. `/api/health` → 200.
2. Sign in as super admin; create/inspect companies; invite one admin per company (check the e-mail arrives from your SMTP sender).
3. As a company admin, confirm other companies are invisible.
4. Lead → assign → log a call → complete a follow-up → convert → win; the dashboard shows it. (Automated: `E2E_BASE_URL=<staging URL> SEED_PASSWORD=<…> npm run test:e2e` against a seeded staging project only.)
5. `GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1` → 403.
6. WhatsApp test number end-to-end (see `docs/WHATSAPP_INTEGRATION.md`).
7. *System status* shows all three jobs ran successfully.
8. Production only: re-run the WordPress/e-mail checks from §5.6.

## 7. Backup and recovery

* **Prod**: Supabase daily backups (Pro) + PITR add-on. Weekly logical dump to storage you control: `pg_dump --format=custom "$DATABASE_URL" > crm-YYYYMMDD.dump`, encrypted.
* **Restore drill** (quarterly): restore the latest dump into `crm-dev` and run the smoke test.
* Migrations are forward-only. To undo a change, write a new migration.

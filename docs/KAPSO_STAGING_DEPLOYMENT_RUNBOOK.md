# Kapso Staging deployment — runbook (PREFLIGHT ONLY)

Status: **plan only, prepared 2026-11-05. Nothing in this document has been executed.** No database was connected to, no migration
applied, no project/deployment/webhook created, MGH not registered, no message sent, outbound not enabled.
Every command block below is marked **NOT EXECUTED**; each needs the gate named next to it.
Companion checklist: `docs/KAPSO_STAGING_READINESS.md`. Earlier general plans: `docs/DEPLOYMENT.md`, `docs/STAGING_PLAN.md` (Meta-centric;
this runbook adds the Kapso migrations 970–978 and the Kapso v2 webhook).

---

## 1. Executive summary

The code and the six proposed Kapso migrations are review-ready and scratch-validated, but **an actual Staging deployment is not possible
yet**. It is blocked on:

1. **No staging target exists / is identified** (Supabase project ref, Vercel project, HTTPS hostname, region, plan) — user input.
2. **Repository state:** all Kapso work is uncommitted (35 working-tree entries), there is no remote, and Vercel deploys from Git. A commit and
   push need explicit approval (`docs/DEPLOYMENT.md` §2).
3. **Migrations are not in `supabase/migrations/`.** 970–978 live in `supabase/migrations/`; `supabase db push` applies only
   `supabase/migrations/`. They must be promoted (copied with their names) in an approved commit — see §4.3.
4. **No admin path creates a Kapso PRODUCTION account.** `saveWhatsappAccount` inserts every Kapso account with `is_sandbox = true`, which the
   970 derive trigger turns into `environment = 'sandbox'` (and the sandbox guard then requires a sandbox company). A production-environment
   Kapso account (the shape MGH needs) can only be created by a reviewed service-role SQL statement (§8, step 8.9) or after a UI change.
5. **`pg_cron` availability on the hosted project is unverified.** Migration 0870 schedules the retry job only if `pg_cron` is available and
   otherwise skips it **silently**; without it, failed and crashed (stale `pending`) Kapso events are never retried (§9.3, stop condition).
6. Kapso provider facts still unconfirmed (BSUID field, origin values, `read` payload, Content-Type) — they do not block a fixture-based
   staging test, but they block claims about real traffic.

Order of work once unblocked: isolate → back up → promote migrations (commit) → dry-run → apply committed migrations + 970 → 972 → 975 → 976 →
977 → 978 → verify catalog against the scratch fingerprints → deploy app with `KAPSO_PROTOCOL=v2` → fixture tests → (much later, separately)
MGH receive-only onboarding.

---

## 2. Staging architecture and isolation requirements

| Layer | Staging requirement | Must be separate from |
|---|---|---|
| Database / Auth / Storage | A **new hosted Supabase project** (name suggested in `docs/STAGING_PLAN.md`: `crm-staging`), Postgres **17** (`supabase/config.toml` `major_version = 17`), ideally in its **own Supabase organization** | local dev stack (`supabase_db_crm-hub`, port 54332), the future production project, the scratch containers `kapso-rev6-scratch-*` |
| Extensions | `pg_trgm` (0800, created in schema `extensions`), **`pg_cron`** (0870, must be available — §9.3); `gen_random_uuid()` is core PG ≥13 | — |
| Storage | Supabase Storage enabled; 0890 creates two **private** buckets `whatsapp-media` (100 MiB) and `attachments` (25 MiB) | — |
| Application | A **new Vercel project** (Node 22.x, region close to the DB), env vars per §6, deployed from a staging branch | any production Vercel project |
| HTTPS hostname | Required for the webhook: `https://<STAGING_HOST>/api/webhooks/kapso`. Must be the project's **Production** deployment domain (Vercel *Standard Protection* shields preview deployments, which would block provider webhooks — `docs/STAGING_PLAN.md` §3) | — |
| Kapso | A **Kapso test/sandbox configuration** for staging with its **own webhook signing secret**; never the MGH number, never the production webhook | production Kapso webhook |
| Meta | Not needed for the Kapso test. Leave `WHATSAPP_*` **unset** in staging (§6): then no Graph API send is possible at all | — |
| Cron | Primary: `pg_cron` jobs from 0870 (`crm-webhook-retries` */5, `crm-task-reminders` */15, `crm-retention` daily). Backup: `GET /api/cron/whatsapp-retry` and `/api/cron/maintenance` with `Authorization: Bearer <CRON_SECRET>` | — |
| Data | Empty start; fictional companies/contacts only; company names prefixed `STAGING — ` (§12.6) | any real customer data |
| Access | Supabase Auth sign-ups **off**, invite-only; DB network restrictions on (allow the operator's IP for migrations only); dashboard members limited; `app` schema **not** exposed in the API | — |

---

## 3. Required inputs and missing information (never guessed)

| # | Input | Who | Status |
|---|---|---|---|
| I1 | Staging Supabase **project ref** and region (and organization) | user | **missing** |
| I2 | Supabase plan (Free: no backups, pauses after 1 week idle — a paused project drops webhooks) | user decision | **missing** |
| I3 | Vercel project name, plan (Hobby is non-commercial only), region | user | **missing** |
| I4 | Staging HTTPS hostname (`*.vercel.app` or a subdomain; DNS change needs separate approval) | user | **missing** |
| I5 | Git remote (private repo) and approval to commit/push the working tree, incl. promoting 970–978 into `supabase/migrations/` | user | **missing** |
| I6 | Kapso **staging** test number / phone_number_id and its webhook signing secret (entered by the user into Vercel; never in chat) | user + Kapso | **missing** |
| I7 | Confirmation that `pg_cron` is available on the project (checked at preflight, §5 P8) | operator at apply time | **unknown** |
| I8 | Decision on how the staging Kapso **production-environment** account is created (reviewed SQL, §8.9, or a UI change first) | user | **missing** |
| I9 | Operator machine with Supabase CLI, `psql` ≥ 17, `openssl`, network access to the project | user | **missing** |
| I10 | MGH: company, phone_number_id, connection mode (`coexistence` or `cloud_api`), Kapso project — **only for the later MGH phase** | user + Kapso | **missing** |

---

## 4. Migration order and dependencies

### 4.1 Chain (exact files)

Committed (already in `supabase/migrations/`, 27 files `20261019000100_core_schema.sql` … `20261021000960_kapso_sandbox.sql`) must be applied
first on an empty project. Then the proposed chain, **in this order**:

| Order | File | SHA-256 (prefix) | Depends on | Content |
|---|---|---|---|---|
| 1 | `20261104000970_kapso_production.sql` | `8421602174ee00b9` | all committed migrations (replaces 0960 bodies, uses 0960 objects) | Rev6 account model: 6 new `whatsapp_accounts` columns + backfill of Kapso rows + 9 constraints; `contact_identities` table (RLS); `conversations.customer_bsuid`, `customer_wa_id` nullable; `messages.provider_origin`; triggers (derive env, account lock, send guard); intake wrappers `ingest_kapso_inbound` / `apply_kapso_status_v2`; replaced `guard_conversation`, `merge_contacts`, `process_webhook_retries` |
| 2 | `20261104000972_kapso_bsuid_contact_lock_recheck.sql` | `08c97a235d26338a` | 970 | + `app.kapso_lock_conversation_contact`; replaced `app.kapso_resolve_conversation` |
| 3 | `20261104000975_kapso_sandbox_wamid_pair_check.sql` | `33cdca65162542b9` | 0960 (works with or without 970) | replaced `ingest_kapso_message` / `ingest_kapso_echo` (D1 pair check) |
| 4 | `20261104000976_update_whatsapp_account.sql` | `56ba684f8ac86aad` | none (useful with 970) | + `public.update_whatsapp_account` (5 s function-local lock timeout) |
| 5 | `20261104000977_kapso_contact_lock_order.sql` | `b26ce738d4f7dae9` | 970 **and** 972 | replaces the same two functions as 972 (sub-transaction lock release; missing conversation raises) — **revised version included** |
| 6 | `20261104000978_kapso_event_lifecycle.sql` | `89cb2e4dadaf925b` | 970 | + 5 lifecycle functions; replaced `process_webhook_retries` (stale-pending sweep; v2 kinds finish through `finish_kapso_event`) — **revision 2 + 3 included** |

Rollbacks (`supabase/rollbacks/`): `…970….rollback.sql` `c076f3b9824c8406`, `…972…` `200ec2973882b0ae`, `…975…` `086865c92e7684ff`,
`…976…` `0d5a3668fcbcf84f`, `…977…` `1b903de990fad26d`, `…978…` `14843b7ce3761dc8`. Verify these hashes before use (§5 P3).

### 4.2 Findings from the file inspection (not assumptions from the scratch tests)

* **Ordering constraints:** 977 must follow 972 (it replaces the 972 bodies); 978 must follow 970 (its retry body is the 970 body + edits).
  975 and 976 have no proposed prerequisite; keeping the numeric order is simplest and is the order every scratch test used.
* **External prerequisites:** none beyond the committed chain, `pg_cron` (for the job to exist), and a Supabase `service_role` / `auth.*`
  schema (all functions check `app.is_service_context()` and use `auth.uid()`).
* **Data-changing statements outside function bodies:** only 970 — one `UPDATE public.whatsapp_accounts SET environment='sandbox',
  connection_mode='sandbox' WHERE provider='kapso'` (justified `-- destructive-ok`, new columns only), `ALTER COLUMN environment DROP DEFAULT`,
  `DROP CONSTRAINT whatsapp_accounts_sandbox_chk` (replaced by stricter ones), `ALTER COLUMN customer_wa_id DROP NOT NULL`. New `CHECK`
  constraints can **fail on existing data** (e.g. `wa_accounts_pnid_shape_chk` is added `NOT VALID` then validated). On an empty staging
  project nothing can violate them. `npm run check:migrations`-equivalent scan of `supabase/mioposed`: **passed (6 files)**.
* **Destructive operations:** none in 972–978 (function/`create or replace` only). No table, column or index is dropped by any forward file.
* **Rollback data-loss implications:**
  * 970 rollback drops `contact_identities`, `conversations.customer_bsuid`, `messages.provider_origin` and the 6 account columns, **but first
    refuses** (`rollback.blocked: …` with counts) if any v2/quarantine webhook event is pending/failed, any Kapso production account,
    outbound-enabled account, BSUID identity, phone-less or BSUID conversation, `provider_origin` row or unconfirmed send exists. Once real
    Kapso production data exists, **970 cannot be rolled back — forward-fix only.**
  * 972, 975, 976, 977 rollbacks restore exact previous function bodies (976 drops its function); no data.
  * 978 rollback drops its 5 functions and restores the 970 retry body; rows remain valid. **After rolling back 978, `KAPSO_PROTOCOL` must be
    `v1`** (v2 RPCs gone → the webhook answers 503).
* **Rollback order:** strictly reverse — 978 → 977 → 976 → 975 → 972 → 970. Rolling back 970 while 978 is present would leave 978 bodies
  referencing dropped columns; rolling back 972 while 977 is present would discard 977 silently.
* **Migration history in the target:** unknown until the project exists. Checked at preflight with `supabase migration list` (§5 P5). An
  empty project must show none applied; anything else is a stop.
* **Line endings:** `.gitattributes` pins `*.sql text eol=lf`, so function bodies deploy byte-identical (fingerprints in §9.1 hold).

### 4.3 How the proposed files get applied (decision needed — I5)

**Recommended:** in one approved commit, copy the six forward files **unchanged and with the same names** from `supabase/migrations/` to
`supabase/migrations/` (rollbacks stay in `supabase/rollbacks/`). Then `supabase db push` applies them in order and records them in
`supabase_migrations.schema_migrations`, so history and files never drift.
Side effects to accept knowingly: CI and any `supabase start` / `db reset` **on a developer machine** will apply them to that machine's local
database too (the local development stack must not be reset without the owner's approval); `supabase/tests/db/19_kapso_sandbox.sql` already
handles the Rev6 schema (711 checks passed on scratch).
**Not recommended:** applying the files with `psql -f` — it bypasses the migration history; a later `db push` would try to apply them again.

---

## 5. Preflight checks (all read-only; NOT EXECUTED)

| # | Check | Pass criterion | Stop if |
|---|---|---|---|
| P1 | Target identity | `supabase projects list` shows the staging ref (I1), its name/org are the staging ones; the linked ref in `supabase/.temp/project-ref` equals I1 | any other ref, or a production/dev name |
| P2 | Not local / not scratch | the DB host is the hosted staging host, never `127.0.0.1:54332` (local dev) or `127.0.0.1:54399` (scratch) | host is loopback or unknown |
| P3 | File integrity | SHA-256 of the 6 forward + 6 rollback files equal §4.1 | any mismatch |
| P4 | Migration safety | `npm run check:migrations` passes (after promotion: 33 files) | any finding |
| P5 | History | `supabase migration list` on an empty project lists **0 remote** migrations | anything already applied that is not expected |
| P6 | Dry run | `supabase db push --dry-run` lists exactly the 27 committed + 6 promoted files, in order, and nothing else | extra/missing/out-of-order file |
| P7 | Postgres version | `select version()` → 17.x | < 17 (CI covers 16 for the committed chain only) |
| P8 | `pg_cron` | `select name from pg_available_extensions where name='pg_cron'` returns 1 row | 0 rows → decide the fallback (external scheduler on `/api/cron/whatsapp-retry`) **before** applying |
| P9 | Backup | §7 completed and the dump files are readable | no backup |
| P10 | Repository | the commit being deployed is the reviewed one (`git rev-parse HEAD` recorded); working tree clean | uncommitted changes |

```bash
# NOT EXECUTED — gate: I1, I5, I9 provided; operator machine; staging only
npx supabase login
npx supabase link --project-ref "$STAGING_REF"          # P1: must be the staging ref, never another
cat supabase/.temp/project-ref                           # P1
sha256sum supabase/migrations/2026110400097*.sql supabase/rollbacks/2026110400097*.sql   # P3
npm run check:migrations                                 # P4
npx supabase migration list                              # P5
npx supabase db push --dry-run                           # P6 — show the output to the owner and wait for approval
```

---

## 6. Environment variable matrix (names only — never print values)

Source of truth: `src/env.ts` (`publicSchema`, `serverSchemas`), `src/server/env.ts` (groups validated lazily), `src/instrumentation.ts`
(checks `public` + `core` at boot), `src/app/api/health/route.ts`.

| Variable | Group | Required for staging | Purpose | Server-only | Secret | Staging value | May stay unset |
|---|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | **yes** (boot) | Supabase API URL | no | no | staging project URL | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | **yes** (boot) | anon key (RLS protects data) | no | no (public by design) | staging anon key | no |
| `APP_URL` | core | **yes** (boot) | invite / reset links | yes | no | `https://<STAGING_HOST>` | no |
| `SUPABASE_SERVICE_ROLE_KEY` | serviceRole | **yes** | webhook intake, cron routes, invites | **yes** | **yes** (mark *Sensitive*) | staging service key — never a production key | no (webhook answers 503) |
| `CRON_SECRET` | cron | **yes** | `Authorization: Bearer` for `/api/cron/*` (constant-time check; ≥16 chars) | yes | **yes** | new random ≥32 bytes, staging-only | yes only if `pg_cron` works and manual triggers are not wanted (routes then answer 401 to everyone) |
| `KAPSO_WEBHOOK_SECRET` | kapso | **yes** | HMAC-SHA256 key for `X-Webhook-Signature` (≥16 chars) | yes | **yes** | the **staging** Kapso webhook's secret (or a throw-away value for fixture-only tests) | no (webhook answers 503 "not configured") |
| `KAPSO_PROTOCOL` | kapso | **yes, explicit** | `v1` (default) = 0960 sandbox path; `v2` = Rev6 path. Production-environment accounts are quarantined (`protocol.v2_required`) unless `v2` | yes | no | **`v2`** (requires 970–978) | must not be left unset for production-environment accounts; any other value fails closed (503) |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` | whatsapp | no (Kapso test) | Meta Cloud API webhook + sending | yes | **yes** | **leave unset** for the Kapso staging test | yes — then the Meta webhook is unconfigured and **no Graph API send is possible** (outbound defence in depth); `/api/health` shows `whatsapp_configured: false` |
| `WHATSAPP_GRAPH_API_VERSION` | whatsapp | no | Graph version (default `v26.0`) | yes | no | unset | yes |
| `SEED_*`, `E2E_BASE_URL`, `SUPABASE_ACCESS_TOKEN`, DB password | operator machine only | optional | seeding / CLI | n/a | DB password + tokens: **yes** | operator shell only, never Vercel, never committed | yes |
| `KAPSO_SCRATCH_DB`, `KAPSO_TEST_BASE_URL` | tests only | never in staging | scratch / loopback tests | — | no | **unset** | yes |

Not controlled by any environment variable: **outbound** (DB column `whatsapp_accounts.outbound_enabled`, default `false`, plus trigger
`messages_kapso_send_guard`) and **account resolution** (DB: unique `phone_number_id` → account → company; request bodies are never read for it).
Gaps noticed (not changed in this task): `.env.example` does not list `KAPSO_PROTOCOL`; `/api/health` does not report Kapso configuration
(use the unsigned-POST probe in §10, T0).

---

## 7. Backup and recovery plan

* Staging starts empty, but take the backup anyway (it proves the procedure and captures the pre-migration catalog).
* Free plan has **no automatic backups**; Pro has daily backups (7 days). Either way, take manual dumps **before each migration batch**, store
  them **outside the repository**, encrypted, and record their SHA-256.

```bash
# NOT EXECUTED — gate: P1–P8 passed
npx supabase db dump --linked -f "$BACKUP_DIR/staging-schema-$(date -u +%Y%m%dT%H%MZ).sql"
npx supabase db dump --linked --data-only -f "$BACKUP_DIR/staging-data-$(date -u +%Y%m%dT%H%MZ).sql"
npx supabase migration list > "$BACKUP_DIR/staging-migration-list-before.txt"
sha256sum "$BACKUP_DIR"/staging-*
```

Recovery options, in order of preference: (1) app-only problem → Vercel *Instant Rollback*; (2) one proposed migration misbehaves and no
blocking data exists → its rollback file (reverse order, §12); (3) staging only, with explicit approval and a reference check → restore the
dump into a fresh project, or delete and re-create the staging project (it holds only fictional data).

---

## 8. Migration execution plan (NOT EXECUTED — gate: owner approved the P6 dry-run output, backup taken)

General rules for every step: one migration at a time is preferred over one big push (so a failure is attributable); the Supabase CLI
applies each migration file in its own transaction (confirm with the CLI version in use; if not, stop and use a single-transaction method);
after every step run its verification (§9) and stop on the first deviation.

| Step | File | Preconditions | Expected changes | Post-check (§9) | On failure | Rollback safe? / file |
|---|---|---|---|---|---|---|
| 8.1 | 27 committed migrations | P1–P10 | full CRM schema, RLS, `pg_trgm`, `pg_cron` + 3 jobs (if available), 2 private buckets | V1–V3 | stop; the file's transaction rolled back; fix forward or re-create the empty project | forward-only; 0950/0960 have rollbacks in `supabase/rollbacks/` |
| 8.2 | `20261104000970_kapso_production.sql` | 8.1 verified; no Kapso rows yet | §4.1 row 1 | V4 | stop; inspect error; nothing else applied | yes while no Kapso v2 data exists (refuses otherwise) — `rollbacks/20261104000970_kapso_production.rollback.sql` |
| 8.3 | `20261104000972_kapso_bsuid_contact_lock_recheck.sql` | 970 present | helper + resolver | V5 | stop | yes (function bodies) — `…972….rollback.sql` |
| 8.4 | `20261104000975_kapso_sandbox_wamid_pair_check.sql` | 0960 present | two sandbox wrappers | V5 | stop | yes — `…975….rollback.sql` |
| 8.5 | `20261104000976_update_whatsapp_account.sql` | — | 1 function | V5 | stop | yes (drops it; admin falls back to the plain update) — `…976….rollback.sql` |
| 8.6 | `20261104000977_kapso_contact_lock_order.sql` | 972 present | 2 functions replaced | V5 | stop | yes, restores 972 bodies — `…977….rollback.sql` |
| 8.7 | `20261104000978_kapso_event_lifecycle.sql` | 970 present | 5 functions + retry body | V5, V6 | stop | yes; afterwards `KAPSO_PROTOCOL=v1` — `…978….rollback.sql` |
| 8.8 | app deploy | 8.1–8.7 verified | Vercel build with §6 vars, `KAPSO_PROTOCOL=v2` | §10 T0 | Instant Rollback | yes |
| 8.9 | staging Kapso account | I6, I8 | one fictional company + one Kapso account | V7 | delete the row (no conversations yet) | yes |

```bash
# NOT EXECUTED — gate: dry-run approved. With the promoted files in supabase/migrations, db push applies the pending ones in order.
npx supabase db push            # applies 27 committed + 970, 972, 975, 976, 977, 978 (or push after each promotion step to go one by one)
npx supabase migration list > "$BACKUP_DIR/staging-migration-list-after.txt"
```

Step 8.9 — creating a staging Kapso **production-environment** account (the admin UI cannot, see §1 item 4). Reviewed SQL, run in the SQL editor
of the **staging** project only, after the owner approves the exact values (placeholders stay placeholders until then):

```sql
-- NOT EXECUTED — staging only; values supplied by the owner (I6, I8). outbound_enabled is NOT set: it stays at its default false.
insert into public.companies (name, slug) values ('STAGING — Kapso test', 'staging-kapso-test') returning id;   -- fictional company
insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status)
values ('<company id from above>', 'STAGING Kapso test', '<+E164 of the staging test number>', '<staging Kapso phone_number_id>',
        'kapso', 'production', '<coexistence|cloud_api>', 'test');
```

---

## 9. Post-migration verification (read-only SQL; NOT EXECUTED)

### 9.1 Catalog fingerprints — staging must equal the verified scratch build
Compute `md5(prosrc)` on staging and compare with the values captured from the scratch database built from the same files
(`kapso_p10_new_scratch`, 176 functions in `app`/`public`, 73 triggers):

| Function | md5(prosrc) |
|---|---|
| `public.process_webhook_retries` | `bda72516b548b29a0e6a51b1b29d2159` |
| `public.claim_kapso_event` | `f6fbc26cd741f889efcd091f40bcb60a` |
| `public.finish_kapso_event` | `73c2d521865aa0f9951fcb9c57fb60c1` |
| `public.record_kapso_held_event` | `f9f696ad74375b92adecf4f733269ca5` |
| `public.kapso_account_protocol` | `2b94d1a024b25d17b009c1566858721e` |
| `public.list_kapso_quarantined` | `6f27048c136e46399ef7be1eddfc75ae` |
| `public.ingest_kapso_inbound` | `6c5238803bf0258bbda1013452f3a295` |
| `public.apply_kapso_status_v2` | `b5201d70c43ae10a1a2f941e72453e5e` |
| `public.ingest_kapso_message` | `8071b9d093f8fa56ec191972ee63f01d` |
| `public.ingest_kapso_echo` | `5e32e57ae5ac3f2db30c0f8b9a0d32ed` |
| `app.kapso_resolve_account` | `5dd262361b02c34b8fdeda8fa3fa690d` |
| `app.kapso_resolve_conversation` | `f6f45184d14705bb7a9ddd2e51434590` |
| `app.kapso_lock_conversation_contact` | `1cf3f59255ce36d899af99acac16255c` |
| `public.merge_contacts` | `ab18ec6f1aefc0d53aa716e46a85a599` |
| `public.update_whatsapp_account` | `e393c9a92bb6e5b212eb713b63808603` |

```sql
-- NOT EXECUTED
-- V1 RLS on every public table, nothing for anon
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;  -- expect 0 rows
select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public';                                       -- expect 0
-- V2 jobs and buckets
select jobname, schedule, active from cron.job order by 1;                       -- expect crm-retention, crm-task-reminders, crm-webhook-retries (active)
select id, public from storage.buckets order by 1;                               -- attachments=false, whatsapp-media=false
-- V3 extensions
select extname from pg_extension where extname in ('pg_trgm','pg_cron');          -- expect both
-- V4 (970) account model, constraints, triggers, outbound off
select column_name from information_schema.columns where table_name='whatsapp_accounts'
 and column_name in ('environment','connection_mode','outbound_enabled','connection_state','connection_state_at','last_inbound_event_at');  -- 6
select conname from pg_constraint where conrelid='public.whatsapp_accounts'::regclass and conname like 'wa_accounts_%' order by 1;            -- 9
select tgname from pg_trigger where tgname in ('whatsapp_accounts_a_derive_env','conversations_a_account_lock','messages_kapso_send_guard');  -- 3
select relrowsecurity from pg_class where oid='public.contact_identities'::regclass;                                                          -- true
select count(*) from public.whatsapp_accounts where outbound_enabled;                                                                         -- 0
-- V5 fingerprints (compare with the table above) and privileges of the Kapso functions
select n.nspname||'.'||p.proname, md5(p.prosrc), p.prosecdef, p.proconfig, p.proacl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('process_webhook_retries','claim_kapso_event','finish_kapso_event','record_kapso_held_event','kapso_account_protocol',
  'list_kapso_quarantined','ingest_kapso_inbound','apply_kapso_status_v2','ingest_kapso_message','ingest_kapso_echo','kapso_resolve_account',
  'kapso_resolve_conversation','kapso_lock_conversation_contact','merge_contacts','update_whatsapp_account') order by 1;
-- expect: md5 as in 9.1; prosecdef true (except update_whatsapp_account: invoker); proconfig search_path=""; no EXECUTE for anon/authenticated
select has_function_privilege('authenticated','public.record_kapso_held_event(text,text,text,jsonb,text,text)','execute'),
       has_function_privilege('anon','public.claim_kapso_event(text,text,text,jsonb)','execute');                                             -- false, false
-- V6 (978) retry job wiring
select prosrc like '%public.finish_kapso_event(e.event_key, case when v_ok%' from pg_proc where proname='process_webhook_retries';           -- true
-- V7 (8.9) the staging account
select provider, environment, connection_mode, outbound_enabled, status, public.kapso_account_protocol(phone_number_id)
from public.whatsapp_accounts where provider='kapso';                                                                                         -- kapso|production|…|false|test|production
```

### 9.2 Event lifecycle, isolation, retry and quarantine
Verified by fixtures in §10 (T1–T14) plus the read-only queries listed there. The deterministic concurrency suites (`scripts/db/concurrency/t1–t7`)
**cannot and must not run on staging**: `lib.sh` refuses any database whose name lacks `scratch`/`disposable`/`throwaway` and needs a
superuser on a separate client container. Their evidence comes from the scratch runs (`KAPSO_REMEDIATION_REPORT.md`, revisions 2–3).

### 9.3 Stop condition for cron
If V2 shows no `crm-webhook-retries` job: **stop before any webhook test**. Either enable `pg_cron` (if offered by the plan) and re-run the
schedule block of 0870 through a reviewed migration, or approve an external scheduler calling `GET /api/cron/whatsapp-retry` every 5 minutes
with the bearer secret. Without one of them failed/crashed Kapso events are never retried.

---

## 10. Staging test plan (no real WhatsApp message is sent)

**L** = local fixture, signed by the operator with the staging `KAPSO_WEBHOOK_SECRET` (never printed); **K** = needs a real Kapso provider delivery.
Fixtures reuse the shapes in `tests/unit/kapso-lifecycle.test.ts` / `tests/scratch/kapso-v2-db.test.ts`, with the staging account's
phone_number_id, fictional numbers (e.g. `+20100…`) and fresh `wamid.STG.<n>` ids.

```bash
# NOT EXECUTED — helper for every L test. The secret is read from the operator's environment, never echoed or logged.
post() {  # post <fixture.json> <event-name>
  sig=$(openssl dgst -sha256 -hmac "$KAPSO_WEBHOOK_SECRET" -hex < "$1" | sed 's/^.*= //')
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://$STAGING_HOST/api/webhooks/kapso" \
    -H 'Content-Type: application/json' -H "X-Webhook-Event: $2" -H 'X-Webhook-Payload-Version: v2' \
    -H "X-Webhook-Signature: $sig" --data-binary @"$1"
}
```

| # | Test | Kind | Expected HTTP | Expected database state (read-only check) |
|---|---|---|---|---|
| T0 | Config probe: unsigned POST | L | **401** (proves the secret and protocol parse; 503 = not configured → stop) | nothing stored |
| T1 | Invalid / malformed signatures (wrong secret, 63 hex, `sha256=` prefix, missing) | L | 401 each | nothing stored |
| T2 | Oversized body (> 2 MiB), non-JSON `Content-Type` | L | 413, 415 | nothing stored |
| T3 | Malformed payloads: invalid JSON, `payload_version: v1`, unsupported event | L | 200 | one `kapso:invalid_payload:<sha256>` row each, `failed`, kind `kapso_quarantined`, no content |
| T4 | Valid v2 inbound | L | 200 | 1 contact, 1 conversation in the account's company, 1 message, 1 lead; event `processed`, payload `{}` |
| T5 | Duplicate delivery of T4 (same bytes) | L | 200 | no new rows; event unchanged |
| T6 | Mixed batch: 1 valid + missing_message + invalid phone_number_id + direction mismatch + invalid timestamp | L | 200 | 1 processed + 4 quarantine rows with `invalid.*` reasons; redelivery adds nothing |
| T7 | Unknown origin / echo origin on inbound | L | 200 | quarantined `origin.unknown` / `origin.direction_conflict`; no conversation |
| T8 | BSUID-only (no phone) | L | 200 | quarantined `invalid.missing_customer_identity` with `rawItem`; **no contact/conversation; BSUID support not claimed** |
| T9 | Unknown phone_number_id | L | 200 | event `failed` `kapso.unknown_account`; no data |
| T10 | Retry after transient failure: T9's event after the account is created (8.9-style) — wait ≤ 5 min | L | — | retry job processes it (`processed`, attempts 2) |
| T11 | Crash recovery / concurrent webhook + retry worker / terminal-state protection | **scratch only** | — | proven on scratch (t7 97/97); on staging observe only: no row returns from `processed`/`ignored` to `failed`/`pending` (query below) |
| T12 | Account/company isolation: body with foreign `company_id` / `whatsapp_account_id` | L | 200 | conversation only in the account's company |
| T13 | Cron auth: `GET /api/cron/whatsapp-retry` without / wrong / correct bearer | L | 401 / 401 / 200 `{ok:true,…}` | job run logged in `app.job_runs` |
| T14 | Outbound disabled: send from the UI in the T4 conversation | L | UI error `whatsapp.outbound_disabled` | no outbound message row; no provider call (`WHATSAPP_ACCESS_TOKEN` unset) |
| T15 | Real provider delivery: one message from a test phone to the **staging** Kapso number | **K** | 200 | as T4; origin recorded; confirms payload fields |
| T16 | Real `sent`/`delivered`/`read` statuses, real echoes (business_app) | **K** | 200 | echo `sent_by NULL`; `read` shape confirmed |
| T17 | Real BSUID-only customer | **K** | 200 | stays quarantined until the field is confirmed and `KAPSO_BSUID_PATHS` is filled |

```sql
-- NOT EXECUTED — observation queries for T3–T13
select status, payload->>'kind' kind, last_error, count(*) from public.whatsapp_webhook_events group by 1,2,3 order by 1,2,3;
select event_key, status, attempts, last_error from public.whatsapp_webhook_events where status in ('pending','failed') order by received_at;
select job, ok, details, started_at from app.job_runs order by id desc limit 5;
select count(*) from public.messages where direction='outbound' and sent_by is not null;   -- T14: 0
```

---

## 11. MGH Receive-only onboarding checklist (later phase — production project, NOT staging; nothing done)

1. Staging go criteria (§13) all met and signed off.
2. Production project has 970–978 applied by the same procedure (backup, dry-run approval, fingerprints §9.1).
3. MGH company exists in production; its id confirmed by the owner; MGH account row created with the reviewed SQL of §8.9 (production
   company, `provider='kapso'`, `environment='production'`, `connection_mode` as confirmed by Kapso, `status='test'` first);
   `kapso_account_protocol(<pnid>) = 'production'`; `outbound_enabled = false`.
4. Kapso phone_number_id confirmed by Kapso and unique (`phone_number_id` is UNIQUE).
5. Production deployment has `KAPSO_PROTOCOL=v2` (explicit) and the production webhook secret (entered by the owner).
6. Webhook endpoint `https://<PROD_HOST>/api/webhooks/kapso` served by the production deployment (not a preview).
7. Kapso delivery configuration: events `whatsapp.message.received/sent/delivered/read/failed`, payload version v2, the signing secret.
8. Webhook verification: unsigned POST → 401; one signed fixture to a throw-away key in staging only — **never** a fixture into production.
9. First inbound message: one test message from an approved phone → contact, conversation in MGH's company, lead; event `processed`.
10. Duplicate delivery: Kapso redelivery (or resend from the Kapso dashboard if offered) → no second message.
11. Monitoring for 7 days: quarantine counts by reason, failed events and attempts, `app.job_runs` health, no `rollback.blocked`-type surprises.
12. Confirmation that no outbound message was sent: query T14 = 0, no `queued` outbound rows, Kapso dashboard shows no API sends from the CRM.

Stop at any step that deviates; MGH stays receive-only until a separate outbound phase is designed and approved.

---

## 12. Rollback strategy and operational safety

1. **Application:** Vercel Instant Rollback (no DB change).
2. **Migrations:** reverse order only (978 → 977 → 976 → 975 → 972 → 970), each after a fresh dump; 970 refuses once v2 data exists →
   forward-fix. After 978 rollback set `KAPSO_PROTOCOL=v1`.
3. **Outbound off:** `select count(*) from whatsapp_accounts where outbound_enabled` = 0 at every stage; trigger `messages_kapso_send_guard`
   present; `WHATSAPP_ACCESS_TOKEN` unset in staging (no Graph send possible); no Kapso outbound client exists in the code.
4. **Retry jobs cannot send:** `process_webhook_retries` calls intake functions only (scratch check T-LC-4j: no send/HTTP call in its body);
   re-verify with V6 and `select prosrc ~* 'queue_outbound|http_(get|post)|net\.http' from pg_proc where proname='process_webhook_retries'` → false.
5. **Cron cannot run unauthenticated:** T13; the routes answer 401 when `CRON_SECRET` is unset.
6. **Logs:** review Vercel function logs for `[kapso-webhook]` lines after T3–T9: counters, codes and origin names only — no body text, phone,
   wamid, phone_number_id, signature or secret (unit-tested; re-check on staging).
7. **Staging vs production confusion:** separate organization/project/Vercel project; `APP_URL` staging host; staging-only secrets;
   `STAGING — ` company prefix; a staging Kapso number only; the CLI is linked only to the staging ref (P1) and unlinked afterwards.

---

## 13. Stop / go criteria

| Stage | Go when | Stop when |
|---|---|---|
| A. Inputs | I1–I9 provided | any missing |
| B. Preflight | P1–P10 pass | any fails |
| C. Backup | dumps exist, hashes recorded | dump fails |
| D. Dry run | owner approved the exact list | unexpected file / order |
| E. Apply 8.1–8.7 | each step's verification passes | first error or deviation (do not continue) |
| F. Fingerprints | all 15 md5 equal §9.1; grants as expected | any mismatch |
| G. Cron | `crm-webhook-retries` active, or approved fallback | neither |
| H. App | `/api/health` ok; T0 = 401 | 503 or 5xx |
| I. Fixture tests | T1–T14 as expected | any unexpected HTTP code, any lost/duplicated row, any outbound row |
| J. Provider tests | T15–T16 as expected; payload facts recorded | any unknown origin ingested, any send |
| K. MGH | §11 complete with sign-off | any deviation |

---

## 14. Commands to be executed later — consolidated (ALL NOT EXECUTED)

```bash
# NOT EXECUTED — Gate I5: promote the proposed forward files (repository change, then commit/push with approval)
cp supabase/migrations/20261104000970_kapso_production.sql supabase/migrations/20261104000972_kapso_bsuid_contact_lock_recheck.sql \
   supabase/migrations/20261104000975_kapso_sandbox_wamid_pair_check.sql supabase/migrations/20261104000976_update_whatsapp_account.sql \
   supabase/migrations/20261104000977_kapso_contact_lock_order.sql supabase/migrations/20261104000978_kapso_event_lifecycle.sql supabase/migrations/
npm run check:migrations
# NOT EXECUTED — Gates A–D (staging only)
npx supabase link --project-ref "$STAGING_REF"
npx supabase migration list
npx supabase db dump --linked -f "$BACKUP_DIR/staging-schema-before.sql"
npx supabase db dump --linked --data-only -f "$BACKUP_DIR/staging-data-before.sql"
npx supabase db push --dry-run
# NOT EXECUTED — Gate E (after written approval of the dry-run output)
npx supabase db push
npx supabase migration list
# NOT EXECUTED — Gate H
curl -sS "https://$STAGING_HOST/api/health"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://$STAGING_HOST/api/webhooks/kapso" -H 'Content-Type: application/json' --data '{}'   # expect 401
curl -sS -o /dev/null -w '%{http_code}\n' "https://$STAGING_HOST/api/cron/whatsapp-retry"                                                    # expect 401
# NOT EXECUTED — rollback (reverse order, one file at a time, staging only, after a fresh dump and approval)
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -1 -f supabase/rollbacks/20261104000978_kapso_event_lifecycle.rollback.sql
# ... 977, 976, 975, 972, 970 in that order; 970 refuses if v2 data exists
npx supabase unlink
```

SQL blocks: §8 step 8.9, §9.1 V1–V7, §10 observation queries — all NOT EXECUTED.

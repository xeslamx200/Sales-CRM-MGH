# Testing

## Suites

| Suite | Command | Status (21 Oct 2026) |
|---|---|---|
| Database: schema, RLS, rules, RPCs, reports, search, import, rate limits, RLS equivalence, security review, scheduled jobs, WhatsApp media/templates, pipelines, audit, attachments, business hours, automatic leads, Kapso sandbox | `npm run test:db` (`./scripts/db/test.sh`) | **708 checks, 19 files, passing** on PostgreSQL 16 and 17 |
| Unit: phone, WhatsApp signature/parser/processor/client/Graph helpers, Kapso signature/parser/processor, CSV, import validation, periods, time zones, env validation, errors, formatting, attachments | `npm run test:unit` | **100 tests, passing** |
| Direct API security and parallel ingestion (real JWTs against local PostgREST/RPC/GraphQL/Storage); runs its files one at a time | `npm run test:api` | **51 tests, passing** (22 are Kapso; its HTTP tests need a loopback server, see `docs/KAPSO_SANDBOX.md` §8) |
| Typecheck · lint · production build | `npm run typecheck` · `npm run lint` · `npm run build` | passing |
| Migration safety (destructive statements need a `-- destructive-ok:` note) | `npm run check:migrations` | passing (27 files) |
| Client bundle: no server secret values, names or service_role JWTs | `npm run check:bundle` (after a build) | passing (5 secret values checked; refuses to run without them) |
| End-to-end (Playwright): 8 scenarios in 6 specs | `npm run test:e2e` | **14 passing** on the production build (loopback server) |
| CI (GitHub Actions) | `.github/workflows/ci.yml` | written; first run once the repository exists |

## Database tests

`scripts/db/test.sh` rebuilds a local PostgreSQL database. It loads a small Supabase emulation (`supabase/tests/shim`: the `auth` schema, the `anon`/`authenticated`/`service_role` roles and Supabase's default grants), then applies every migration in order, then a fixture of three companies and eleven users, and runs each `supabase/tests/db/NN_*.sql` file in its own transaction that ends in `ROLLBACK`.

Tests log in exactly as Supabase does per request: they set the JWT claims and `SET ROLE authenticated`. RLS and triggers therefore run for real.

```bash
# a local Postgres on port 54322 (any method), then:
./scripts/db/test.sh              # all files
./scripts/db/test.sh 04           # files matching "04"
VERBOSE=1 ./scripts/db/test.sh    # list every check
```

The script refuses to run against a non-local host. Array comparisons in tests use `COLLATE "C"` so results don't depend on the server's locale (this differed between a `C` cluster and the `en_US` Docker image).

The same migrations are also applied by `supabase start` on Supabase's own Postgres 17 image, which the end-to-end tests use. To run the DB suite on a plain Postgres 17 locally:

```bash
docker run -d --rm --name crm-pg17-test -e POSTGRES_HOST_AUTH_METHOD=trust -p 54342:5432 postgres:17
PGHOST=localhost PGPORT=54342 PGUSER=postgres ./scripts/db/test.sh
docker stop crm-pg17-test
```

| File | Covers |
|---|---|
| `10_security_review.sql` | Session 3 findings: contact merge authorization, forged login events, target-actual scope, former employees, read-only claims, dead-letter retention |
| `11_scheduled_jobs.sql` | pg_cron jobs: retries (idempotent, `SKIP LOCKED`), reminders, retention, run log |
| `12_conversation_features.sql` | Moving a conversation to another company (reason, permissions, owner cleanup) |
| `13_whatsapp_media_templates.sql` | Outbound media paths, approved templates and parameter counts, credential health alerts |
| `14_pipeline_admin.sql` | Pipeline creation, stage reorder, default switching, and the `0910` integrity guards |
| `15_audit_viewer.sql` | Who reads which audit rows (company admins, managers, outsiders, deactivated admins) |
| `16_attachments.sql` | Attachment insert rules (path, type, company), visibility, immutability, delete rights |
| `17_business_hours.sql` | Hours/holiday permissions, exact business-seconds values (split shifts, weekends, holidays, DST) and report columns |
| `19_kapso_sandbox.sql` | Kapso Sandbox: sandbox company/account/provider guards, wrapper ownership checks (Meta id, foreign wamid, disabled/pending), intake and duplicates, shared contacts, status flows and races, retry dispatch, send block, flag forgery, boundary, invariants, and the **differential metrics proof** (every report function × 7 callers × 4 companies, before/after full sandbox activity, with non-vacuity controls) plus a tripwire of the 45 functions that read business tables |
| `18_auto_leads.sql` | Automatic WhatsApp leads: first/later/duplicate messages, no-name customers, offering matching (one/several/none/inactive/other company/regex), interest vs status, ownership sync, two numbers and two companies, closed/lost/converted/archived leads, historical conversations (no backfill), creator rules, manual path, retry recovery from an injected failure, employee attribution, reports |

### `09_rls_equivalence.sql`

Migration `0820` rewrote the hottest RLS policies for performance. This file builds a matrix of ownership/team/link edge cases and, for each of the 11 fixture users, compares the rows visible under the new policies with the rows the original predicate functions allow — for leads, deals, tasks, activities, contacts and contact links (66 set comparisons).

### Coverage of the brief's §19 scenarios

| # | Scenario | Where |
|---|---|---|
| 1 | Super Admin can access all companies | `01_tenancy_isolation.sql` |
| 2 | Company Admin cannot access unauthorized companies | `01`, `02`, `05`, `07` |
| 3 | Agent cannot access another agent's leads | `01`, `07`, `09`, e2e |
| 4 | Shared contacts don't expose unrelated records | `01`, `07` |
| 5 | Reassignment preserves the original creator | `03_sales_workflows.sql` |
| 6 | Task completion updates performance accurately | `05_reporting.sql`, e2e |
| 7 | Duplicate webhook events don't duplicate messages | `04`, `06`, unit, local webhook exercise |
| 8 | Failed outbound messages are handled safely | `04`, unit, inbox browser test |
| 9 | Revenue and conversion follow documented rules | `05` (exact values, time-zone boundaries) |
| 10 | Unauthenticated users can't access protected data | `01`, `07`, `08`, proxy redirect |

## Unit tests

Plain Node test runner (`node --test`) with native TypeScript type-stripping (Node ≥ 22.18). Modules under `src/lib` are pure and use explicit `.ts` import extensions so the same files run under Node and Next.js.

## Direct API security tests

`tests/api/security.test.ts` signs in as fictional seed users and calls PostgREST, RPCs, GraphQL and Storage directly — what an attacker with a valid employee account (or none) could do without the UI. It covers cross-company reads, privilege escalation, service-only functions, deactivated accounts, private buckets (no listing, download, signing or upload with a user token), forged attachment rows, and admin-only settings. Every test asserts it is not vacuous (that the data it relies on exists). It refuses to run against a non-local Supabase.

`tests/api/kapso.test.ts` (Kapso Sandbox): 20 parallel deliveries of one message, parallel messages from a new customer, racing status events, provider/account/company refusals, visibility by membership, the metrics-unchanged proof as real users, and (against a loopback server with a throw-away secret) signatures, versions, size limits, all five events, retries, batches, parallel posts, forged routing fields, and recovery by the retry job.

`tests/api/auto-leads.test.ts` sends genuinely parallel webhook ingestion requests (separate HTTP calls, separate transactions): 12 identical deliveries, 12 different messages from a new customer, parallel messages on two numbers of one company, and the race at the lead step with an existing contact and two lead-less conversations. That last test was checked by mutation: with the advisory lock removed it fails (duplicate open leads); with the lock it passes. It also covers employees being unable to call the intake or forge automatic leads, interest changes leaving the status alone, and offering catalogue isolation.

```bash
npm run db:start && npm run seed:dev && npm run test:api
```

## End-to-end

| Spec | Scenario |
|---|---|
| `sales-flow.spec.ts` | Manager creates and assigns a lead → follow-up task → another agent gets "not found" → the agent completes it → timeline and the manager's employee report update by exactly one |
| `whatsapp.spec.ts` | Local WhatsApp number: webhook handshake, signature rejection, ingestion, duplicates, inbox, automatic lead (and that the manual button cannot duplicate it), reply failure path, statuses, Meta failure codes, retry by the scheduled job |
| `whatsapp-media.spec.ts` | Simulated number: template sync, template outside 24 h, image upload/send, cached inbound PDF download, 404 for outsiders, credential alert and recovery |
| `auto-leads.spec.ts` | Real webhook route: first message → one automatic lead (8 identical deliveries in parallel add none), later messages, missing profile name, keyword match; the agent claims the conversation and qualifies interest/offering in the Inbox (status untouched, source recorded); the reply is attributed to the employee with the stored text unchanged; the company owner sees the conversation and lead and filters by interest/offering; courses & services admin (normalised keywords, deactivate, agents refused) |
| `kapso.spec.ts` | Kapso Sandbox through the real webhook route: the sandbox conversation is invisible in a real company's inbox, visible (badged, with a banner and no composer) once the sandbox company is chosen; "all companies" never includes it; admin creates a sandbox company and a Kapso number (Meta-only tools hidden) |
| `admin-screens.spec.ts` | Pipeline management; audit log (filters, name resolution, refused for agents); lead attachments (upload, byte-exact download, refused for outsiders/anonymous, delete); business hours (split shift, validation, holidays) |

```bash
# Local runs use a THROWAWAY verify token, set in the process environment for the app AND the tests.
# (Meta's handshake puts the token in the URL; dev servers and log files record URLs.)
export WHATSAPP_VERIFY_TOKEN=throwaway-$(date +%s)          # never your real token
npm run db:start && npm run seed:dev && npm run build && npm run test:e2e

# against an already running server (that server must have been started with the same throwaway value):
WHATSAPP_VERIFY_TOKEN=throwaway-1 npm run dev &              # or: ... npm run start
WHATSAPP_VERIFY_TOKEN=throwaway-1 E2E_BASE_URL=http://localhost:3000 npx playwright test
```

The handshake test refuses to run without that variable (outside CI, where `.env.local` holds a random value) so the real token can never end up in a URL that gets logged. Process environment variables take precedence over `.env.local` in Next.js, so no file is edited. Webhook **signatures** (the HMAC header) are not part of any URL and use the normal app secret.

The app's own login rate limit (10 sign-ins per 10 minutes per IP + e-mail) applies to the tests too. When re-running the suites many times in a row locally, clear the counters on the **local** stack only:

```bash
docker exec supabase_db_crm-hub psql -U postgres -c "delete from app.rate_limits;"
```

Wait for hydration (`waitUntil: "networkidle"`) before driving inputs whose handlers React attaches, such as the hidden file inputs: on the fast production build a change event can otherwise arrive before the handler exists.

## Volume check

`supabase/tests/perf/volume.sql` (not part of the regular suite) creates ~50k leads, 100k activities and 50k tasks inside a rolled-back transaction and times the hot paths as an agent, a manager and an admin. Run it after `./scripts/db/test.sh`:

```bash
psql -d crm_test -f supabase/tests/perf/volume.sql
```

Generating the data takes ~5 minutes (row triggers write history, notifications and audit rows); the timed queries run afterwards. Results on a laptop (PostgreSQL 16) before and after `0820`/`0830`:

| Path | Before | After |
|---|---|---|
| Leads list page (25 rows), any role | 1–10 ms | 1–5 ms |
| Exact lead count (manager, 31k visible) | 8.3 s | 28 ms |
| Agent "my open tasks" | 27 s* | 11 ms |
| Global search | 31–49 s | ~0.55 s |
| Contacts list (admin) | 27 s | 0.26 s |
| `report_company_kpis` (365 days) | 0.2 s | 0.2 s |
| `report_daily_series` (90 days) | 2.4 s | 32 ms |
| `report_employee_performance` (365 days) | 134 ms | 180 ms |

\* with `auth.uid()` in the filter; the app passes the user id as a literal.

## Development seed

```bash
npm run seed:dev               # local Supabase: users seed+<role>@example.test + fictional data
./scripts/db/reset-local.sh --seed   # plain local Postgres test DB
```

The seed refuses to run unless `app.allow_dev_seed=on` and refuses if any non-seed company exists. `seed-dev.ts` seeds a remote (staging) project only when `SEED_TARGET_PROJECT_REF` matches the project in the URL, `SEED_DATABASE_URL` is set and `SEED_PASSWORD` is a non-default value of 16+ characters; never run it against production. Every company name ends in "(تجريبي)", and all WhatsApp data is `is_simulated = true` and excluded from reports by default.

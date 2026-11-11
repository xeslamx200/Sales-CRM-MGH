# Implementation checklist

Legend: ✅ done & tested · 🟡 partial · ⛔ blocked · ⬜ not started

**Session 2 (19 Oct 2026):** npm access available. Baseline re-verified (271 DB checks, 39 unit tests). App layer in progress — see items marked "(S2)".

_Last updated: 19 Oct 2026_

## Phase 1 — Foundation
- ✅ Environment inspected (empty workspace; Node 22, Postgres 16; no Supabase credentials; npm blocked)
- ✅ Repository initialized, `.gitignore`, documentation set
- ✅ Schema: 29 tables, enums, constraints, indexes, timestamps, actor columns (`0100`)
- ✅ Companies, profiles, memberships (per-company roles), teams (`0100`, `0400`)
- ✅ RLS on every table; `anon` revoked; access helpers (`0200`, `0300`)
- ✅ Privilege-escalation guards (memberships, profiles, companies) + audit (`0400`)
- ✅ Authorization tests — 84 checks (`01`, `02`); security review fixes in `0720`
- ✅ (S2) Next.js 16 App Router, strict TS, Tailwind 4, shadcn/ui (Radix, RTL), Lucide, Recharts, RHF + Zod
- ✅ (S2) Local Supabase stack (`supabase/config.toml`): migrations apply cleanly on Supabase Postgres 17; invite-only sign-up; Arabic auth e-mail templates
- ✅ (S2) Env validation (`src/env.ts`, `src/server/env.ts`, boot check in `src/instrumentation.ts`) — names only, never values
- ✅ (S2) Supabase clients: user session (server/browser), service-role (`server-only`, lint-restricted to webhook/cron/invite paths); `src/proxy.ts` (Next 16 name for middleware) refreshes sessions and guards routes
- ✅ (S2) Auth: login, logout, forgot/reset password, invite acceptance, profile (name/phone/language/password); `auth_events` sign_in/sign_out/password_changed — browser-tested
- ✅ (S2) App shell: collapsible RTL sidebar, top bar, company selector (incl. "all companies" for super admin), search box, notifications panel, profile menu, breadcrumbs; design-system components (table, filters, dialogs, drawer, empty/loading/error states)
- ✅ (S2) Admin: companies, users & memberships (invite / role / deactivate), teams (+members), WhatsApp numbers (+per-user grants, can_reply) — browser-tested incl. full invite → accept flow
- ✅ (S2) Dev seed for local Supabase (`npm run seed:dev`, real sign-in users)

## Phase 2 — Core CRM
- ✅ Contacts: canonical identity + company links; exact-phone dedup; duplicate review queue; safe merge (`0600`)
- ✅ Phone normalization incl. Arabic digits (`src/lib/phone.ts`)
- ✅ Leads: creator vs owner, sources, statuses, archive, stages; history + assignment trail (`0500`)
- ✅ Controlled reassignment (`app.can_reassign`, `assign_lead`)
- ✅ Pipelines & deals: stage-derived status, won/lost rules, loss reason, reopen rules, conversion RPC
- ✅ Tasks: assignment rules, permanent completion, reminders (`generate_task_reminders`)
- ✅ Activities: calls/meetings/notes; lead activity timestamps
- ✅ Workflow tests — 82 checks (`03`)
- ✅ CSV parse/export with formula-injection protection (`src/lib/csv.ts`)
- ✅ (S2) Global search RPC `global_search` (invoker, RLS-safe, wildcard-escaped, Arabic digits) + trigram indexes (`0800`) — 29 new DB checks (`07`)
- ✅ (S2) CSV import RPC `import_leads` (invoker; per-row subtransactions; guards apply; stable error keys) (`0800`)
- ✅ (S2) Contacts: list/filters, detail (identity + per-company relationship/notes, leads, deals, conversations), create (exact-phone link), duplicate review with merge/dismiss — browser-tested incl. merge
- ✅ (S2) Leads: list with filters (status/owner/follow-up/source/priority/archived/search), pagination, create, detail with timeline (status history, assignments, activities, tasks, deals, conversations), status, assign (+reason), log activity, tasks, convert to deal, edit, archive — browser-tested
- ✅ (S2) Deals: Kanban by stage (drag & drop + keyboard "move to", loss-reason prompt) and table view; detail with stage history timeline; create/edit/assign/archive — browser-tested (won status set by DB)
- ✅ (S2) Tasks: mine / today / upcoming / overdue / completed / team views; create, complete (outcome, final), start, cancel — browser-tested
- ✅ (S2) CSV import: preview, per-row validation (Arabic/English headers and labels), in-file duplicates, existing-contact detection, 2 MB / 5,000-row limits, server re-validation, error report CSV — browser-tested; validation unit-tested
- ✅ (S2) CSV export of leads with list filters, RLS-scoped, formula-injection safe, UTF-8 BOM — browser-tested
- ✅ (S2) Wall-clock dates entered in the company time zone (`src/lib/dates/zoned.ts`, unit-tested incl. DST)

## Phase 3 — Reporting
- ✅ Metric definitions documented (`docs/METRICS.md`)
- ✅ Company KPIs, employee performance, daily series, targets, WhatsApp response, workload (`0700`)
- ✅ Scope mirrors RLS; time-zone-correct periods
- ✅ Exact-value tests incl. time-zone boundaries — 47 checks (`05`)
- ✅ Period presets in company time zone (`src/lib/dates/periods.ts`)
- ✅ (S2) Dashboard: KPI tiles from `report_company_kpis` (scope label: self / team / company), company comparison table in "all companies" mode (no cross-currency sums), daily trend charts from `report_daily_series` with table view, target progress, WhatsApp workload — browser-tested per role
- ✅ (S2) Reports: overview with team/employee filters, employee performance, WhatsApp response (unattributed phone-app replies shown separately; simulated data excluded), targets (+ create target, RLS-checked) — browser-tested
- ✅ (S2) Period presets in company time zone + validated custom range (≤ 1 year), kept in the URL
- ✅ (S2) Chart palette validated with the dataviz validator (3 slots, CVD ΔE ≥ 9.2); table view for every chart
- ⬜ Business-hours-adjusted response time (needs per-company business hours)

## Phase 4 — WhatsApp
- ✅ Research: coexistence requirements documented (`docs/WHATSAPP_INTEGRATION.md`)
- ✅ Ingestion (inbound + coexistence echoes), status updates, outbound queue with 24 h rule and idempotency (`0600`, `0710`)
- ✅ Signature verification, payload parser, processor, Cloud API client, retry/backoff (`src/lib/whatsapp/*`)
- ✅ Webhook event dedup/retry/redaction/retention (`0710`)
- ✅ Tests — 58 DB checks (`04`, `06`) + 23 unit tests
- ✅ (S2) `GET/POST /api/webhooks/whatsapp`: raw-body HMAC check before parsing, verify-token handshake, service-role `WebhookStore` (`src/server/whatsapp/store.ts`) — exercised locally with signed payloads (inbound, duplicate, bad/missing signature, status for unknown message, coexistence echo)
- ✅ (S2) Fixed before go-live: echo events would have violated `event_kind` check (→ endless 503s); now mapped to `message` (`dbEventKind`, unit + DB test). RPC calls always send every argument (omitted `p_media` caused PGRST202)
- ✅ (S2) Cron routes protected by `CRON_SECRET` (constant-time): `/api/cron/whatsapp-retry` (re-claims + reprocesses failed events), `/api/cron/maintenance` (task reminders + intake purge; alternative to pg_cron) — tested
- ✅ (S2) Send pipeline (`src/server/whatsapp/send.ts`): `queue_outbound_message` with the user's session → Graph API (server token, one quick retry for transient errors) → `record_outbound_result` (service role); idempotent per submission; simulated numbers never call Meta — failure path tested locally without network
- ✅ (S2) Inbox UI: filters (status/owner/number/unread/search), thread with delivery ticks, failed indicator + resend, phone-app (echo) label, internal notes (never sent), claim/release/assign, status, 24-hour window notice, unread cleared on open, 15 s polling refresh — browser-tested
- ⛔ Test number end-to-end — needs Meta app + test number + secrets from you
- ⬜ Template messages (outside the 24 h window)
- ⬜ Media download proxy (authorized), attachments to Storage
- ⬜ Admin alert on token errors (190)

## Phase 5 — Production readiness
- ✅ Dev seed: fictional, labeled, opt-in, refuses on real data
- ✅ Docs: README, ARCHITECTURE, DATABASE_SCHEMA, SECURITY, WHATSAPP_INTEGRATION, DEPLOYMENT, TESTING, METRICS (updated S2)
- ✅ (S2) Typecheck / lint / production build — passing
- ✅ (S2) Rate limiting (`0810`, `src/server/rate-limit.ts`): sign-in, password reset (hashed IP/e-mail keys, service role), send, import, export (own-bucket per user) — 17 DB checks; sign-in limit browser-verified
- ✅ (S2) Playwright e2e: login → lead → assign → follow-up → report + cross-agent isolation — passing on `next dev` and `next start`
- ✅ (S2) Volume review with ~50k leads (`supabase/tests/perf/volume.sql`): RLS policies rewritten with statement-level scope sets (`0820`), proven equivalent to the original rules for all fixture users (`09`, 66 set comparisons); search 30–50 s → ~0.5 s, contacts list 27 s → 0.26 s, counts 8 s → 28 ms; `report_daily_series` single-pass rewrite (`0830`): 2.4 s → 32 ms
- ✅ (S2) DB suite verified on PostgreSQL 16 and 17 (fixed locale-dependent ordering in two tests)
- 🟡 (S2) CI workflow `.github/workflows/ci.yml` (DB tests on PG 16+17, unit, typecheck, lint, build, e2e with local Supabase) — written; not run yet (no repository)
- 🟡 (S2) Vercel Cron schedule in `vercel.json` — sub-daily schedules need Vercel Pro; pg_cron alternative documented
- ⬜ Independent security review of policies and RPCs (recommended before go-live; `0820` changed the hot policies)
- ⬜ Media messages: authorized download proxy; template messages; admin alert on token error 190 (see Phase 4)
- ⬜ Business-hours-adjusted response time (needs per-company business hours)
- ⛔ GitHub private repo — awaiting your go-ahead to create it
- ⛔ Vercel + Supabase projects, domain — need your accounts (see `docs/DEPLOYMENT.md`)
- ⛔ Meta app + test number — needed for stages 3–5 of `docs/WHATSAPP_INTEGRATION.md`

## Session 3 — launch readiness (started 21 Oct 2026)

Priority order (P0 = before any staging deploy):

| # | Pri | Item | Status |
|---|---|---|---|
| 1 | P0 | Security review: RLS policies incl. 0820, grants, direct REST/RPC access tests as real users, client-bundle secret scan | ✅ 6 findings fixed (`0840`–`0860`), CSP added; UPDATE-path equivalence; 17 API tests; risks documented in SECURITY.md |
| 2 | P0 | Deployment prep: env inventory, staging runbook, migration procedure, CI additions, domain/DNS plan (no changes) | ✅ DEPLOYMENT.md rewritten; `check:migrations`, `check:bundle`, `/api/health`, gated staging seed; CI extended; tracked files scanned (no secrets) |
| 3 | P0 | Scheduled jobs: Supabase-native (pg_cron) retries/reminders/purges; idempotent, authenticated, observable | ✅ `0870`; verified pg_cron ran on local Supabase; System status page; Vercel Cron no longer needed |
| 4 | P1 | WhatsApp: review, automated local integration tests (webhook → DB → status), Meta test setup guide, coexistence research | ✅ local e2e (`whatsapp.spec.ts`: handshake, signatures, ingestion, duplicates, statuses, failures, retry); WHATSAPP_INTEGRATION.md setup + coexistence. ⛔ **Live Meta end-to-end test not done** (needs your Meta app + test number) |
| 5 | P1 | WhatsApp media (inbound/outbound, secure retrieval, previews) + credential-error alerts | ✅ `0890`; private bucket, RLS-checked 60 s signed URLs, cache of inbound media; health + admin alerts; `whatsapp-media.spec.ts` (simulated number — not verified against Meta) |
| 6 | P1 | WhatsApp templates outside the 24 h window | ✅ `0890`; sync, approved-only, parameter count checked in SQL; e2e on a simulated number (not verified against Meta) |
| 7 | P1 | Conversation → lead; controlled company reassignment of conversations | ✅ `0880`; reason required, kept as an internal note; DB + e2e tests |
| 8 | P2 | Lead/deal file attachments | ✅ `0920`; private `attachments` bucket, signed upload after a user-session check, DB guard (company/path/type), 60 s download URLs; DB (19), API and e2e tests |
| 9 | P2 | Pipeline management screen | ✅ `0900`, `0910` (default pipeline can't be broken by direct API writes); `/admin/pipelines`; DB (26) + e2e |
| 10 | P2 | Audit log viewer | ✅ `/admin/audit` (filters, names resolved with the viewer's session, links); RLS-backed; DB (8) + API + e2e |
| 11 | P2 | Business hours + business-hours response times | ✅ `0930`; split shifts, holidays, company timezone (DST-safe); 3 report columns; editor at `/admin/companies/<id>/hours`; DB (31, exact values) + e2e |
| 12 | P1 | **Automatic WhatsApp → Lead** (first inbound message creates one lead; interest + courses/services catalogue; Inbox lead panel and filters; owner sync) | ✅ `0950`; DB (114), parallel-request API tests (mutation-checked), unit, 4 browser scenarios; rollback script tested; see `docs/WHATSAPP_AUTO_LEADS.md`. ⛔ **Not verified against Meta** (webhook verification never succeeded) |
| 13 | P1 | **Kapso Sandbox, Phase 1** (receive-only): separate signed endpoint, sandbox company, provider-specific wrappers with ownership checks, idempotency, metric isolation | ✅ `0960` + tested rollback; DB (97), unit (34), API (22), browser (3); **local only, uncommitted**: no webhook created, nothing exposed, nothing sent. See `docs/KAPSO_SANDBOX.md`. ⛔ Not verified against Kapso |
| — | Blocked on owner | GitHub repo creation/push, Supabase staging project, Vercel project, domain, Meta app/test number | ⛔ |

## Decisions needed from you
1. Create the private GitHub repository (name/owner) — then CI runs on every push.
2. Supabase projects (`crm-dev`, `crm-prod`) and region; Vercel project (scheduled jobs run in pg_cron, so no Vercel Cron is needed; **note:** Vercel's Hobby plan is restricted to personal, non-commercial use, so a business CRM should be on Pro, see `docs/STAGING_PLAN.md`).
3. Domain/subdomain for the CRM (one CNAME; WordPress untouched).
4. Meta app + WhatsApp test number; set `WHATSAPP_*` yourself in Vercel (never in chat).
5. Per production number: coexistence (Tech Provider / Embedded Signup) or full Cloud API migration — see `docs/WHATSAPP_INTEGRATION.md`.

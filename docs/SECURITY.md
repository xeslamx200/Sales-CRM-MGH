# Security

Security is enforced in three layers. Each must hold on its own:

1. **PostgreSQL Row Level Security** — every table in `public` has RLS enabled; `anon` has no table privileges at all. Policies only grant; anything not granted is denied.
2. **Database rules (triggers + RPCs)** — column-level and transition rules that RLS cannot express (who may change an owner, status, role, outcome…). Errors are raised as stable keys (`lead.owner_change_forbidden`) and mapped to localized text in `src/lib/errors.ts`.
3. **Server code** — Next.js server actions and route handlers validate input with Zod (`src/schemas/*`, shared with the forms) and call Supabase *with the user's session* (`src/server/supabase/server.ts`), so layers 1–2 always apply. Failures are returned as localized messages derived from error keys; raw database text never reaches the browser.

Hiding a button in the UI is never the control.

## Roles

| Role | Scope |
|---|---|
| Super Admin (`profiles.is_super_admin`) | All companies, users, settings, audit log, cross-company reports. Cannot demote or deactivate themselves (lock-out protection). |
| Company Admin | Everything inside their company. Can manage members with roles below Company Admin; cannot create or edit Company Admins (Super Admin only). |
| Sales Manager | Teams where they are `teams.manager_id`: agents' leads/deals/tasks/activities, unassigned records, targets for those people/teams. Cannot change team membership (company admins do, audited) and never "manages" a company admin. |
| Sales Agent | Records they own; records they created that nobody owns yet. |
| Customer Service / WhatsApp Agent | Same record rule as Sales Agent; conversations on numbers they are granted (see below). |

Roles are **per company** (`company_memberships.role`): one person can be a Sales Agent in Company A and a CS Agent in Company B. Deactivating a profile (`profiles.is_active = false`) removes all access immediately, even though memberships remain for history.

## Access matrix (as implemented in `supabase/migrations/…0200` and `…0300`)

| Data | Super Admin | Company Admin | Sales Manager | Agent |
|---|---|---|---|---|
| Companies | all | own | own | own |
| Memberships / teams | all | manage own company (not admins); team membership (audited) | read | read |
| Leads / deals | all | all in company | own, managed users', unassigned, own teams' | owned; created & unassigned |
| Lead/deal history | follows parent record | ← | ← | ← |
| Tasks | all | all in company | own, assigned to managed users, unassigned | assigned to or created by them |
| Activities | all | all in company | own, by managed users, on visible leads/deals | own, on visible leads/deals |
| Contact identity | all | linked to company | linked to company | ones they own at company level, or linked to a visible lead/deal/conversation, or created |
| Company-specific contact notes (`contact_companies`) | all | own company only | own company only | rows for contacts they can see, own company only |
| WhatsApp numbers | all | numbers whose default company they admin | numbers they are granted | numbers they are granted |
| Conversations | all | all in company | all on granted numbers in company | own + unassigned on granted numbers |
| Messages / internal notes | follow conversation | ← | ← | ← |
| Reports | all companies | whole company | self + managed users (+ unassigned records) | self only |
| Audit log | all | own company | — | — |
| Notifications | own | own | own | own |
| Raw webhook events | — (service role only) | — | — | — |

### Shared contacts

`contacts` holds only identity (name, E.164 phone, e-mail). Everything company-specific — relationship, owner, notes — lives in `contact_companies`, one row per company. Leads, deals, tasks and conversations always carry their own `company_id`. Seeing a shared contact therefore never exposes another company's leads, deals, notes or messages (tested in `supabase/tests/db/01_tenancy_isolation.sql`).

Deliberate trade-off: when Company B enters a phone number that already exists, the canonical contact is **linked**, not duplicated, so B's user sees the name already on record. Identity is shared; business data is not. If the business wants identity isolation too, the alternative (per-company contacts with a cross-company match table) is a contained change to `find_or_create_contact`.

## Guarded fields and transitions

| Rule | Where |
|---|---|
| `created_by` is always the session user (forged values are overwritten) | lead/deal/task/activity/contact guards |
| Creator never changes; company never changes | same |
| Owner changes: Company Admin any; Sales Manager within their teams; anyone may claim an unassigned record for themselves | `app.can_reassign` |
| Deal `status` is derived from the stage type; `won_at`/`lost_at`/`closed_by` are system-set; loss reason required | `app.guard_deal` |
| Reopening a closed deal or editing a won deal's amount: managers only (audited) | `app.guard_deal` |
| Completed tasks are final; completion time/actor are system-set | `app.guard_task` |
| Lead → `converted` only via `convert_lead_to_deal` (requires a deal) | `app.guard_lead` |
| Memberships: nobody edits their own; only Super Admin manages Company Admins | `app.guard_membership` |
| Profiles: only Super Admin changes `is_super_admin`/`is_active`; e-mail is owned by Supabase Auth | `app.guard_profile_update` |
| Conversation timestamps / 24-hour window fields cannot be edited by users | `app.guard_conversation` |
| A contact's phone (cross-company identity key) changes only by someone managing every linked company | `app.guard_contact_phone` |
| Message content and sender are immutable; delivery status only moves forward | `app.guard_message_update` |
| Audit rows cannot be updated, deleted or truncated — by anyone, including the table owner | `audit_logs_no_update` triggers |

### Policy evaluation at volume (`…0820`)

The hot policies (leads, deals, tasks, activities, contacts, contact_companies) compute the caller's scope once per statement — `(select app.admin_company_ids())`, `app.sales_manager_company_ids()`, `app.managed_user_pairs()`, `app.managed_team_ids()`, `app.visible_contact_ids()` — instead of calling a predicate per row. They express exactly the rules of the original predicates; `supabase/tests/db/09_rls_equivalence.sql` compares the visible row sets of old and new rules for all 11 fixture users on a matrix of edge cases (inactive teams, an admin inside a manager's team, contacts not linked to the lead's company, deactivated owners, conversation-only contacts). The original predicates remain in use for single-row checks in guards and RPCs.

Guards that must consider rows the caller cannot see (other companies' links, other users' number grants) run as SECURITY DEFINER; otherwise RLS would hide those rows and the check would silently pass. This exact bug was caught by the test suite and fixed in `…0720`.

Trusted internal paths (merge, system-maintained timestamps) raise a transaction-local flag (`app.system_op`, `app.merging_contacts`) from SECURITY DEFINER code. The functions that set them are not executable by API roles, and the Supabase Data API cannot set arbitrary settings.

## Secrets

| Secret | Where it lives | Never |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env (server), local `.env` | in `NEXT_PUBLIC_*`, client components, logs |
| `WHATSAPP_ACCESS_TOKEN` (system-user token) | Vercel env (server) | in the database, logs, client |
| `WHATSAPP_APP_SECRET` | Vercel env (server) | — |
| `WHATSAPP_VERIFY_TOKEN` | Vercel env (server) | — |
| `CRON_SECRET` | Vercel env (server) | — |

Environment variables are validated with Zod (`src/env.ts`); errors name the variable, never its value. Core variables are checked at server start (`src/instrumentation.ts`); feature groups (service role, cron, WhatsApp) when first used, so the CRM runs before Meta is configured. Every server module imports `server-only`, so an accidental client import fails the build.

### Service-role boundary

The service-role key bypasses RLS. An ESLint rule (`eslint.config.mjs`) fails the build if any file outside this list imports `@/server/supabase/admin`:

| Path | Why it needs the service role |
|---|---|
| `src/server/whatsapp/**`, `src/app/api/webhooks/**` | Webhook ingestion (no user session) and recording send results (`record_outbound_result` is service-only) |
| `src/app/api/cron/**` | Scheduled jobs (retries, reminders, retention) |
| `src/server/auth/invite.ts` | Auth Admin API (`inviteUserByEmail`) and looking up whether an e-mail already has an account. The caller's permission is checked with **their own session first**, and the membership row is inserted with their session, so RLS, the membership guard and the audit trigger apply. |
| `src/server/rate-limit.ts` | Counters for **unauthenticated** endpoints (sign-in, password reset), keyed by a hash |
| `src/server/attachments.ts` | Private Storage I/O for record attachments: signed upload URL, checking the uploaded object, 60-second download URLs, removing objects. **Who** may do it is always decided first with the user's session (RLS on the lead/deal and on `attachments`, plus `app.guard_attachment`); the row itself is inserted and deleted with the user's session. |

## Logging and data minimization

* Audit rows store actor, action, entity and *safe* metadata (ids, statuses, roles) — never message text, passwords or tokens.
* Webhook intake (`whatsapp_webhook_events`) is service-role only; payloads are **redacted to `{}` once processed** and rows are purged after 30 days (`purge_old_webhook_events`).
* Stored webhook error text is limited to dotted error keys (`safeErrorCode`), never free text that could contain customer data.
* Users see localized messages derived from error keys; raw database errors are never displayed.

## Webhook security

* `X-Hub-Signature-256` HMAC-SHA256 over the **raw** body with the App Secret, compared in constant time (`src/lib/whatsapp/signature.ts`). Invalid → 401 before anything is stored.
* Verify-token handshake compared in constant time; challenge echoed only if it is a short safe token.
* Idempotency at two levels: `claim_webhook_event` (event key) and `messages.wa_message_id UNIQUE`.
* **Kapso Sandbox** (`POST /api/webhooks/kapso`, separate from Meta's route): `X-Webhook-Signature` hex HMAC-SHA256 over the raw bytes with `KAPSO_WEBHOOK_SECRET`, constant-time comparison after a length check, signature first (401), payload version `v2` only (400), body capped at 2 MiB while streaming (413), POST only (405), 503 when unconfigured. The account and company are resolved by the database from the phone_number_id and must be an active Kapso sandbox account of a sandbox company; the payload's own company/account ids are never read. Sandbox data lives only in sandbox companies, which every report excludes. Receive-only: a trigger refuses employee messages in sandbox conversations. Details and proof in `docs/KAPSO_SANDBOX.md`.

## Rate limiting (`…0810`, `src/server/rate-limit.ts`)

Database-backed fixed windows, so limits hold across serverless instances:

| Action | Limit | Bucket |
|---|---|---|
| Sign-in | 10 / 10 min, and 50 / 10 min per IP | hash(IP + e-mail), hash(IP) |
| Password reset request | 3 / hour, and 10 / hour per IP | hash(IP + e-mail), hash(IP) |
| WhatsApp send | 30 / minute | user |
| CSV import preview / commit | 30 / hour, 10 / hour | user |
| CSV export | 20 / hour | user |

A signed-in caller always counts against **their own** bucket (`rate_limit_hit` keys it by `auth.uid()` and ignores the key argument), so nobody can exhaust someone else's quota. Keyed buckets are service-role only and accept only opaque tokens (the server sends a SHA-256 hash; raw e-mails and IPs are never stored). Counters live in schema `app` (not exposed) and are purged by the maintenance job. If the limiter itself fails, requests are allowed and a warning is logged (fail-open); Supabase Auth's own limits still apply to sign-in.

## Pre-launch security review (Session 3, 21 Oct 2026)

**Scope:** every RLS policy (29 tables, all RLS-enabled), table and function privileges for `anon`/`authenticated`, every user-callable SECURITY DEFINER RPC, the `0820` optimized policies, the Data API surface (REST, RPC, GraphQL, schema exposure), server actions and route handlers, and the client bundle.

**How behaviour was tested (not just query results):**
* `09_rls_equivalence.sql` — for 11 users, the rows each can **read** (6 tables, 66 comparisons) and **update** (4 tables, 44 comparisons, by executing the update) under the `0820` policies equal the rows the original predicates allow.
* `10_security_review.sql` — regression tests for every finding below, written as attacks.
* `tests/api/security.test.ts` (`npm run test:api`) — 20 tests (plus 9 in `tests/api/auto-leads.test.ts`) with real JWTs from real sign-ins against local Supabase: anonymous REST/RPC/GraphQL, cross-agent reads and writes, reassigning someone else's lead, cross-company reads/writes/reports, privilege escalation (super-admin flag, memberships, team membership), service-only tables/RPCs, the internal `app` schema, forged login events, shared contacts, multi-company employees, manager scope, a deactivated account holding a still-valid token, private Storage buckets (no listing, download, signing or upload with a user/anonymous token), forged attachment rows, and admin-only settings (business hours, pipelines, audit log).
* `scripts/check-client-bundle.mjs` (`npm run check:bundle`) — scans the built browser bundle for the **values** of every server-only variable and for any embedded `service_role` JWT (verified to fail on a planted key). It now refuses to run when the secret values aren't loaded (previously a run without `.env.local` passed vacuously).

**Findings and fixes**

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | High | `merge_contacts` authorization was vacuous for contacts without company links and never checked visibility: any signed-in user could merge such contacts and re-point leads, deals and conversations in companies they don't administer. | Both contacts must be visible; caller must administer **every** company touching either contact (links, leads, deals, tasks, activities, conversations); no footprint → only super admin or the creator. (`0840`) | `10` §1 |
| 2 | Medium | `report_target_progress` returned company-wide and team **actuals** to anyone who could see the target — agents could read company revenue. | Actuals only when everyone counted is in the caller's report scope; otherwise `null` (`0840`). Also fixed a NULL-logic slip that showed `0` instead of hiding. | `10` §3, `05` |
| 3 | Medium | Users could insert their own `sign_in` / `password_changed` events via the API, inflating the "sign-ins" metric. | Recorded by triggers on `auth.sessions` / `auth.users`; users may only insert their own `sign_out` (`0840`). Verified on real Supabase Auth. | `10` §2, API tests |
| 4 | Medium | A user with a **read-only** number grant could self-claim conversations, removing them from the shared queue. | Self-claim requires `can_reply` (`0860`). Managers can still assign deliberately. | `10` §6 |
| 5 | Medium (availability) | Guards re-checked owner/assignee membership on every update: once an employee left, nobody could edit their leads, deals, tasks, contact links or targets, and logging an activity on such a lead failed. | Membership checked only when the person is set or changed (`0850`). | `10` §5, `09` update check |
| 6 | Low (privacy) | Failed webhook intake rows (which keep customer message content for retries) were never purged. | Purged after the retention period like processed rows (`0840`). | `10` §4 |
| 7 | Low (hardening) | No Content-Security-Policy. | Production CSP: self + Supabase origin only, `frame-ancestors 'none'`, `object-src 'none'` (`next.config.ts`); verified no violations on 8 screens and the e2e flow. | manual + e2e |

**Daily-use features added after the review (same rules applied):**

| Feature | Controls | Tests |
|---|---|---|
| Record attachments (`0920`) | Private `attachments` bucket with no Storage policies (users can't list, read or write it directly); signed upload URL only after the user-session check; the DB row must name the record's own company, sit inside `<company>/<type>/<record>/`, use an allow-listed type (no HTML/SVG/executables) and ≤ 25 MB; the uploader is set by the DB; rows are immutable; delete = uploader or company admin while they can still see the record; downloads via 60-second signed URLs (non-images forced to download); original file names never appear in storage keys. | `16`, API, e2e |
| Pipeline management (`0900`, `0910`) | Company admins only (RLS); the default pipeline can't be deactivated or left without active open/won/lost stages by any path; pipelines and stages can't move between companies or pipelines. | `14`, API, e2e |
| Audit log viewer | Reads `audit_logs` with the viewer's session (super admin: all; company admin: own companies; others: nothing). Names in the metadata resolve only where the viewer may see the person, stage or team. | `15`, API, e2e |
| Business hours (`0930`) | Admin-only writes (RLS + `set_business_hours` checks); members of the company can read; `app.business_seconds` runs with the caller's rights, so it reveals nothing about other companies. | `17`, API, e2e |

**Automatic WhatsApp leads (`0950`)** — controls added with the feature, each with a test:

| Control | Detail |
|---|---|
| No fake system user | `leads.created_by` is nullable **only** for automatic leads: check constraint `leads_auto_creator_chk` plus the guard. Manual leads still need an authenticated creator (even for the service role); a user cannot set `auto_created`, a null creator or an offering source (the database overwrites them), nor link a lead to a conversation they cannot access or that belongs to another company/customer (composite foreign key + guard). |
| Intake stays service-only | `ingest_whatsapp_message` keeps its signature and grants (service role only); `app.ensure_whatsapp_lead` and the other helpers are not executable by users and the `app` schema is not exposed. |
| No duplicates under concurrency | Per-customer advisory lock + unique index (see `docs/WHATSAPP_AUTO_LEADS.md`); parallel-request tests, one mutation-checked. |
| No visibility widening | Lead/conversation RLS unchanged. `conversation_leads` is `security_invoker`, so the caller's RLS applies; the manual "create lead" refuses to duplicate a lead the caller cannot see (`lead.already_exists`). |
| Offerings | Per company: members read, company admins insert/update, nobody deletes; another company's offering cannot be attached to a lead (composite foreign key). |
| Customer identity | Outbound payloads carry no sender fields (unit-tested); employee attribution is database-set `sent_by`. |

**Verified as sound:** all tables RLS-enabled; `anon` has no table or function privileges; every service-only RPC closed to `authenticated`; `app` schema not exposed (REST returns an error for `Accept-Profile: app`); GraphQL returns nothing to anon; deactivated users lose access immediately even with a valid JWT; no secret values or service-role JWTs in the client bundle; service-role imports restricted by lint.

### Unresolved risks before production (accepted or pending your decision)

| Risk | Why it remains | Mitigation / decision needed |
|---|---|---|
| **Cross-company identity enumeration** via `find_or_create_contact`: a user can learn whether a phone number exists in the group and see that contact's name/e-mail once linked. | Deliberate design: one shared identity per phone across the three companies (documented in "Shared contacts"). | If identity must be private per company, switch to per-company contacts + match table (contained change). Business decision. |
| **Self-reported activity** — employees can backdate their own calls/meetings (not into the future) and create-then-complete tasks. | Inherent to self-reported CRM activity; all are attributed and audited per actor. | Optional rule: limit backdating to N days. Business decision. |
| **CSP allows `'unsafe-inline'` scripts** | Next.js streaming without per-request nonces. | Nonce-based CSP via `proxy.ts` is possible later; low priority (no user HTML is rendered unescaped). |
| **Direct RPC calls bypass app-level rate limits** for `import_leads` / `global_search` (still RLS-bound and capped at 1000 rows / 50 results per call). | Rate limits are enforced in server actions. | Add DB-side limits if abuse appears; Supabase project-level API limits apply. |
| **No independent third-party review** | — | Recommended before handling real customer data at scale. |
| **Abandoned uploads leave orphan objects** in private Storage (the browser uploads, then never calls finalize). | The row is only created after the upload is verified. | Private and unreachable without a signed URL; add a periodic cleanup of objects without a row if volume grows. |
| **Attachments are not virus-scanned.** | No scanning service is configured. | Types are allow-listed and non-images are served as downloads, never rendered; add a scanner (e.g. a Storage webhook) if customers upload files. |

## Test evidence

`./scripts/db/test.sh` runs 708 database checks (19 files, PostgreSQL 16 and 17) including the ten §19 scenarios and the RLS equivalence proof; `node --test tests/unit/*.test.ts` covers signature, parsing, idempotency, send-error handling, env validation, import validation and time zones; the Playwright flow covers cross-agent isolation in the browser. See `docs/TESTING.md`.

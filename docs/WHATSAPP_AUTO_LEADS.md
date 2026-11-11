# Automatic WhatsApp → Lead

Status: **built and tested locally (21 Oct 2026). Not deployed. Not verified against a live Meta number**, because the Meta webhook verification never succeeded (see `docs/WHATSAPP_INTEGRATION.md`). Everything below was exercised with signed local webhook payloads, direct database calls and the real UI.

## What it does

A customer's first inbound WhatsApp message on a connected number creates, in one database transaction: the contact (existing identity model), the conversation, the message, and **one lead** linked to the conversation and contact. Nobody clicks "convert". Later messages update the same records.

| Lead field | Value for an automatic lead |
|---|---|
| Company | The WhatsApp number's company (`whatsapp_accounts.default_company_id`) |
| Contact | The customer's contact (global by phone; company-level data stays in `contact_companies`) |
| Title | The contact's name (WhatsApp profile name when Meta sent one, otherwise the phone number: the existing unknown-name fallback) |
| Source / `auto_created` | `whatsapp` / `true` (shown as **Automatic (WhatsApp)**) |
| Conversation | `leads.conversation_id` (same company enforced by a composite foreign key). The WhatsApp number is reached through the conversation. |
| Creator (`created_by`) | **`NULL`**: nobody is credited |
| Status | `new` (existing lead statuses and conversion rules are untouched) |
| Interest | `unassessed` |
| Offering | Set only on an exact keyword match (below); otherwise empty |
| Owner | The conversation's owner when it already has one (and is a company member); otherwise empty |

## When a lead is created (and when not)

On every inbound message, after the message is stored:

1. The conversation already has a linked lead (automatic or manual; open, lost, converted or archived) → **nothing**.
2. The company already has an **open** lead (`new`/`contacted`/`qualified`, not archived) for the same customer → **reuse it**; if it has no conversation yet it is linked to this one. This covers a second number of the same company and manual leads.
3. Otherwise → **create** the automatic lead.

Consequences, all tested: at most one automatic lead per conversation; a lost, unqualified, converted or archived lead never triggers another one for that conversation; two numbers of one company share one open lead (each conversation shows it); a customer writing to another company gets that company's own lead; **simulated (demo) numbers never create leads** (leads have no `is_simulated` flag, so they could not be excluded from metrics); echoes (messages sent from the phone app) never create leads (the customer did not initiate); **no historical conversation is backfilled** (the migration changes no rows; an old conversation gets its lead only when a new inbound message arrives).

## Duplicate prevention and failure handling

| Mechanism | Prevents |
|---|---|
| Unique claim per webhook event key; unique Meta message id | Repeated or concurrent delivery of the same event creating a second message |
| Unique conversation per (number, customer); unique contact per phone | Duplicate conversations/contacts under parallel first messages |
| `pg_advisory_xact_lock` per (company, customer) inside `app.ensure_whatsapp_lead` | Two numbers (or two messages) of the same company racing to create two open leads |
| Partial unique index `leads_one_auto_per_conversation` (conversation_id where auto_created) | A second automatic lead for a conversation even if the lock were bypassed |
| `lead_from_conversation` (manual button) takes the same lock, reuses the existing lead, and **refuses** (`lead.already_exists`) when an open lead exists that the caller cannot see (e.g. unassigned) | Repeated clicks or the click racing the intake creating duplicates |

No uniqueness constraint was added for "one open lead per company and customer": manual leads for different purposes are legitimate (import, several courses), so the rule is enforced in the intake path only. Local data had no duplicate open leads (checked).

**Failures:** lead creation runs inside the same transaction as the message. If it fails, the whole intake rolls back (no contact, conversation or message is left half-written) and the event stays `failed` with a stable error code, exactly like any other failed event: the existing database job retries it every 5 minutes (up to 8 attempts) and the payload is kept. Nothing is silently dropped, but a message does not appear in the inbox until its retry succeeds. Tested by injecting a failing lead insert and then recovering through the retry job.

## Interest, offerings and qualification

* **Interest** (`unassessed`, `interested`, `not_interested`, `follow_up_required`) is a separate field. Changing it never changes the lead status and vice versa (tested both ways). It is never inferred automatically: new leads are `unassessed`, and a short or ambiguous message is never "not interested". "Qualified" is the existing lead **status**.
* **Offerings** (`company_offerings`: course, workshop or service, optional keywords, active flag) are managed by company admins at *Administration → Courses & services*. They are deactivated, never deleted.
* **Automatic matching** uses only the message that creates the lead. An offering is attached only if **exactly one active offering of that company** has a keyword in the text; zero or several matches leave it empty; inactive offerings and other companies' offerings never match. Latin keywords match whole words, Arabic keywords match inside words (Arabic prefixes attach to words); case, diacritics, alef/ya variants are ignored; regex characters are literal. `offering_source` records `auto_keyword` or `employee`, set by the database (a client cannot forge it). Employees can correct or clear it in the Inbox or on the lead page. No AI service or new dependency is involved.

## Ownership and visibility

* An automatic lead **follows its conversation's owner** (claim, assignment, release) only while the lead still has the owner the conversation had. An explicit lead assignment or un-assignment is never overwritten; manual leads and leads of other conversations are never synchronised; leads never cross companies.
* Visibility rules are unchanged: agents see leads they own, managers their team's and unowned ones, company admins ("Owner") all of their company's, super admins everything. Consequence: an unassigned automatic lead is invisible to agents until the conversation is claimed. The Inbox then tells the agent to **claim the conversation**; clicking "create lead" cannot create a duplicate.
* Automatic leads are credited to nobody: per-employee "leads created" counts exclude them. Company-level totals for admins include them; a manager's team-scoped totals do not (by the report definition, which credits the creator and an automatic lead has none). See `docs/METRICS.md`.
* A conversation moved to another company is **unlinked** from its leads (they stay in the old company).

## Customer-facing identity and employee attribution

The payloads sent to Meta contain only the recipient and the content (unit-tested field by field: no sender, profile or employee field; text sent verbatim). The customer sees the WhatsApp Business display name and number. `messages.sent_by` is set by the database from the authenticated session, survives resends and status updates, and is shown to staff in the Inbox. Messages sent from the phone app have no sender and are labelled as such.

## UI

* **Inbox**: lead panel under the conversation header (lead title and link, status, automatic/manual, owner with assign for managers, interest and offering selects with the offering's source); company and number in the header; filters for number, employee, interest and offering; interest/offering badges in the list; "create lead" only while the conversation has no lead.
* **Leads**: source shows *Automatic (WhatsApp)*; interest and offering columns and filters; CSV export includes them. **Lead page**: interest/offering editor, link to the conversation, "Created automatically from WhatsApp" in the timeline.
* **Audit log**: `lead.created` records `automatic` and the conversation (no actor); `lead.interest_changed` and `lead.offering_changed` record who changed what.

## Assumptions and unresolved business rules

1. A lost/closed lead does **not** reopen automatically when the customer writes again; an employee creates a new lead from the Leads page. If the business wants "reopen or create after N days", that is a rule to add.
2. If a customer's first lead is reused by a second number and later closed, the next message on the second number creates a new automatic lead (that conversation never had its own).
3. Agents cannot see unassigned automatic leads (existing visibility model). Alternative (not done, it broadens access): let anyone with access to the number see leads of unassigned conversations.
4. Keyword matching is deliberately conservative; there is no confidence score beyond the recorded source.
5. Leads of simulated numbers are not created (demo data stays out of the pipeline).
6. Not verified against Meta: needs a verified webhook and a real test message.

## Files

Added: `supabase/migrations/20261021000950_auto_leads.sql`, `supabase/rollbacks/*`, `supabase/tests/db/18_auto_leads.sql`, `tests/api/auto-leads.test.ts`, `tests/e2e/auto-leads.spec.ts`, `tests/unit/customer-identity.test.ts`, `src/actions/offerings.ts`, `src/app/(app)/admin/offerings/{page,offering-form}.tsx`, `src/components/crm/lead-qualification.tsx`, `src/components/inbox/lead-panel.tsx`.
Modified: `src/actions/{inbox,leads}.ts`, `src/app/(app)/{inbox/page,leads/page,leads/[id]/page,admin/audit/page}.tsx`, `src/app/api/export/leads/route.ts`, `src/components/{inbox/thread,crm/timeline,shell/app-sidebar,shell/breadcrumbs}.tsx`, `src/i18n/{ar,en}.ts`, `src/lib/errors.ts`, `src/schemas/{admin,crm}.ts`, `src/server/data/{leads,timeline}.ts`, `src/types/database.ts` (generated), `tests/api/security.test.ts`, `tests/e2e/whatsapp.spec.ts`.

## Migration `0950`

Additive: enums `lead_interest`, `offering_kind`; table `company_offerings` (RLS: members read, company admins insert/update, no delete); `leads` gains `conversation_id`, `auto_created`, `interest`, `offering_id`, `offering_source`; `leads.created_by` becomes nullable **only** for automatic leads (check constraint `leads_auto_creator_chk` plus the guard: manual leads, even from the service role, still require an authenticated creator; a user cannot set `auto_created` or a null creator); view `conversation_leads` (`security_invoker`); RPC `lead_from_conversation`; internal helpers and two conversation triggers. `CREATE OR REPLACE` of three existing functions with unchanged signatures and grants: `ingest_whatsapp_message`, `app.guard_lead`, `app.after_lead_change`. No existing row is changed (no data statements outside function bodies; verified against pre-migration counts and a checksum of the 80 existing leads).

## Rollback

Not part of `supabase/migrations`; run by hand on a backed-up database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261021000950_auto_leads.rollback.sql
```

* **Part 1** restores the exact pre-0950 `ingest_whatsapp_message`, `guard_lead` and `after_lead_change` (embedded verbatim, captured from the live database before the migration was written) and drops the two conversation triggers. It changes no rows. From then on nothing creates automatic leads.
* **Part 2** drops the added objects and restores `created_by NOT NULL`, **only if** no data depends on them. It stops with an explanation (leaving Part 1 applied, deleting nothing) when any of these exist: automatic leads, leads with a non-default interest/offering/conversation link, or company offerings. Decide what to keep (export those rows, or keep the harmless columns) and re-run; it is idempotent.
* Tested on a scratch database: with no new data it restores every function definition, constraint set, trigger set and grant to the pre-0950 state exactly and 0950 re-applies cleanly; with new data it stops and the row counts are unchanged.
* **App code** must be reverted with it: copies of the modified files as they were are in `supabase/rollbacks/20261021000950_app_before/` (strip `.orig`); delete the added files listed above. (The repository's first commit already contains the finished feature, so Git has no earlier version of these files and the copies must be kept. Verified: restoring all 21 and deleting the added files gives an app that typechecks with 0 errors, lints clean and passes the 63 pre-feature unit tests.)
* Limitations: automatic leads already created cannot be rolled back without deleting them (the rollback refuses to); after Part 2 the interest/offering a team entered is gone.

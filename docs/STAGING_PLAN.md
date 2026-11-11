# Staging environment: proposal (awaiting approval)

**Status: proposal only. Nothing in this document has been created, deployed or configured.** It needs your approval at each gate in §9. Nothing here touches production, DNS, WordPress or any production WhatsApp number.

Goal: a stable HTTPS webhook URL and an isolated database so the **live Meta test** (one inbound message → automatic lead → reply → delivery statuses) can finally be run, without a tunnel and without any production resource.

## 1. Isolation model

| Layer | Staging resource | Why it is isolated |
|---|---|---|
| Code | Private GitHub repository, branch `staging` (deploys); `main` reserved for production later | Staging deploys never share a branch with production |
| Database / Auth / Storage | **New Supabase project `crm-staging`** (ideally in its own Supabase organization, so billing, members and API keys are separate from the future `crm-prod`) | Own Postgres, JWT secret, anon and service-role keys, database password and Storage |
| Hosting | **New Vercel project `crm-staging`** whose *Production* environment is staging (see §3) | Own environment variables, domain and logs |
| WhatsApp | The existing Meta **test app and test number only** | Test numbers can only message verified recipients; no production number is connected |
| E-mail | Supabase's built-in sender is enough for a handful of test invitations; a separate SMTP account is optional | Staging mail never uses production sender credentials |
| Data | Fictional or hand-entered test data only; no import of real customers | Staging holds nothing worth protecting beyond the test number's conversations |

Hard rules: no credential is shared between staging and (future) production; no local demo keys are ever used in the cloud; `crm-staging` is the only project the CLI is ever linked to from this repository until you approve a production plan; no DNS record is created or changed (staging uses the free `*.vercel.app` name).

## 2. Configuration variables (names only: values are never written in chat, in the repository or in logs)

**Vercel project `crm-staging` → Environment Variables (Production scope):**

| Name | Kind | Source |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | same (the anon key is designed to be public; RLS protects data) |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret, server only** | same: mark *Sensitive* in Vercel; never `NEXT_PUBLIC_` |
| `APP_URL` | config | the staging HTTPS origin, used for invite and password-reset links |
| `CRON_SECRET` | **secret** | random, 32+ bytes: protects the manual job triggers `/api/cron/*` |
| `WHATSAPP_APP_SECRET` | **secret** | Meta app → Settings → Basic (verifies webhook signatures) |
| `WHATSAPP_VERIFY_TOKEN` | **secret** | new random value; the same value is entered once in Meta |
| `WHATSAPP_ACCESS_TOKEN` | **secret** | **system-user token** for the test WABA (not a 24-hour temporary token) |
| `WHATSAPP_GRAPH_API_VERSION` | config | e.g. `v26.0` |

**Operator machine only (CLI and seed; never committed, never in Vercel):** `SUPABASE_ACCESS_TOKEN` (CLI login), `SUPABASE_DB_PASSWORD`, `SEED_TARGET_PROJECT_REF`, `SEED_DATABASE_URL`, `SEED_PASSWORD` (16+ characters, not the default); the seed script refuses a remote project unless all four are set and the reference matches.

**GitHub (only if you want a manual "apply migrations to staging" workflow):** environment `staging` with `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`. The existing CI needs none (it runs against a local Supabase stack).

**Entered in dashboards, not env vars:** Supabase Site URL and Redirect URLs, e-mail templates (`supabase/templates/*.html`), "Allow new users to sign up" **off**; Meta callback URL and verify token.

Needed from Meta (by you, in the Meta dashboard): app secret, a system user with a token limited to the test WABA (`whatsapp_business_messaging`, `whatsapp_business_management`), the phone number ID and WABA ID (identifiers, not secrets: they are deliberately not stored in this repository).

## 3. HTTPS webhook endpoint

`https://<staging-domain>/api/webhooks/whatsapp`, a normal route of the deployed app.

* Meta's handshake sends the verify token **in the URL**, so it will appear in Vercel's request logs. It only authorises the subscription handshake (message deliveries are authenticated by the HMAC signature, enforced), so: use a fresh random value for staging, and **rotate it right after verification succeeds** (change in Vercel + redeploy; Meta does not need it again).
* **Vercel Deployment Protection:** the default *Standard Protection* protects everything **except production domains**, so the webhook must be served from the project's **Production** deployment (hence "staging = the production environment of the staging project"). Preview deployments would answer Meta with a login page. Alternatively use *Protection Bypass for Automation*, which puts a secret in the URL: not preferred.
* Before touching Meta, I prove the endpoint from outside with the same checks used on the old tunnel: correct token → 200 with the exact challenge as plain text; wrong token → 403; unsigned/badly signed POST → 401; correctly signed empty POST → 200.
* The earlier Meta verification never reached the app (my temporary forwarder rejected Meta's request, cause unidentified). Staging removes that forwarder; if verification fails again, Vercel's logs will show exactly what Meta sent.

## 4. Migration plan (forward-only, empty database)

1. **Prerequisites (you):** private GitHub repository exists, local commit pushed, CI green.
2. **Dry run:** `npm run check:migrations`, then `supabase link --project-ref <crm-staging ref>` and `supabase db push --dry-run`. On an empty project this lists all 26 migrations. **I show you the output and wait for your OK.**
3. **Apply:** `supabase db push`. Migrations run in order; each is additive. `0870` enables `pg_cron` and creates 3 jobs; `0890` creates the two **private** Storage buckets.
4. **Read-only verification (SQL):** every `public` table has RLS enabled; `anon` has no table or function privileges; `cron.job` has 3 active jobs and `app.job_runs` fills; buckets `whatsapp-media` and `attachments` are private; the `app` schema is not exposed. Same checks the local tests perform, run against the cloud.
5. **Auth settings:** Site URL = `APP_URL`; sign-ups off; e-mail templates pasted; first super admin invited and promoted with the documented one-line SQL (`docs/DEPLOYMENT.md` §3.3).
6. **Data:** start empty. Optional fictional seed via the guarded script (requires explicit approval and the four seed variables).
7. **Deploy:** push to `staging`; Vercel builds with the variables above; `/api/health` must report `ok`, `service_role_configured` and `whatsapp_configured` true.
8. **Register the test number** in the staging admin screen (as super admin); *Test connection* and *Sync templates* must pass.
9. **Meta:** you set the callback URL and the new verify token; **I then check the dashboard result with you** (I don't claim success until Meta shows it). Subscribe the `messages` field.
10. **Live test:** the 9-step script in `docs/WHATSAPP_INTEGRATION.md` §Meta test setup (your phone → inbound message → automatic lead appears → claim and qualify → reply → `sent`/`delivered` events). Recorded with actual webhook events and your confirmation that the reply arrived.
11. **Close out:** rotate the verify token; revoke any temporary token; remove the old test-business subscription and the dead callback URL.

## 5. Rollback plan

| Situation | Action |
|---|---|
| Bad application deploy | Vercel *Instant Rollback* to the previous deployment (no database change) |
| Problem in `0950` only | `supabase/rollbacks/20261021000950_auto_leads.rollback.sql` (tested: restores the exact previous schema, grants and functions, and stops without deleting if feature data exists) |
| Any other migration problem | Forward-fix with a new migration. For staging, deleting and re-creating the `crm-staging` project is acceptable because it holds only test data (**explicit approval and a reference check required before any reset**) |
| Before every migration batch | `supabase db dump --linked` (schema) and a data dump, saved **outside the repository** and encrypted. Needed because the Free plan has **no automatic backups** |
| Mistaken target | The guards: only `crm-staging` is ever linked; seed refuses mismatched references; `check:migrations` flags destructive statements; nothing is run against any other project |

Production later follows the same steps in its own project **after** the staging test, with a fresh written approval, a verified backup and the Pro plan's daily backups.

## 6. Costs and plan limits (verified against vendor pages, 22 Oct 2026; re-check before buying)

| Item | Free option | Paid option | Recommendation |
|---|---|---|---|
| Supabase | **Free, $0:** 2 active projects, 500 MB database, **no automatic backups**, projects **pause after 1 week of low activity** (an unpaused project is needed for Meta deliveries) | **Pro, from $25/month per organization:** daily backups kept 7 days, never paused | Free is acceptable for staging with the dump habit above; Pro for production |
| Vercel | **Hobby, $0, but restricted to personal, non-commercial use** (their fair-use policy counts business use as commercial even without revenue) | **Pro, $20/month per developer seat** | Treat Pro as required for a business CRM; or ask Vercel Support in writing whether an internal staging project qualifies. Do not rely on Hobby |
| Domain / DNS | `*.vercel.app` (free, **no DNS change**) | custom subdomain later (one CNAME; WordPress untouched) | Free name for staging |
| E-mail | Supabase built-in sender (rate-limited) | own SMTP (e.g. a free transactional tier) | Built-in for staging |
| Meta | Test number, free | n/a | n/a |

Indicative staging total: **$0** (Free + Free, with the Hobby terms risk) to **about $45/month** (Supabase Pro + one Vercel Pro seat). I could not confirm from the Supabase pages I read whether `pg_cron` has any plan restriction on hosted projects; it works locally, and `0870` creates the extension itself. This is checked in step 3 (if it were unavailable, the manual `/api/cron/*` triggers remain).

## 6a. Decision comparison (vendor pages read 22 Oct 2026; prices change: re-check before buying)

### Vercel: Pro now, or ask Support first

| | **Pro** | **Ask Support (stay on Hobby meanwhile)** |
|---|---|---|
| Cost | **$20 / month per developer seat** (viewer seats unlimited) | $0 |
| Terms | Commercial use allowed | Hobby is **personal, non-commercial use only**. Vercel's fair-use page says commercial use "requires either a Pro or Enterprise plan" and tells unsure customers to contact Support. A Vercel community moderator treated even a no-revenue business showcase site as commercial. |
| What you get | Production-grade project, no use restriction | Nothing until Support answers in writing |
| Risk | None on terms | If the answer is "commercial" (likely for a company CRM) you have lost time; running the business app on Hobby in the meantime breaches the policy and risks suspension **in the middle of the Meta test** |
| Extra spend? | **No: production needs Pro anyway**, and staging + production can sit in the same Pro team under one seat | Delays the same spend |
| Recommendation | **Pro** (one seat). It is the same money you will spend for production, just earlier | Only worth it if you want a written answer for the record; do not deploy business data on Hobby while waiting |

### Supabase: Free or Pro for staging

| | **Free** | **Pro** |
|---|---|---|
| Price | $0 | from **$25 / month per organization**; includes $10 compute credit = one Micro instance. Each *additional* project in the same organization is billed its compute (about $10 for a Micro, derived from the credit) |
| Projects | 2 active projects per account (paused ones don't count) | no free-project cap; each project billed |
| Database | 500 MB, shared CPU, 500 MB RAM | 8 GB disk included, then $0.125 / GB |
| **Backups** | **None automatic** | Daily, kept **7 days**; point-in-time recovery is an add-on ($100 / month per 7 days of retention) |
| **Pausing** | **Pauses after 1 week of low activity** (official docs: restorable from the dashboard within 90 days). A paused project cannot receive Meta webhooks | Never paused |
| Fit for staging | Yes, with fictional data **and** a manual dump before every migration batch (§5). Unpause before each test session | Not needed for staging; **required for production** (backups, no pausing) |

### What it costs

| Scenario | Vercel | Supabase | Total / month | Notes |
|---|---|---|---|---|
| **Recommended** | Pro, 1 seat: $20 | Free: $0 | **about $20** | Production later adds Supabase Pro ($25+) only; Vercel stays the same seat |
| Everything free | Hobby: $0 | Free: $0 | $0 | **Not recommended**: Hobby terms; Free pausing and no backups |
| Maximum safety for staging | Pro: $20 | Pro: $25 | about $45 | Only if the test data matter (they don't: fictional) |

### `pg_cron` on hosted Supabase: still unresolved

I read Supabase's `pg_cron` extension page and its Cron page. **Neither states plan availability (Free or paid), how the extension is enabled, a limit on the number of jobs, or whether jobs count as activity that prevents a Free project from pausing.** What they do give is guidance: "no more than 8 jobs run concurrently", "each job should run no more than 10 minutes" (ours: 3 tiny jobs every 5 min, 15 min and daily). It works locally and migration `0870` runs `create extension` itself. **How it will be resolved:** step 3 of the migration plan (apply) shows the real result on the real project, and I report it before anything depends on it. **Fallback if it is not available or not permitted:** the same three SQL jobs can be triggered by the existing secured routes `/api/cron/whatsapp-retry` and `/api/cron/maintenance` (bearer `CRON_SECRET`), called by a free scheduled GitHub Actions workflow (minimum interval 5 minutes, may be delayed) or by Vercel Cron on Pro. That fallback is **not built or enabled**; it would be a separate approved change.

## 7. Risks and open points

* Meta verification failed before for an unidentified reason; staging gives logs to find out, but success is **not** guaranteed until Meta confirms it.
* The Free Supabase project may pause while idle: unpause it before a test session.
* The verify token appears in Vercel request logs (inherent to Meta's handshake); mitigated by rotation.
* The deployed app is publicly reachable (login page and all routes, not just the webhook). It is invite-only (sign-ups off), has rate limits, CSP and RLS; the earlier "webhook-only" restriction was specific to the tunnel.
* Region: Supabase and Vercel regions should be chosen close to your users and to each other; decided when you create the projects.

## 8. What I will and will not do

I will not create any cloud resource, push anything, deploy, change Meta or DNS, or apply any migration remotely until you approve. After approval I work only through the CLI on the one linked staging project, show each dry-run before applying, and never ask you to paste a secret into chat: you enter values yourself in Vercel, Supabase, GitHub and Meta.

## 9. Approval gates

| # | Gate | Needs from you |
|---|---|---|
| 1 | Local commit (not push) | Approve the changed-file summary and secret-scan result |
| 2 | GitHub private repository + push | Create it; tell me the name; approve the push |
| 3 | Supabase `crm-staging` project | Create it (own organization recommended); region; tell me the project reference |
| 4 | Vercel `crm-staging` project and plan | Create it, choose Pro (or get Support's answer), connect the repository, set the §2 variables yourself |
| 5 | Migration dry-run, then apply | Review the dry-run output, then approve `db push` to staging only |
| 6 | Meta | Create the system-user token; set the callback URL and verify token in the dashboard; add your phone as a recipient; I will not ask for any code or credentials |
| 7 | Live test | Send the test message from your phone; confirm the reply and statuses |
| 8 | Close-out | Approve rotation and clean-up |

## 10. Checklist: what you approve before any staging resource exists

Nothing below has been done. Tick each item; I create nothing until the items for the next step are ticked.

**Decisions (yours)**
- [ ] **Vercel plan:** Pro (recommended) or ask Support first (and deploy nothing business-related on Hobby meanwhile)
- [ ] **Supabase plan for staging:** Free with the manual-dump habit (recommended) or Pro
- [ ] **Accept the unresolved `pg_cron` point:** verify on the real project at apply time; fallback is the secured `/api/cron/*` routes (separate approval if needed)
- [ ] **Region** for Supabase and Vercel (choose when creating; keep them close to each other and to the users)
- [ ] **Domain:** use the free `*.vercel.app` name for staging (no DNS change); custom subdomain only later, with a separate approval
- [ ] **E-mail:** Supabase's built-in sender for staging (rate-limited); own SMTP only if invitations are blocked
- [ ] **Data:** staging starts empty; optional fictional seed only with explicit approval
- [ ] **Meta token:** a system-user token limited to the test WABA (not a 24-hour temporary token)

**Actions only you can take (I never ask for secret values; you enter them yourself)**
- [ ] Create the **private GitHub repository** and tell me its name, then approve the **push** of the local commit
- [ ] Create the Supabase project **`crm-staging`** (own organization recommended) and tell me its project reference (not a secret)
- [ ] Create the Vercel project **`crm-staging`**, connect the repository (`staging` branch as Production), choose the plan, and enter the variables in §2 in the Vercel dashboard
- [ ] In the Meta dashboard: remove the old test-business subscription and the dead callback URL; later set the new callback URL and verify token; add your phone as a permitted recipient

**Approvals I wait for (each is a separate gate, §9)**
- [ ] Push to GitHub, then CI green
- [ ] Migration **dry-run output reviewed**, then `db push` to `crm-staging` only
- [ ] First deploy and `/api/health` check
- [ ] Meta verification attempt, then the live test with your phone
- [ ] Close-out: token rotation, revocation of temporary tokens

**Standing guarantees:** no production resource, DNS record, WordPress site or production WhatsApp number is touched; migration `0950` is applied to no database except the local ones until you approve the staging dry-run; no secret is requested in chat, committed, or put into a URL that could be logged (local tests use a throwaway verify token).

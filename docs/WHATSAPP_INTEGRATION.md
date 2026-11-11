# WhatsApp integration

Official **WhatsApp Business Platform (Cloud API)** only: webhooks in, Graph API out. No WhatsApp Web scraping or browser automation.

## Current status (21 Oct 2026)

| Stage | Status |
|---|---|
| Inbox (filters, assignment, notes, statuses, failed/resend, 24 h notice, lead from conversation, move between companies) | **Done, browser-tested** |
| Webhook: verification, signature over raw body, parsing, idempotent ingestion, echoes, out-of-order statuses, failure statuses | **Done, tested** — unit tests + `tests/e2e/whatsapp.spec.ts` (signed payloads against the running app) |
| **Automatic lead per new conversation**, interest, courses/services catalogue, Inbox lead panel | **Done locally** (`0950`, see `docs/WHATSAPP_AUTO_LEADS.md`); tested with signed local payloads and parallel requests; **not verified against Meta** |
| Retries of failed events | **Done** — inside the database every 5 min (pg_cron, `0870`); tested incl. status-before-message race |
| Media: inbound (download → private Storage cache → signed URL) and outbound (signed upload → Meta upload → send) | **Done**, tested with a simulated number + unit tests with a mocked Graph API; **not yet against Meta** |
| Approved templates outside the 24 h window (sync from Meta, DB-rendered text) | **Done**. **Sync verified against Meta** (test WABA, 5 approved templates, 21 Oct 2026). Templates that need media headers, header/URL parameters, named parameters, carousels or copy-code buttons are marked unsupported and refused (`0940`) — found with Meta's sample templates. **Sending not yet verified against Meta.** |
| Credential health: alert super admins + the number's company admins on expired/revoked/invalid token; *Test connection* button | **Done**, tested (alert, dedupe, recovery, inbox banner). *Test connection* **verified against Meta** with the test number (21 Oct 2026); the expired-token path is not yet observed live |
| **Live Meta test number end-to-end** | **In progress.** The Meta-provided test number (its phone number ID and WABA ID are in your Meta dashboard, deliberately not recorded in this repository) was registered locally under the Ufuq demo company; connection test and template sync pass against Meta. **Inbound messages, replies and delivery statuses not yet verified** — they need a public webhook URL (staging or a temporary tunnel) |
| Production numbers | Not started — one number at a time, only with your written approval |

**The integration is not live.** Nothing has been sent to or received from Meta. A test-number run (below) is the gate before any production number.

> **Kapso Sandbox** (a separate, receive-only test integration with its own endpoint and a sandbox company, local only for now): see `docs/KAPSO_SANDBOX.md`. The Meta integration below is unchanged by it.

## Test setup — what you do (≈ 30 minutes, no production number involved)

### A. Meta app and test number
1. Go to <https://developers.facebook.com/apps> → **Create app** → use case *Other* → type **Business** → attach your Meta Business portfolio.
2. In the app → **Add product → WhatsApp → Set up**. Meta creates a **test WhatsApp Business Account** and a **test phone number** (free; can message up to 5 verified recipient numbers).
3. In *WhatsApp → API Setup*: add your own mobile as a **recipient** and confirm the code. Note (not secret, you may share these): **Phone number ID**, **WhatsApp Business Account ID**.
4. **Permanent token** (don't use the 24-hour temporary token beyond a first check):
   Business Settings → Users → **System users** → Add (role *Admin*) → **Add assets** → your app (*Full control*) and the WhatsApp account → **Generate token** for the app with permissions `whatsapp_business_messaging` and `whatsapp_business_management` → expiry *Never*.
5. App settings → Basic → **App secret** (Show).

### B. Put the values in Vercel (Preview / staging), never in chat
| Variable | Value |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | the system-user token from A.4 |
| `WHATSAPP_APP_SECRET` | the app secret from A.5 |
| `WHATSAPP_VERIFY_TOKEN` | a long random string you invent (`openssl rand -hex 24`) |
| `WHATSAPP_GRAPH_API_VERSION` | `v26.0` (or the version shown in your app dashboard) |
Redeploy, then `GET https://<staging>/api/health` must show `"whatsapp_configured": true`.

### C. Webhook
App → WhatsApp → **Configuration → Webhook → Edit**:
* Callback URL: `https://<staging>/api/webhooks/whatsapp`
* Verify token: the same `WHATSAPP_VERIFY_TOKEN` → **Verify and save** (our endpoint answers the challenge only with the right token).
* **Webhook fields → Subscribe**: `messages`. (Coexistence numbers later also: `smb_message_echoes`, `account_update`.)

### D. Register the number in the CRM
Super admin → *Administration → WhatsApp numbers → New number*: name, the test number, default company, **Phone number ID**, **WABA ID**, status **Test**. Grant yourself access (*can reply*). Click **Test connection** (must say *Connection works*) and **Sync templates** (Meta's test account includes `hello_world`, en_US).

### E. End-to-end test script (I'll run it with you; each line must pass before "live")
| # | Step | Expected |
|---|---|---|
| 1 | Send "مرحبا" from your verified phone to the test number | Appears in the inbox within seconds, unread badge, contact created |
| 2 | Re-deliver from Meta (*Webhooks → Test*, or wait for Meta's retry) | No duplicate message |
| 3 | Reply from the CRM | Phone receives it; ticks go sent → delivered → read in the CRM |
| 4 | Send a photo and a PDF from the phone | Photo previews, PDF downloads in the CRM |
| 5 | Send an image and a PDF from the CRM (attach button) | Both arrive on the phone |
| 6 | After 24 h without a customer message: send `hello_world` template | Arrives; free text is refused before that |
| 7 | Revoke the token (or set a wrong one in staging) → *Test connection* | Admins get the alert; inbox shows the warning; restore → alert clears |
| 8 | Send to a number not in the recipient list | Message shows as failed with Meta's error code; nothing retried forever |
| 9 | Tamper test: `POST` with a wrong signature | 401, nothing stored |

Only after all nine pass on staging do we call the integration "working with Meta".

## Your existing numbers: coexistence or migration (decide per number)

Your 4–6 numbers run on the **WhatsApp Business app** today. Two ways to bring each into the CRM:

**A. Coexistence — keep the phone app *and* use the CRM on the same number.** Per Meta's onboarding guide for Business-app users and current partner documentation (checked 21 Oct 2026):
* Onboarding **must** go through **Embedded Signup run by a Tech Provider or Solution Partner** (feature type `whatsapp_business_app_onboarding`). Your own Meta app can become a Tech Provider (business verification + app review), or you use a BSP that supports coexistence. Use the **current Embedded Signup version (v4)**; older versions are being deprecated.
* Phone app version **2.24.17+**; the owner confirms on the phone during signup.
* Up to **6 months of 1:1 history** can sync once at onboarding; groups don't.
* Limits: **20 messages/second** per number; broadcast lists, disappearing/view-once messages are disabled on the app; voice/video calls aren't available through the API in this mode.
* The phone app must stay in regular use (Meta disconnects after ~2 weeks of inactivity; `account_update` webhook).
* Messages typed on the phone arrive as `smb_message_echoes` — the CRM stores them as outbound **with no employee** (never credited to anyone).
* Onboarding volume for a new Tech Provider is capped (10 businesses / 7 days until verified) — fine for 4–6 numbers.
* **Eligibility varies by country and account. It must be confirmed per number in Embedded Signup before anything is promised or changed.**

**B. Full migration to Cloud API — the phone app stops working on that number.** Simpler and fully supported, but staff lose the phone app and the history stays on the phone.

| Number | Decision (A / B) | Eligibility checked | Your written approval |
|---|---|---|---|
| … | ⬜ | ⬜ | ⬜ |

**Nothing will be disconnected, migrated or re-registered without your written approval for that specific number.** The CRM needs no code change for either path (echo webhooks are already supported); coexistence needs the Embedded Signup flow, which I'll add once you choose the Tech Provider route.

## Architecture

```
Meta ──POST /api/webhooks/whatsapp──▶ verify X-Hub-Signature-256 (raw body) ── invalid → 401, nothing stored
                                        ▼
                                parse → events (message | echo | status)
                                        ▼
                         claim_webhook_event(event_key)  ── duplicate → skip
                                        ▼
        ingest_whatsapp_message / ingest_whatsapp_echo / apply_whatsapp_status
                                        ▼
                     finish_webhook_event: processed (payload redacted) | failed → pg_cron retry (≤ 8)
```

Replies: server action → `queue_outbound` with the **user's** session (grant + `can_reply`, ownership, account active, 24 h rule except templates, idempotent `client_request_id`, records `sent_by`) → Graph API with the server-side token → `record_outbound_result` (service role) → status webhooks move it forward only.

Media: inbound files are downloaded on first view (Meta URL valid 5 min, webhook media ids expire after 7 days), cached in the private `whatsapp-media` bucket, and served by a 60-second signed URL after an RLS check; only images/audio/video render inline, everything else downloads; unknown types are stored as opaque downloads. Outbound files go browser → private Storage (signed upload URL issued after checking the user may reply now) → server → Meta media upload → send. Images ≤ 5 MB, documents ≤ 25 MB.

| Concern | Implementation |
|---|---|
| Signature | HMAC-SHA256 with App Secret over raw bytes, constant-time compare |
| Idempotency | event key claim + `messages.wa_message_id UNIQUE`; outbound `client_request_id UNIQUE` |
| Retries (ours) | failed events re-dispatched in SQL every 5 min (≤ 8 attempts); purged after 30 days |
| Retries (Meta's) | 503 only when storage is down; per-event failures return 200 |
| Rate limits | 429 / 130429 / 131056 etc. retryable with backoff; sends 30/min per user |
| Credential errors | 190 / 102 / 10 / 200 / 299 / HTTP 401 → alert (super admins + company admins, once a day), audit, inbox banner; *Test connection* |
| 24-hour rule | enforced in the database; outside it only APPROVED templates, text rendered by the database |
| Tokens | System-user token in server env only; never in DB, logs or browser; media downloads only send it to Meta's CDN hosts |
| Retention | processed payloads redacted immediately; intake rows (incl. dead letters) purged after 30 days |

## Mapping

| Concept | Column |
|---|---|
| Number receiving the message | `conversations.whatsapp_account_id` |
| Company | `conversations.company_id` (default from the number; managers of both companies can move it, with a reason) |
| Contact | `conversations.contact_id` (matched by E.164 phone; created if new) |
| Owner | `conversations.owner_id` (history in `conversation_assignments`) |
| Sender of each outbound message | `messages.sent_by` (null for phone-app echoes) |
| Media file | `messages.media` (Meta id / storage path), cache in `message_media_cache` |
| Templates | `whatsapp_templates` (synced per number) |
| Credential health | `whatsapp_account_health` |

## Temporary tunnel test (21 Oct 2026) — outcome and cleanup

A path-restricted forwarder + Cloudflare quick tunnel exposed only `GET/POST /api/webhooks/whatsapp` (all other paths answered 404; 27 exposure checks passed through the public URL). The handshake returned 200 with the exact challenge for a correct token and 403 for a wrong one at every layer. **Meta's own verification requests did reach the tunnel (three, 14:02–14:04 UTC) but were rejected 404 by the forwarder's query-parameter rule before reaching the app**, and no later Meta request was seen, so **Meta verification never succeeded and no real inbound message, reply or delivery status was observed.** The cause of the rejection was not identified (the forwarder did not log parameter names until after those requests).

Cleanup (21 Oct 2026, 20:3x UTC): tunnel, forwarder and the temporary production server stopped; the public URL no longer answers (no connection). Environment variables and credentials were left in place; the verify token was rotated twice during the test (the earlier values should be treated as exposed and are no longer valid). **Still to do by you:** the test token expired (Graph error 190), so the app's subscription to the test WABA that was added only for this test could not be removed from here. Remove it in the Meta dashboard (WhatsApp → Configuration) or give me a fresh token in `.env.local` and I will do it; its callback URL still points at the dead tunnel address and should be cleared. The only other app subscribed to that WABA (Meta's own) was never touched.

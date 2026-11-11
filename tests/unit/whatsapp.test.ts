import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyMetaSignature, verifySubscriptionChallenge } from "../../src/lib/whatsapp/signature.ts";
import { parseWebhookPayload } from "../../src/lib/whatsapp/webhook-parser.ts";
import { sendTextMessage, isRetryable, backoffMs } from "../../src/lib/whatsapp/cloud-api.ts";
import {
  dbEventKind,
  handleWebhookPost, deserializeEvent, serializeEvent, safeErrorCode,
  type WebhookStore, type ClaimResult,
} from "../../src/lib/whatsapp/processor.ts";
import type { StatusEvent, WebhookEvent } from "../../src/lib/whatsapp/webhook-parser.ts";

const SECRET = "test-app-secret";
const sign = (body: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

// Shape follows Meta's documented webhook payload for the `messages` field.
function inboundPayload(id = "wamid.IN1", body = "مرحبا، أريد عرض سعر") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "97440000001", phone_number_id: "1234567890" },
          contacts: [{ profile: { name: "سارة" }, wa_id: "97455550001" }],
          messages: [{ from: "97455550001", id, timestamp: "1790000000", type: "text", text: { body } }],
        },
      }],
    }],
  };
}

function statusPayload(id: string, status: string, errors?: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "97440000001", phone_number_id: "1234567890" },
      statuses: [{ id, status, timestamp: "1790000100", recipient_id: "97455550001", ...(errors ? { errors } : {}) }],
    } }] }],
  };
}

// ------------------------------------------------------------- signatures
test("valid signature over the raw body is accepted", () => {
  const body = JSON.stringify(inboundPayload());
  assert.equal(verifyMetaSignature(body, sign(body), SECRET), true);
});

test("signature checks reject tampering, wrong secret, and malformed headers", () => {
  const body = JSON.stringify(inboundPayload());
  assert.equal(verifyMetaSignature(body + " ", sign(body), SECRET), false, "modified body");
  assert.equal(verifyMetaSignature(body, sign(body, "other"), SECRET), false, "wrong secret");
  assert.equal(verifyMetaSignature(body, null, SECRET), false, "missing header");
  assert.equal(verifyMetaSignature(body, "sha1=abc", SECRET), false, "wrong algorithm");
  assert.equal(verifyMetaSignature(body, sign(body).slice(0, -2), SECRET), false, "truncated");
  assert.equal(verifyMetaSignature(body, sign(body), ""), false, "empty secret never validates");
});

test("re-serialized JSON does not validate (raw bytes are required)", () => {
  const raw = '{"object":"whatsapp_business_account", "entry":[]}';
  const reserialized = JSON.stringify(JSON.parse(raw));
  assert.equal(verifyMetaSignature(reserialized, sign(raw), SECRET), false);
});

test("subscription handshake", () => {
  const p = (q: string) => new URLSearchParams(q);
  assert.deepEqual(verifySubscriptionChallenge(p("hub.mode=subscribe&hub.verify_token=tok&hub.challenge=123"), "tok"),
    { ok: true, challenge: "123" });
  assert.deepEqual(verifySubscriptionChallenge(p("hub.mode=subscribe&hub.verify_token=bad&hub.challenge=123"), "tok"), { ok: false });
  assert.deepEqual(verifySubscriptionChallenge(p("hub.mode=unsubscribe&hub.verify_token=tok&hub.challenge=1"), "tok"), { ok: false });
  assert.deepEqual(verifySubscriptionChallenge(p("hub.mode=subscribe&hub.verify_token=tok&hub.challenge=<script>"), "tok"), { ok: false });
  assert.deepEqual(verifySubscriptionChallenge(p("hub.mode=subscribe&hub.verify_token=&hub.challenge=1"), ""), { ok: false });
});

// --------------------------------------------------------------- parsing
test("inbound text message is parsed with profile name and stable key", () => {
  const r = parseWebhookPayload(inboundPayload());
  assert.deepEqual(r.errors, []);
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.kind, "message");
  if (e.kind !== "message") return;
  assert.equal(e.eventKey, "msg:wamid.IN1");
  assert.equal(e.phoneNumberId, "1234567890");
  assert.equal(e.fromWaId, "97455550001");
  assert.equal(e.profileName, "سارة");
  assert.equal(e.body, "مرحبا، أريد عرض سعر");
  assert.equal(e.sentAt.toISOString(), new Date(1790000000 * 1000).toISOString());
});

test("media, interactive, location and reaction messages produce readable bodies", () => {
  const p = inboundPayload();
  const value = p.entry[0].changes[0].value as Record<string, unknown>;
  value.messages = [
    { from: "97455550001", id: "m1", timestamp: "1790000000", type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", sha256: "x", caption: "الفاتورة" } },
    { from: "97455550001", id: "m2", timestamp: "1790000000", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "نعم" } } },
    { from: "97455550001", id: "m3", timestamp: "1790000000", type: "location", location: { latitude: 25.28, longitude: 51.53, name: "Doha" } },
    { from: "97455550001", id: "m4", timestamp: "1790000000", type: "reaction", reaction: { message_id: "x", emoji: "👍" } },
    { from: "97455550001", id: "m5", timestamp: "1790000000", type: "unsupported" },
  ];
  const events = parseWebhookPayload(p).events;
  const by = (id: string) => events.find((e) => e.kind === "message" && e.waMessageId === id) as Extract<WebhookEvent, { kind: "message" }>;
  assert.equal(by("m1").body, "الفاتورة");
  assert.deepEqual(by("m1").media, { id: "MEDIA1", mimeType: "image/jpeg", sha256: "x", filename: undefined, caption: "الفاتورة" });
  assert.equal(by("m2").body, "نعم");
  assert.equal(by("m3").body, "Doha 25.28,51.53");
  assert.equal(by("m4").body, "👍");
  assert.equal(by("m5").body, null);
  assert.equal(by("m5").messageType, "unsupported");
});

test("status events carry errors and keys per status transition", () => {
  const r = parseWebhookPayload(statusPayload("wamid.OUT", "failed", [{ code: 131047, title: "Re-engagement message" }]));
  const e = r.events[0] as StatusEvent;
  assert.equal(e.kind, "status");
  assert.equal(e.eventKey, "status:wamid.OUT:failed");
  assert.equal(e.errorCode, "131047");
  assert.equal(e.errorMessage, "Re-engagement message");
});

test("coexistence echoes are parsed as business-sent messages", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "smb_message_echoes", value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: "1234567890" },
      message_echoes: [{ from: "97440000001", to: "97455550001", id: "wamid.ECHO", timestamp: "1790000200", type: "text", text: { body: "sent from phone" } }],
    } }] }],
  };
  const r = parseWebhookPayload(payload);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "echo");
  assert.equal(r.events[0].eventKey, "echo:wamid.ECHO");
});

test("malformed items are reported without dropping valid ones", () => {
  const p = inboundPayload();
  const value = p.entry[0].changes[0].value as Record<string, unknown>;
  (value.messages as unknown[]).push({ id: "no-from", timestamp: "1790000000", type: "text" });
  (value.messages as unknown[]).push({ from: "97455550001", id: "bad-ts", timestamp: "yesterday", type: "text" });
  const r = parseWebhookPayload(p);
  assert.equal(r.events.length, 1);
  assert.equal(r.errors.length, 2);
});

test("non-WhatsApp and unrelated fields are ignored safely", () => {
  assert.deepEqual(parseWebhookPayload({ object: "page" }).errors, ["payload.not_whatsapp_business_account"]);
  assert.deepEqual(parseWebhookPayload(null).errors, ["payload.not_whatsapp_business_account"]);
  const r = parseWebhookPayload({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "account_update", value: {} }] }] });
  assert.deepEqual(r.ignoredFields, ["account_update"]);
  assert.equal(r.events.length, 0);
});

test("very long bodies are clipped to WhatsApp's limit", () => {
  const r = parseWebhookPayload(inboundPayload("x", "a".repeat(10_000)));
  const e = r.events[0];
  assert.equal(e.kind === "message" && e.body?.length, 4096);
});

// ---------------------------------------------------------- processor
class FakeStore implements WebhookStore {
  events = new Map<string, { status: string; attempts: number; error?: string }>();
  messages = new Map<string, { body: string | null; outbound: boolean }>();
  statuses = new Map<string, string>();
  failNextIngest = false;
  down = false;

  async claimEvent(e: { eventKey: string }): Promise<ClaimResult> {
    if (this.down) throw new Error("connection refused");
    const ex = this.events.get(e.eventKey);
    if (!ex) { this.events.set(e.eventKey, { status: "pending", attempts: 1 }); return "new"; }
    if (ex.status === "processed" || ex.status === "ignored") return "duplicate";
    ex.attempts++; return "retry";
  }
  async finishEvent(key: string, status: "processed" | "failed" | "ignored", error?: string) {
    const ex = this.events.get(key)!; ex.status = status; ex.error = error;
  }
  async ingestMessage(e: Extract<WebhookEvent, { kind: "message" }>) {
    if (this.failNextIngest) { this.failNextIngest = false; throw new Error("whatsapp.unknown_phone_number_id"); }
    const dup = this.messages.has(e.waMessageId);
    if (!dup) this.messages.set(e.waMessageId, { body: e.body, outbound: false });
    return { duplicate: dup };
  }
  async ingestEcho(e: Extract<WebhookEvent, { kind: "echo" }>) {
    const dup = this.messages.has(e.waMessageId);
    if (!dup) this.messages.set(e.waMessageId, { body: e.body, outbound: true });
    return { duplicate: dup };
  }
  async applyStatus(e: StatusEvent) {
    if (!this.messages.has(e.waMessageId)) return false;
    this.statuses.set(e.waMessageId, e.status);
    return true;
  }
}

test("duplicate webhook deliveries create one message", async () => {
  const store = new FakeStore();
  const body = JSON.stringify(inboundPayload());
  const first = await handleWebhookPost(body, sign(body), SECRET, store);
  const second = await handleWebhookPost(body, sign(body), SECRET, store);
  assert.equal(first.httpStatus, 200);
  assert.equal(first.processed, 1);
  assert.equal(second.processed, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(store.messages.size, 1);
});

test("invalid signature is rejected before anything is stored", async () => {
  const store = new FakeStore();
  const body = JSON.stringify(inboundPayload());
  const r = await handleWebhookPost(body, sign(body, "attacker"), SECRET, store);
  assert.equal(r.httpStatus, 401);
  assert.equal(store.events.size, 0);
});

test("invalid JSON with a valid signature is a 400", async () => {
  const r = await handleWebhookPost("{not json", sign("{not json"), SECRET, new FakeStore());
  assert.equal(r.httpStatus, 400);
});

test("a failing event is recorded for retry with a safe error code, and retried successfully", async () => {
  const store = new FakeStore();
  store.failNextIngest = true;
  const body = JSON.stringify(inboundPayload());
  const first = await handleWebhookPost(body, sign(body), SECRET, store);
  assert.equal(first.httpStatus, 200, "Meta is not asked to redeliver for a per-event failure");
  assert.equal(first.failed, 1);
  const ev = store.events.get("msg:wamid.IN1")!;
  assert.equal(ev.status, "failed");
  assert.equal(ev.error, "whatsapp.unknown_phone_number_id", "only the error key is stored, never message content");
  const second = await handleWebhookPost(body, sign(body), SECRET, store);
  assert.equal(second.processed, 1);
  assert.equal(store.events.get("msg:wamid.IN1")!.attempts, 2);
});

test("storage outage returns 503 so Meta redelivers", async () => {
  const store = new FakeStore();
  store.down = true;
  const body = JSON.stringify(inboundPayload());
  assert.equal((await handleWebhookPost(body, sign(body), SECRET, store)).httpStatus, 503);
});

test("status for an unknown message is kept for retry instead of being lost", async () => {
  const store = new FakeStore();
  const body = JSON.stringify(statusPayload("wamid.LATER", "delivered"));
  const r = await handleWebhookPost(body, sign(body), SECRET, store);
  assert.equal(r.failed, 1);
  assert.equal(store.events.get("status:wamid.LATER:delivered")!.error, "status.message_not_found");
});

test("events survive serialization for the retry queue", () => {
  const e = parseWebhookPayload(inboundPayload()).events[0];
  const back = deserializeEvent(JSON.parse(JSON.stringify(serializeEvent(e))));
  assert.deepEqual(back, e);
  assert.equal(deserializeEvent({ kind: "bogus" }), null);
});

test("safeErrorCode never leaks free text", () => {
  assert.equal(safeErrorCode(new Error("duplicate key value violates unique constraint (customer said: hi)")), "processing_error");
  assert.equal(safeErrorCode(new Error("conversation.not_found")), "conversation.not_found");
  assert.equal(safeErrorCode(new Error("failed for omar@example.com")), "processing_error", "dotted user data is not a key");
});

// -------------------------------------------------------------- sending
function fakeFetch(status: number, json: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

test("successful send returns Meta's message id", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const f = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.SENT" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await sendTextMessage({ phoneNumberId: "1234567890", accessToken: "TOKEN", toWaId: "97455550001", body: "hi", fetchImpl: f });
  assert.deepEqual(r, { ok: true, waMessageId: "wamid.SENT" });
  assert.equal(captured!.url, "https://graph.facebook.com/v26.0/1234567890/messages");
  assert.equal((captured!.init.headers as Record<string, string>).Authorization, "Bearer TOKEN");
  assert.deepEqual(JSON.parse(captured!.init.body as string).text, { preview_url: false, body: "hi" });
});

test("24h-window error is permanent; rate limits and 5xx are retryable", async () => {
  const outside = await sendTextMessage({ phoneNumberId: "1234567890", accessToken: "t", toWaId: "97455550001", body: "x",
    fetchImpl: fakeFetch(400, { error: { message: "Re-engagement message", code: 131047 } }) });
  assert.equal(outside.ok, false);
  assert.equal(!outside.ok && outside.retryable, false);
  assert.equal(!outside.ok && outside.code, "131047");

  const limited = await sendTextMessage({ phoneNumberId: "1234567890", accessToken: "t", toWaId: "97455550001", body: "x",
    fetchImpl: fakeFetch(400, { error: { message: "Rate limit hit", code: 130429 } }) });
  assert.equal(!limited.ok && limited.retryable, true);

  const expired = await sendTextMessage({ phoneNumberId: "1234567890", accessToken: "t", toWaId: "97455550001", body: "x",
    fetchImpl: fakeFetch(401, { error: { message: "Error validating access token", code: 190 } }) });
  assert.equal(!expired.ok && expired.retryable, false, "expired token needs an admin, not retries");

  assert.equal(isRetryable(503, null), true);
  assert.equal(isRetryable(null, null), true, "network failure");
});

test("network errors are retryable and inputs are validated before any request", async () => {
  const boom = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const r = await sendTextMessage({ phoneNumberId: "1234567890", accessToken: "t", toWaId: "97455550001", body: "x", fetchImpl: boom });
  assert.equal(!r.ok && r.code, "network_error");
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const bad = await sendTextMessage({ phoneNumberId: "../evil", accessToken: "t", toWaId: "97455550001", body: "x", fetchImpl: spy });
  assert.equal(!bad.ok && bad.code, "invalid_phone_number_id");
  assert.equal(called, false);
});

test("backoff grows exponentially with jitter and is capped", () => {
  assert.equal(backoffMs(0, 1000, 60_000, () => 0), 500);
  assert.equal(backoffMs(3, 1000, 60_000, () => 1), 8000);
  assert.equal(backoffMs(20, 1000, 60_000, () => 1), 60_000);
});

test("echo events are stored with an allowed event_kind (the DB accepts message|status|other)", () => {
  assert.equal(dbEventKind("echo"), "message");
  assert.equal(dbEventKind("message"), "message");
  assert.equal(dbEventKind("status"), "status");
});

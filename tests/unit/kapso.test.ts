import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readBodyLimited, verifyKapsoSignature } from "../../src/lib/kapso/signature.ts";
import { verifyMetaSignature } from "../../src/lib/whatsapp/signature.ts";
import {
  KAPSO_EVENT_NAMES,
  KAPSO_MAX_BATCH_ITEMS,
  normalizeWaId,
  parseKapsoPayload,
  type KapsoEvent,
  type KapsoEventName,
  type KapsoMessageEvent,
  type KapsoStatusEvent,
} from "../../src/lib/kapso/parser.ts";
import {
  handleKapsoPost,
  kapsoDbEventKind,
  safeKapsoErrorCode,
  serializeKapsoEvent,
  type KapsoStore,
} from "../../src/lib/kapso/processor.ts";
import type { ClaimResult } from "../../src/lib/whatsapp/processor.ts";

// A throwaway constant for tests only; never a real Kapso secret.
const SECRET = "unit-test-kapso-secret-0123456789";
const enc = (s: string) => new TextEncoder().encode(s);
const sign = (body: string | Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

// ------------------------------------------------------------------ fixtures
// Shapes follow Kapso's documented v2 payloads (docs.kapso.ai, webhook event types).
const PNID = "sandbox-pnid-001";
const WAMID = "wamid.HBgLMTU1NTAwMDAwMDEVAgASGBQzQTAx";

function conversation(extra: Record<string, unknown> = {}) {
  return { id: "conv-1", contact_name: "سارة", phone_number: "+15550000111", phone_number_id: PNID, status: "active", ...extra };
}
function received(id = WAMID, text = "مرحبا، أريد عرض سعر", extra: Record<string, unknown> = {}) {
  return {
    message: {
      id, timestamp: "1790000000", type: "text", from: "15550000111", text: { body: text },
      kapso: { direction: "inbound", status: "received", content: text },
      ...extra,
    },
    conversation: conversation(),
    is_new_conversation: true,
    phone_number_id: PNID,
  };
}
function outbound(id: string, status: string, extra: Record<string, unknown> = {}, kapso: Record<string, unknown> = {}) {
  return {
    message: {
      id, timestamp: "1790000100", type: "text", to: "15550000111", text: { body: "answer" },
      kapso: { direction: "outbound", status, content: "answer", ...kapso },
      ...extra,
    },
    conversation: conversation(),
    is_new_conversation: false,
    phone_number_id: PNID,
  };
}
const post = (payload: unknown, event: string | null, opts: { version?: string | null; secret?: string; signWith?: string } = {}) => {
  const raw = enc(typeof payload === "string" ? payload : JSON.stringify(payload));
  return {
    rawBody: raw,
    signature: sign(raw, opts.signWith ?? SECRET),
    eventName: event,
    payloadVersion: opts.version === undefined ? "v2" : opts.version,
  };
};

// ----------------------------------------------------------------- signature
test("kapso: a valid hex signature over the raw body is accepted (any hex case, string or bytes)", () => {
  const body = JSON.stringify(received());
  assert.equal(verifyKapsoSignature(body, sign(body), SECRET), true);
  assert.equal(verifyKapsoSignature(enc(body), sign(body).toUpperCase(), SECRET), true);
  assert.equal(verifyKapsoSignature(enc(body), `  ${sign(body)}  `, SECRET), true, "surrounding whitespace in the header is tolerated");
});

test("kapso: signature checks reject tampering, wrong secret and malformed headers", () => {
  const body = JSON.stringify(received());
  const good = sign(body);
  assert.equal(verifyKapsoSignature(body + " ", good, SECRET), false, "modified body");
  assert.equal(verifyKapsoSignature(body, sign(body, "another-secret-0123456789"), SECRET), false, "wrong secret");
  assert.equal(verifyKapsoSignature(body, null, SECRET), false, "missing header");
  assert.equal(verifyKapsoSignature(body, "", SECRET), false, "empty header");
  assert.equal(verifyKapsoSignature(body, good.slice(0, -2), SECRET), false, "truncated");
  assert.equal(verifyKapsoSignature(body, good + "00", SECRET), false, "too long");
  assert.equal(verifyKapsoSignature(body, "z".repeat(64), SECRET), false, "not hex");
  assert.equal(verifyKapsoSignature(body, good, ""), false, "empty secret never validates");
  assert.equal(verifyKapsoSignature(body, `sha256=${good}`, SECRET), false, "Meta's prefix is not Kapso's format");
});

test("kapso: the signature covers the exact bytes, not the parsed JSON", () => {
  const compact = JSON.stringify(received());
  const pretty = JSON.stringify(received(), null, 2);
  assert.deepEqual(JSON.parse(compact), JSON.parse(pretty));
  assert.equal(verifyKapsoSignature(pretty, sign(compact), SECRET), false, "same data, different bytes");
  // Multi-byte characters: signed as UTF-8 bytes.
  const arabic = JSON.stringify(received(WAMID, "السلام عليكم ✓"));
  assert.equal(verifyKapsoSignature(enc(arabic), sign(enc(arabic)), SECRET), true);
});

test("kapso and Meta signatures are not interchangeable", () => {
  const body = JSON.stringify(received());
  const kapsoSig = sign(body);
  const metaSig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  assert.equal(verifyMetaSignature(body, kapsoSig, SECRET), false, "a Kapso signature is no Meta signature");
  assert.equal(verifyKapsoSignature(body, metaSig, SECRET), false, "a Meta signature is no Kapso signature");
});

// ------------------------------------------------------------ bounded body
function streamOf(chunks: Uint8Array[], onPull?: () => void) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

test("kapso: readBodyLimited returns the bytes, accepts exactly the limit and cuts off beyond it", async () => {
  const a = enc("hello "), b = enc("world");
  assert.equal(new TextDecoder().decode((await readBodyLimited(streamOf([a, b]), 11)) as Uint8Array), "hello world");
  assert.equal(await readBodyLimited(streamOf([a, b]), 10), "too_large");
  assert.equal((await readBodyLimited(null, 10) as Uint8Array).length, 0);
});

test("kapso: an endless body is abandoned at the limit instead of being buffered", async () => {
  let pulls = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
  });
  assert.equal(await readBodyLimited(endless, 10 * 1024), "too_large");
  assert.ok(pulls <= 12, `read ${pulls} chunks`);
});

// -------------------------------------------------------------------- parser
function only<T extends KapsoEvent>(events: KapsoEvent[], kind: T["kind"]): T {
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, kind);
  return events[0] as T;
}

test("kapso parser: received text message", () => {
  const r = parseKapsoPayload(received(), "whatsapp.message.received");
  assert.deepEqual(r.errors, []);
  const e = only<KapsoMessageEvent>(r.events, "kapso_message");
  assert.equal(e.eventKey, `kapso:msg:${WAMID}`);
  assert.equal(e.phoneNumberId, PNID);
  assert.equal(e.fromWaId, "15550000111");
  assert.equal(e.profileName, "سارة");
  assert.equal(e.messageType, "text");
  assert.equal(e.body, "مرحبا، أريد عرض سعر");
  assert.equal(e.sentAt.toISOString(), new Date(1790000000 * 1000).toISOString());
});

test("kapso parser: the customer phone falls back to the conversation, and is normalized", () => {
  const p = received();
  delete (p.message as Record<string, unknown>).from;
  const e = only<KapsoMessageEvent>(parseKapsoPayload(p, "whatsapp.message.received").events, "kapso_message");
  assert.equal(e.fromWaId, "15550000111", "taken from conversation.phone_number without the +");
  assert.equal(normalizeWaId("+1 (555) 000-0111"), "15550000111");
  assert.equal(normalizeWaId("0123"), null);
  assert.equal(normalizeWaId("abc"), null);
  assert.equal(normalizeWaId("1".repeat(16)), null);
});

test("kapso parser: media messages keep type and caption but reference no media in Phase 1", () => {
  const p = received(WAMID, "x", { type: "image", text: undefined, image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "صورة المنتج" } });
  const e = only<KapsoMessageEvent>(parseKapsoPayload(p, "whatsapp.message.received").events, "kapso_message");
  assert.equal(e.messageType, "image");
  assert.equal(e.body, "صورة المنتج");
  assert.equal(JSON.stringify(e).includes("MEDIA1"), false, "no media id is carried");
  const audio = received(WAMID, "x", { type: "audio", text: undefined, audio: { id: "A1" } });
  (audio.message as { kapso: Record<string, unknown> }).kapso.content = undefined;
  const a = only<KapsoMessageEvent>(parseKapsoPayload(audio, "whatsapp.message.received").events, "kapso_message");
  assert.equal(a.messageType, "audio");
  assert.equal(a.body, null);
});

test("kapso parser: interactive replies and reactions show their text", () => {
  const i = received(WAMID, "x", { type: "interactive", text: undefined, interactive: { button_reply: { id: "b1", title: "نعم" } } });
  assert.equal(only<KapsoMessageEvent>(parseKapsoPayload(i, "whatsapp.message.received").events, "kapso_message").body, "نعم");
  const r = received(WAMID, "x", { type: "reaction", text: undefined, reaction: { emoji: "👍" } });
  assert.equal(only<KapsoMessageEvent>(parseKapsoPayload(r, "whatsapp.message.received").events, "kapso_message").body, "👍");
});

test("kapso parser: over-long bodies are clipped", () => {
  const e = only<KapsoMessageEvent>(parseKapsoPayload(received(WAMID, "a".repeat(9000)), "whatsapp.message.received").events, "kapso_message");
  assert.equal(e.body?.length, 4096);
});

test("kapso parser: invalid received messages are reported, not thrown", () => {
  const noPhone = received();
  delete (noPhone.message as Record<string, unknown>).from;
  noPhone.conversation = conversation({ phone_number: undefined });
  const cases: Array<[string, unknown, string]> = [
    ["no customer phone", noPhone, "item[0].missing_customer_phone"],
    ["bad timestamp", received(WAMID, "x", { timestamp: "soon" }), "item[0].invalid_timestamp"],
    ["id with control characters", received("wamid.A\nB"), "item[0].invalid_message_id"],
    ["id with a colon (event-key injection)", received("a:b"), "item[0].invalid_message_id"],
    ["no id", received(""), "item[0].invalid_message_id"],
    ["no phone_number_id", { ...received(), phone_number_id: undefined, conversation: conversation({ phone_number_id: undefined }) }, "item[0].invalid_phone_number_id"],
    ["phone_number_id with spaces", { ...received(), phone_number_id: "a b" }, "item[0].invalid_phone_number_id"],
    ["no message object", { conversation: conversation() }, "item[0].missing_message"],
    ["direction says outbound", received(WAMID, "x", { kapso: { direction: "outbound" } }), "item[0].direction_mismatch"],
  ];
  for (const [label, payload, code] of cases) {
    const r = parseKapsoPayload(payload, "whatsapp.message.received");
    assert.deepEqual(r.events, [], label);
    assert.deepEqual(r.errors, [code], label);
  }
  assert.deepEqual(parseKapsoPayload("nope", "whatsapp.message.received").errors, ["payload.not_object"]);
  assert.deepEqual(parseKapsoPayload([received()], "whatsapp.message.received").errors, ["payload.not_object"]);
});

test("kapso parser: sent, delivered and read share the wamid but have distinct, namespaced keys", () => {
  const keys = new Set<string>();
  for (const [event, status] of [["sent", "sent"], ["delivered", "delivered"], ["read", "read"], ["failed", "failed"]] as const) {
    const name = `whatsapp.message.${event}` as KapsoEventName;
    const r = parseKapsoPayload(outbound("wamid.OUT1", status), name);
    assert.deepEqual(r.errors, [], event);
    const e = only<KapsoStatusEvent>(r.events, "kapso_status");
    assert.equal(e.status, status);
    assert.equal(e.waMessageId, "wamid.OUT1");
    assert.equal(e.toWaId, "15550000111");
    assert.equal(e.body, "answer");
    keys.add(e.eventKey);
    assert.ok(e.eventKey.startsWith("kapso:status:wamid.OUT1:"), "namespaced: cannot collide with Meta's status:/msg: keys");
  }
  assert.equal(keys.size, 4);
  assert.equal(parseKapsoPayload(received(), "whatsapp.message.received").events[0].eventKey.startsWith("kapso:msg:"), true);
});

test("kapso parser: failed events carry the first error of the failed status entry", () => {
  const failedKapso = {
    statuses: [
      { id: "wamid.F1", status: "sent", timestamp: "1790000050", recipient_id: "15550000111" },
      { id: "wamid.F1", status: "failed", timestamp: "1790000100", recipient_id: "15550000111",
        errors: [{ code: 131047, title: "Re-engagement message", message: "More than 24 hours have passed", href: "https://example.invalid" }] },
    ],
  };
  const e = only<KapsoStatusEvent>(parseKapsoPayload(outbound("wamid.F1", "failed", {}, failedKapso), "whatsapp.message.failed").events, "kapso_status");
  assert.equal(e.errorCode, "131047");
  assert.equal(e.errorMessage, "Re-engagement message");
  const bare = only<KapsoStatusEvent>(parseKapsoPayload(outbound("wamid.F2", "failed"), "whatsapp.message.failed").events, "kapso_status");
  assert.equal(bare.errorCode, null);
  assert.equal(bare.errorMessage, null);
  const delivered = only<KapsoStatusEvent>(parseKapsoPayload(outbound("wamid.F3", "delivered", {}, failedKapso), "whatsapp.message.delivered").events, "kapso_status");
  assert.equal(delivered.errorCode, null, "errors are only read for failed events");
});

test("kapso parser: a status without a customer phone keeps toWaId null; the conversation fills the gap", () => {
  const noTo = outbound("wamid.T1", "delivered");
  delete (noTo.message as Record<string, unknown>).to;
  assert.equal(only<KapsoStatusEvent>(parseKapsoPayload(noTo, "whatsapp.message.delivered").events, "kapso_status").toWaId, "15550000111");
  noTo.conversation = conversation({ phone_number: undefined });
  assert.equal(only<KapsoStatusEvent>(parseKapsoPayload(noTo, "whatsapp.message.delivered").events, "kapso_status").toWaId, null);
});

test("kapso parser: the header event must agree with the signed body's direction", () => {
  assert.deepEqual(parseKapsoPayload(outbound("wamid.D1", "sent"), "whatsapp.message.received").errors, ["item[0].direction_mismatch"]);
  assert.deepEqual(parseKapsoPayload(received(), "whatsapp.message.delivered").errors, ["item[0].direction_mismatch"]);
  // No direction in the body: accepted, the header decides.
  const bare = outbound("wamid.D2", "sent");
  (bare.message as { kapso: unknown }).kapso = undefined;
  assert.equal(parseKapsoPayload(bare, "whatsapp.message.sent").events.length, 1);
});

test("kapso parser: batches yield one event per item and survive a bad item", () => {
  const batch = {
    type: "whatsapp.message.received", batch: true,
    data: [received("wamid.B1", "one"), received("wamid.B2", "two"), received("a:b", "bad"), received("wamid.B3", "three")],
    batch_info: { size: 4 },
  };
  const r = parseKapsoPayload(batch, "whatsapp.message.received");
  assert.deepEqual(r.events.map((e) => e.waMessageId), ["wamid.B1", "wamid.B2", "wamid.B3"]);
  assert.deepEqual(r.errors, ["item[2].invalid_message_id"]);
});

test("kapso parser: batch limits and shape", () => {
  const big = { batch: true, data: Array.from({ length: KAPSO_MAX_BATCH_ITEMS + 1 }, (_, i) => received(`wamid.X${i}`)) };
  assert.deepEqual(parseKapsoPayload(big, "whatsapp.message.received"), { events: [], errors: ["batch.too_large"] });
  const exact = { batch: true, data: Array.from({ length: KAPSO_MAX_BATCH_ITEMS }, (_, i) => received(`wamid.X${i}`)) };
  assert.equal(parseKapsoPayload(exact, "whatsapp.message.received").events.length, KAPSO_MAX_BATCH_ITEMS);
  assert.deepEqual(parseKapsoPayload({ batch: true }, "whatsapp.message.received").errors, ["batch.missing_data"]);
  assert.deepEqual(parseKapsoPayload({ batch: true, data: [] }, "whatsapp.message.received").events, []);
});

test("kapso parser: company or account ids in the payload are never read", () => {
  const p = received();
  Object.assign(p, { company_id: "00000000-0000-0000-0000-00000000c0de", whatsapp_account_id: "acct-evil", account_id: "evil" });
  Object.assign(p.message, { company_id: "00000000-0000-0000-0000-00000000c0de" });
  const e = parseKapsoPayload(p, "whatsapp.message.received").events[0];
  const serialized = JSON.stringify(serializeKapsoEvent(e));
  assert.equal(/company|account|evil|c0de/i.test(serialized), false, serialized);
});

// ----------------------------------------------------------------- processor
class FakeKapsoStore implements KapsoStore {
  events = new Map<string, { status: string; attempts: number; error?: string }>();
  messages = new Map<string, { body: string | null; outbound: boolean; status?: string; error?: string | null }>();
  failNextIngest = false;
  down = false;
  calls = 0;

  async claimEvent(e: { eventKey: string }): Promise<ClaimResult> {
    if (this.down) throw new Error("connection refused");
    await Promise.resolve();
    const ex = this.events.get(e.eventKey);
    if (!ex) { this.events.set(e.eventKey, { status: "pending", attempts: 1 }); return "new"; }
    if (ex.status === "processed" || ex.status === "ignored") return "duplicate";
    ex.attempts++; return "retry";
  }
  async finishEvent(key: string, status: "processed" | "failed" | "ignored", error?: string) {
    const ex = this.events.get(key)!; ex.status = status; ex.error = error;
  }
  async ingestMessage(e: KapsoMessageEvent) {
    this.calls++;
    if (this.failNextIngest) { this.failNextIngest = false; throw new Error("kapso.unknown_account"); }
    const dup = this.messages.has(e.waMessageId);
    if (!dup) this.messages.set(e.waMessageId, { body: e.body, outbound: false, status: "received" });
    return { duplicate: dup };
  }
  async applyStatus(e: KapsoStatusEvent) {
    this.calls++;
    let m = this.messages.get(e.waMessageId);
    if (!m) {
      if (!e.toWaId) return false;
      m = { body: e.body, outbound: true };
      this.messages.set(e.waMessageId, m);
    }
    const rank = ["sent", "delivered", "read"];
    if (e.status === "failed" || rank.indexOf(e.status) > rank.indexOf(m.status ?? "")) { m.status = e.status; m.error = e.errorCode; }
    return true;
  }
}

test("kapso processor: an invalid signature is refused first and touches nothing", async () => {
  const store = new FakeKapsoStore();
  // Even with an unsupported version, invalid JSON and an unknown event, the signature decides first.
  for (const req of [
    post(received(), "whatsapp.message.received", { signWith: "wrong-secret-0123456789012" }),
    { ...post(received(), "whatsapp.message.received"), signature: null },
    { ...post(received(), "whatsapp.message.received"), signature: "sha256=" + sign(enc(JSON.stringify(received()))) },
    { ...post("{not json", "nope", { version: "v1", signWith: "wrong-secret-0123456789012" }) },
  ]) {
    const r = await handleKapsoPost(req, SECRET, store);
    assert.equal(r.httpStatus, 401);
    assert.deepEqual(r.parseErrors, [], "nothing about the request is revealed");
  }
  assert.equal(store.events.size, 0);
  assert.equal(store.calls, 0);
});

// Policy since the invalid-event remediation (docs/KAPSO_WEBHOOK_LIFECYCLE.md): a signed delivery that cannot be processed is RECORDED
// as a quarantine row (failed, kind kapso_quarantined, keyed by the body fingerprint) and then acknowledged with 200 - it used to be
// answered 400 or ignored with nothing stored, i.e. silently lost. Nothing is ingested in any of these cases.
test("kapso processor: unsupported or missing payload versions are recorded as invalid (after the signature), never processed", async () => {
  const store = new FakeKapsoStore();
  for (const version of ["v1", "v3", "V2", "", null, "2"]) {
    const r = await handleKapsoPost(post(received(), "whatsapp.message.received", { version }), SECRET, store);
    assert.equal(r.httpStatus, 200, `version ${JSON.stringify(version)}`);
    assert.deepEqual([r.quarantined + r.duplicates, r.processed], [1, 0]);
    assert.deepEqual(r.parseErrors, ["payload.unsupported_version"]);
  }
  assert.equal(store.events.size, 1, "the same signed bytes map to one row");
  const [key, ev] = [...store.events][0];
  assert.match(key, /^kapso:invalid_payload:[0-9a-f]{64}$/);
  assert.deepEqual([ev.status, ev.error], ["failed", "payload.unsupported_version"]);
  assert.equal(store.calls, 0);
});

test("kapso processor: signed invalid JSON / UTF-8 is recorded as invalid, never guessed", async () => {
  const store = new FakeKapsoStore();
  const r = await handleKapsoPost(post("{not json", "whatsapp.message.received"), SECRET, store);
  assert.deepEqual([r.httpStatus, r.quarantined], [200, 1]);
  assert.deepEqual(r.parseErrors, ["payload.invalid_json"]);
  const bad = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
  const r2 = await handleKapsoPost({ rawBody: bad, signature: sign(bad), eventName: "whatsapp.message.received", payloadVersion: "v2" }, SECRET, store);
  assert.deepEqual([r2.httpStatus, r2.quarantined, r2.parseErrors], [200, 1, ["payload.invalid_json"]], "invalid UTF-8");
  assert.equal(store.events.size, 2);
  assert.equal(store.calls, 0);
});

test("kapso processor: a signed event we do not handle is recorded for investigation and acknowledged; nothing is ingested", async () => {
  const store = new FakeKapsoStore();
  for (const name of ["whatsapp.conversation.created", "whatsapp.message.reaction", "", null]) {
    const r = await handleKapsoPost(post(received(), name), SECRET, store);
    assert.equal(r.httpStatus, 200, String(name));
    assert.equal(r.quarantined + r.duplicates, 1);
    assert.deepEqual(r.parseErrors, ["event.unsupported"]);
  }
  assert.equal(store.events.size, 1, "same body -> one row");
  assert.equal([...store.events.values()][0].error, "event.unsupported");
  assert.equal(store.calls, 0);
});

test("kapso processor: all five event types are accepted and applied in order", async () => {
  const store = new FakeKapsoStore();
  assert.equal((await handleKapsoPost(post(received("wamid.OUT9"), "whatsapp.message.received"), SECRET, store)).processed, 1);
  assert.equal(KAPSO_EVENT_NAMES.length, 5);
  for (const status of ["sent", "delivered", "read"]) {
    const r = await handleKapsoPost(post(outbound("wamid.OUT1", status), `whatsapp.message.${status}`), SECRET, store);
    assert.deepEqual([r.httpStatus, r.processed, r.failed], [200, 1, 0], status);
  }
  assert.equal(store.messages.get("wamid.OUT1")?.status, "read");
  const failed = outbound("wamid.OUT2", "failed", {}, { statuses: [{ status: "failed", errors: [{ code: 131026, title: "Undeliverable" }] }] });
  const f = await handleKapsoPost(post(failed, "whatsapp.message.failed"), SECRET, store);
  assert.deepEqual([f.httpStatus, f.processed], [200, 1]);
  assert.equal(store.messages.get("wamid.OUT2")?.status, "failed");
  assert.equal(store.messages.get("wamid.OUT2")?.error, "131026");
});

test("kapso processor: redelivery (Kapso retry) is a duplicate, not a second message", async () => {
  const store = new FakeKapsoStore();
  const req = post(received("wamid.RETRY"), "whatsapp.message.received");
  const first = await handleKapsoPost(req, SECRET, store);
  const second = await handleKapsoPost(req, SECRET, store);
  assert.deepEqual([first.processed, first.duplicates], [1, 0]);
  assert.deepEqual([second.processed, second.duplicates], [0, 1]);
  assert.equal(store.messages.size, 1);
});

test("kapso processor: parallel duplicate deliveries create one message", async () => {
  const store = new FakeKapsoStore();
  const req = post(received("wamid.PAR"), "whatsapp.message.received");
  const results = await Promise.all(Array.from({ length: 8 }, () => handleKapsoPost(req, SECRET, store)));
  assert.equal(results.every((r) => r.httpStatus === 200), true);
  assert.equal(store.messages.size, 1);
  assert.equal(results.reduce((n, r) => n + r.failed, 0), 0);
});

test("kapso processor: duplicates inside one batch and across batches", async () => {
  const store = new FakeKapsoStore();
  const batch = (ids: string[]) => ({ type: "whatsapp.message.received", batch: true, data: ids.map((id) => received(id)), batch_info: { size: ids.length } });
  const r1 = await handleKapsoPost(post(batch(["wamid.A", "wamid.B", "wamid.A"]), "whatsapp.message.received"), SECRET, store);
  assert.deepEqual([r1.processed, r1.duplicates, r1.failed], [2, 1, 0]);
  const r2 = await handleKapsoPost(post(batch(["wamid.B", "wamid.C"]), "whatsapp.message.received"), SECRET, store);
  assert.deepEqual([r2.processed, r2.duplicates], [1, 1]);
  assert.deepEqual([...store.messages.keys()].sort(), ["wamid.A", "wamid.B", "wamid.C"]);
});

test("kapso processor: an oversized batch is recorded as ONE invalid delivery and none of its items is processed", async () => {
  const store = new FakeKapsoStore();
  const big = { batch: true, data: Array.from({ length: KAPSO_MAX_BATCH_ITEMS + 1 }, (_, i) => received(`wamid.Z${i}`)) };
  const r = await handleKapsoPost(post(big, "whatsapp.message.received"), SECRET, store);
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed, r.parseErrors], [200, 1, 0, ["batch.too_large"]]);
  assert.equal(store.events.size, 1);
  assert.match([...store.events.keys()][0], /^kapso:invalid_payload:/);
  assert.equal(store.calls, 0);
});

test("kapso processor: a status that arrives before its message is applied when the customer is named", async () => {
  const store = new FakeKapsoStore();
  const r = await handleKapsoPost(post(outbound("wamid.EARLY", "delivered"), "whatsapp.message.delivered"), SECRET, store);
  assert.deepEqual([r.processed, r.failed], [1, 0]);
  // The earlier "sent" arrives late: it does not move the status backwards.
  const late = await handleKapsoPost(post(outbound("wamid.EARLY", "sent"), "whatsapp.message.sent"), SECRET, store);
  assert.deepEqual([late.processed, late.failed], [1, 0]);
  assert.equal(store.messages.get("wamid.EARLY")?.status, "delivered");
  assert.equal(store.messages.size, 1);
});

test("kapso processor: a status for an unknown message without a customer is recorded as failed, to retry", async () => {
  const store = new FakeKapsoStore();
  const p = outbound("wamid.LOST", "delivered");
  delete (p.message as Record<string, unknown>).to;
  p.conversation = conversation({ phone_number: undefined });
  const r = await handleKapsoPost(post(p, "whatsapp.message.delivered"), SECRET, store);
  assert.deepEqual([r.httpStatus, r.processed, r.failed], [200, 0, 1], "still 200: Kapso must not hammer us");
  assert.deepEqual(store.events.get("kapso:status:wamid.LOST:delivered"), { status: "failed", attempts: 1, error: "status.message_not_found" });
});

test("kapso processor: one failing event never blocks the rest of the batch and stores a stable code only", async () => {
  const store = new FakeKapsoStore();
  store.failNextIngest = true;
  const batch = { batch: true, data: [received("wamid.F1", "secret customer words"), received("wamid.F2")] };
  const r = await handleKapsoPost(post(batch, "whatsapp.message.received"), SECRET, store);
  assert.deepEqual([r.httpStatus, r.processed, r.failed], [200, 1, 1]);
  assert.equal(store.events.get("kapso:msg:wamid.F1")?.error, "kapso.unknown_account");
  assert.equal(JSON.stringify([...store.events.values()]).includes("secret customer words"), false);
  // The failed event is claimed again on redelivery and now succeeds.
  const again = await handleKapsoPost(post(received("wamid.F1", "secret customer words"), "whatsapp.message.received"), SECRET, store);
  assert.deepEqual([again.processed, again.duplicates], [1, 0]);
});

test("kapso processor: unavailable storage answers 503 so the delivery is retried", async () => {
  const store = new FakeKapsoStore();
  store.down = true;
  const r = await handleKapsoPost(post(received(), "whatsapp.message.received"), SECRET, store);
  assert.equal(r.httpStatus, 503);
});

test("kapso retry payloads use exactly the keys process_webhook_retries reads", () => {
  const m = only<KapsoMessageEvent>(parseKapsoPayload(received(), "whatsapp.message.received").events, "kapso_message");
  const sm = serializeKapsoEvent(m);
  assert.deepEqual(Object.keys(sm).sort(), ["body", "eventKey", "fromWaId", "kind", "media", "messageType", "phoneNumberId", "profileName", "sentAt", "waMessageId"]);
  assert.equal(sm.kind, "kapso_message");
  assert.equal(typeof sm.sentAt, "string");
  assert.equal(sm.media, null);
  const s = only<KapsoStatusEvent>(parseKapsoPayload(outbound("wamid.S1", "failed"), "whatsapp.message.failed").events, "kapso_status");
  const ss = serializeKapsoEvent(s);
  assert.deepEqual(Object.keys(ss).sort(), ["body", "errorCode", "errorMessage", "eventKey", "kind", "media", "messageType", "phoneNumberId", "sentAt", "status", "toWaId", "waMessageId"]);
  assert.equal(ss.kind, "kapso_status");
  assert.equal(kapsoDbEventKind("kapso_message"), "message");
  assert.equal(kapsoDbEventKind("kapso_status"), "status");
});

test("kapso error codes: database rule keys survive (as Error or Supabase plain object); anything else is generic", () => {
  assert.equal(safeKapsoErrorCode(new Error("kapso.unknown_account")), "kapso.unknown_account");
  assert.equal(safeKapsoErrorCode({ code: "42501", details: null, hint: null, message: "kapso.message_account_mismatch" }), "kapso.message_account_mismatch");
  assert.equal(safeKapsoErrorCode({ message: 'duplicate key value violates unique constraint "contacts_phone_key" (+15550000111)' }), "processing_error", "no customer data in stored errors");
  assert.equal(safeKapsoErrorCode("Kapso.Unknown"), "processing_error");
  assert.equal(safeKapsoErrorCode(null), "processing_error");
  assert.equal(safeKapsoErrorCode({ message: 42 }), "processing_error");
});

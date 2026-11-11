import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  classifyOrigin, handleKapsoPostV2, parseKapsoPayloadV2, quarantinePayload, safeDeliveryLog, serializeKapsoEventV2, KAPSO_BSUID_PATHS,
  type HeldRecord, type KapsoAccountClass, type KapsoHeld, type KapsoInboundV2, type KapsoStatusV2, type KapsoStoreV2,
} from "../../src/lib/kapso/v2.ts";
import { createKapsoStoreV2, type RpcClient } from "../../src/lib/kapso/store-v2.ts";
import type { ClaimResult } from "../../src/lib/whatsapp/processor.ts";

const SECRET = "unit-test-kapso-secret-0123456789"; // throwaway, tests only
const enc = (s: string) => new TextEncoder().encode(s);
const sign = (b: string | Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(b).digest("hex");
const PNID = "pnid-A";
const BS_PATHS = [["conversation", "test_only_user_id"]] as const; // TEST-ONLY override location (the real fields: KAPSO_BSUID_PATHS)

function item(
  direction: "inbound" | "outbound",
  id: string,
  extra: { origin?: string; kapso?: Record<string, unknown>; from?: string | null; to?: string | null; conv?: Record<string, unknown>; pnid?: string; text?: string } = {},
) {
  const phone = "15550000111";
  return {
    message: {
      id, timestamp: "1790000000", type: "text", text: { body: extra.text ?? "secret customer words" },
      ...(direction === "inbound" ? (extra.from === null ? {} : { from: extra.from ?? phone }) : (extra.to === null ? {} : { to: extra.to ?? phone })),
      kapso: { direction, content: extra.text ?? "secret customer words", ...(extra.origin ? { origin: extra.origin } : {}), ...extra.kapso },
    },
    conversation: { id: "c1", contact_name: "Sara", phone_number_id: extra.pnid ?? PNID, ...extra.conv },
    phone_number_id: extra.pnid ?? PNID,
  };
}
const req = (payload: unknown, event: string, o: { sig?: string; version?: string | null } = {}) => {
  const raw = enc(typeof payload === "string" ? payload : JSON.stringify(payload));
  return { rawBody: raw, signature: o.sig ?? sign(raw), eventName: event, payloadVersion: o.version === undefined ? "v2" : o.version };
};
const RECEIVED = "whatsapp.message.received", SENT = "whatsapp.message.sent", DELIVERED = "whatsapp.message.delivered", FAILED = "whatsapp.message.failed";

class FakeStore implements KapsoStoreV2 {
  events = new Map<string, { status: string; attempts: number; error?: string; payload: unknown; kind: string }>();
  inbound: KapsoInboundV2[] = [];
  statuses: KapsoStatusV2[] = [];
  touched: string[] = [];
  seenWamids = new Set<string>();
  down = false;
  failTouch = false;
  statusApplicable = true;
  accounts = new Map<string, KapsoAccountClass>();
  /** names of store methods that throw like an unreachable database */
  failing = new Set<string>();
  calls: string[] = [];
  private gate(name: string) {
    this.calls.push(name);
    if (this.down || this.failing.has(name)) throw new Error("connection refused");
  }
  // mirrors claim_kapso_event: a non-final row gets the NEW payload
  async claimEvent(e: { eventKey: string; kind: "message" | "status"; phoneNumberId: string; payload: unknown }): Promise<ClaimResult> {
    this.gate("claimEvent");
    await Promise.resolve();
    const ex = this.events.get(e.eventKey);
    if (!ex) { this.events.set(e.eventKey, { status: "pending", attempts: 1, payload: e.payload, kind: e.kind }); return "new"; }
    if (ex.status === "processed" || ex.status === "ignored") return "duplicate";
    ex.attempts++; ex.payload = e.payload;
    return "retry";
  }
  // mirrors finish_kapso_event: processed/ignored rows lose their payload; processed/ignored are terminal for every later finish
  async finishEvent(key: string, status: "processed" | "failed" | "ignored", error?: string): Promise<"finished" | "already_final"> {
    this.gate("finishEvent");
    const ex = this.events.get(key)!;
    if (ex.status === "processed" || ex.status === "ignored") return "already_final";
    ex.status = status; ex.error = status === "failed" ? error : undefined;
    if (status !== "failed") ex.payload = {};
    return "finished";
  }
  // mirrors record_kapso_held_event: only an existing quarantine record may be replaced
  async recordHeld(e: HeldRecord): Promise<"recorded" | "duplicate"> {
    this.gate("recordHeld");
    const ex = this.events.get(e.eventKey);
    if (ex && (ex.status === "processed" || ex.status === "ignored" || (ex.payload as { kind?: string })?.kind !== "kapso_quarantined")) return "duplicate";
    const payload = e.status === "ignored" ? {} : e.payload;
    if (ex) { ex.attempts++; ex.status = e.status; ex.error = e.status === "failed" ? e.reason : undefined; ex.payload = payload; }
    else this.events.set(e.eventKey, { status: e.status, attempts: 1, error: e.status === "failed" ? e.reason : undefined, payload, kind: e.kind });
    return "recorded";
  }
  async accountClass(pn: string): Promise<KapsoAccountClass> { this.gate("accountClass"); return this.accounts.has(pn) ? this.accounts.get(pn)! : "production"; }
  async ingestInbound(e: KapsoInboundV2) {
    const dup = this.seenWamids.has(e.waMessageId);
    this.seenWamids.add(e.waMessageId);
    if (!dup) this.inbound.push(e);
    return { duplicate: dup };
  }
  async applyStatus(e: KapsoStatusV2) { this.statuses.push(e); return this.statusApplicable; }
  async touchAccount(p: string) { if (this.failTouch) throw new Error("boom"); this.touched.push(p); }
}

// ------------------------------------------------------------------------------------------------ origin classification
test("kapso v2 origin: customer, CRM/API, echoes, history_sync and unknown values are decided in one pure place", () => {
  assert.deepEqual(classifyOrigin("inbound", null), { class: "customer" });
  assert.deepEqual(classifyOrigin("inbound", "cloud_api"), { class: "customer" });
  assert.deepEqual(classifyOrigin("outbound", null), { class: "crm_or_api" });
  assert.deepEqual(classifyOrigin("outbound", "cloud_api"), { class: "crm_or_api" });
  for (const o of ["business_app", "other_app", "meta_business_agent"] as const) assert.deepEqual(classifyOrigin("outbound", o), { class: "echo", origin: o });
  assert.deepEqual(classifyOrigin("inbound", "history_sync"), { class: "history_sync" });
  assert.deepEqual(classifyOrigin("outbound", "history_sync"), { class: "history_sync" });
  // never silently a customer message:
  assert.deepEqual(classifyOrigin("inbound", "something_new"), { class: "quarantine", reason: "origin.unknown" });
  assert.deepEqual(classifyOrigin("inbound", "business_app"), { class: "quarantine", reason: "origin.direction_conflict" });
  assert.deepEqual(classifyOrigin("outbound", "something_new"), { class: "quarantine", reason: "origin.unknown" });
});

test("kapso v2 parser: the five event kinds produce the right typed events", () => {
  const r = parseKapsoPayloadV2(item("inbound", "wamid.IN1"), RECEIVED);
  assert.deepEqual(r.errors, []);
  const e = r.events[0] as KapsoInboundV2;
  assert.equal(e.kind, "kapso_inbound_v2");
  assert.equal(e.eventKey, "kapso:msg:wamid.IN1");
  assert.equal(e.fromWaId, "15550000111");
  assert.equal(e.fromBsuid, null);
  assert.equal(e.origin, null);
  for (const [ev, st] of [[SENT, "sent"], [DELIVERED, "delivered"], ["whatsapp.message.read", "read"], [FAILED, "failed"]] as const) {
    const s = parseKapsoPayloadV2(item("outbound", "wamid.O1"), ev).events[0] as KapsoStatusV2;
    assert.equal(s.kind, "kapso_status_v2");
    assert.equal(s.status, st);
    assert.equal(s.eventKey, `kapso:status:wamid.O1:${st}`);
  }
});

test("kapso v2 parser: unusual origin text is never stored; it quarantines", () => {
  const r = parseKapsoPayloadV2(item("inbound", "wamid.X1", { origin: "Robert'); DROP TABLE" }), RECEIVED);
  const h = r.events[0] as KapsoHeld;
  assert.equal(h.kind, "held");
  assert.equal(h.decision, "quarantine");
  assert.equal(h.origin, "invalid");
  assert.equal(JSON.stringify(quarantinePayload(h)).includes("DROP"), false);
});

// ------------------------------------------------------------------------------------------------ BSUID
test("kapso v2 BSUID: the documented fields per direction; parent ids and usernames are never read", () => {
  assert.deepEqual(KAPSO_BSUID_PATHS, {
    inbound: [["message", "from_user_id"], ["conversation", "business_scoped_user_id"]],
    outbound: [["conversation", "business_scoped_user_id"]],
  });
  // only an undocumented / non-customer field: no identity, nothing invented
  const noPhone = item("inbound", "wamid.B1", { from: null, conv: { test_only_user_id: "US.13491208655302741918", phone_number: null } });
  const r = parseKapsoPayloadV2(noPhone, RECEIVED);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.errors, ["item[0].missing_customer_identity"]);
  assert.equal(r.invalid.length, 1, "the item is not dropped: it becomes a quarantine record");
  assert.equal(r.invalid[0].eventKey, "kapso:msg:wamid.B1", "logical key: a later delivery/reprocess of the same event completes the same row");
  assert.deepEqual(r.invalid[0].rawItem, noPhone, "the original item is kept so it can be reprocessed");
  const parentsOnly = item("inbound", "wamid.B1p", { from: null, kapso: {}, conv: { parent_business_scoped_user_id: "US.ENT.506847293015824", username: "@someone", phone_number: null } });
  (parentsOnly.message as Record<string, unknown>).from_parent_user_id = "US.ENT.506847293015824";
  (parentsOnly.message as Record<string, unknown>).username = "@someone";
  assert.deepEqual(parseKapsoPayloadV2(parentsOnly, RECEIVED).errors, ["item[0].missing_customer_identity"], "a parent BSUID or a username is not the customer's BSUID");
});

/** A BSUID-only item as Kapso documents it: message.from omitted, conversation.phone_number null. */
function bsuidOnly(direction: "inbound" | "outbound", id: string, o: { msgUser?: string; convUser?: string } = {}) {
  const it = item(direction, id, { from: null, to: null, conv: { phone_number: null, ...(o.convUser ? { business_scoped_user_id: o.convUser } : {}) } });
  if (o.msgUser) (it.message as Record<string, unknown>).from_user_id = o.msgUser;
  return it;
}

test("kapso v2 BSUID: BSUID-only customers parse from either documented inbound field; no E.164 is derived", () => {
  for (const [label, o] of [["message.from_user_id", { msgUser: "US.13491208655302741918" }], ["conversation.business_scoped_user_id", { convUser: "US.13491208655302741918" }],
    ["both, same value", { msgUser: "US.13491208655302741918", convUser: "US.13491208655302741918" }]] as const) {
    const r = parseKapsoPayloadV2(bsuidOnly("inbound", "wamid.BO1", o), RECEIVED);
    assert.deepEqual(r.errors, [], label);
    const e = r.events[0] as KapsoInboundV2;
    assert.deepEqual([e.fromWaId, e.fromBsuid], [null, "US.13491208655302741918"], label);
    const ser = serializeKapsoEventV2(e);
    assert.deepEqual([ser.fromWaId, ser.fromBsuid], [null, "US.13491208655302741918"], `${label}: retry payload`);
  }
  // a BSUID-shaped value in message.from is never read as a phone number
  const odd = item("inbound", "wamid.BO2", { from: "US.13491208655302741918", conv: { business_scoped_user_id: "US.13491208655302741918", phone_number: null } });
  const e = parseKapsoPayloadV2(odd, RECEIVED).events[0] as KapsoInboundV2;
  assert.deepEqual([e.fromWaId, e.fromBsuid], [null, "US.13491208655302741918"]);
});

test("kapso v2 BSUID: BSUID + E.164 travel together; formatting differences of one phone are not a conflict", () => {
  const it = item("inbound", "wamid.BE1", { conv: { business_scoped_user_id: "US.1", phone_number: "+1 555-000-0111" } });
  const e = parseKapsoPayloadV2(it, RECEIVED).events[0] as KapsoInboundV2;
  assert.deepEqual([e.fromWaId, e.fromBsuid], ["15550000111", "US.1"]);
});

test("kapso v2 BSUID: conflicting identity fields are quarantined, never resolved by picking one", () => {
  const twoBsuids = bsuidOnly("inbound", "wamid.CF1", { msgUser: "US.111", convUser: "US.222" });
  const twoPhones = item("inbound", "wamid.CF2", { from: "15550000111", conv: { phone_number: "15550000999" } });
  const outPhones = item("outbound", "wamid.CF3", { to: "15550000111", conv: { phone_number: "15550000999" } });
  for (const [it, ev] of [[twoBsuids, RECEIVED], [twoPhones, RECEIVED], [outPhones, SENT]] as const) {
    const r = parseKapsoPayloadV2(it, ev);
    assert.deepEqual([r.events.length, r.errors], [0, ["item[0].conflicting_customer_identity"]]);
    assert.equal(r.invalid[0].reason, "conflicting_customer_identity");
    assert.equal(r.invalid[0].rawItem, null, "not recoverable: no content is kept");
    assert.match(r.invalid[0].eventKey, /^kapso:invalid:[0-9a-f]{64}$/);
  }
});

test("kapso v2 BSUID: outbound reads only conversation.business_scoped_user_id", () => {
  const s = parseKapsoPayloadV2(bsuidOnly("outbound", "wamid.OB1", { convUser: "US.333" }), SENT).events[0] as KapsoStatusV2;
  assert.deepEqual([s.toWaId, s.toBsuid], [null, "US.333"]);
  const msgSide = parseKapsoPayloadV2(bsuidOnly("outbound", "wamid.OB2", { msgUser: "US.444" }), SENT).events[0] as KapsoStatusV2;
  assert.deepEqual([msgSide.toWaId, msgSide.toBsuid], [null, null], "message.from_user_id of an outbound item is not documented as the customer");
  const none = parseKapsoPayloadV2(bsuidOnly("outbound", "wamid.OB3"), SENT);
  assert.deepEqual([none.errors, (none.events[0] as KapsoStatusV2).toBsuid], [[], null], "a status without identity still parses (known wamids need none)");
});

test("kapso v2 BSUID pipeline: conflicting item -> quarantined (200); BSUID-only redelivery is a duplicate", async () => {
  const s = new FakeStore();
  const r = await handleKapsoPostV2(req({ batch: true, data: [bsuidOnly("inbound", "wamid.PL1", { msgUser: "US.1", convUser: "US.2" }), bsuidOnly("inbound", "wamid.PL2", { msgUser: "US.5" })] }, RECEIVED), SECRET, s);
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed], [200, 1, 1]);
  assert.equal([...s.events.values()].find((e) => e.status === "failed")?.error, "invalid.conflicting_customer_identity");
  const again = await handleKapsoPostV2(req(bsuidOnly("inbound", "wamid.PL2", { msgUser: "US.5" }), RECEIVED), SECRET, s);
  assert.deepEqual([again.duplicates, s.inbound.length], [1, 1]);
  assert.deepEqual([s.inbound[0].fromWaId, s.inbound[0].fromBsuid], [null, "US.5"]);
});

test("BSUID-only send refusal has a user message in both locales", async () => {
  const { userMessage } = await import("../../src/lib/errors.ts");
  for (const l of ["ar", "en"] as const) assert.notEqual(userMessage({ message: "whatsapp.recipient_phone_unknown" }, l), userMessage({ message: "nope" }, l));
  const en = readFileSync(new URL("../../src/i18n/en.ts", import.meta.url), "utf8"), ar = readFileSync(new URL("../../src/i18n/ar.ts", import.meta.url), "utf8");
  assert.ok(en.includes("bsuidOnlyNoSend:") && ar.includes("bsuidOnlyNoSend:"));
});

test("kapso v2 BSUID: with a (test-only) location the BSUID travels as its own identity and no E.164 is derived", () => {
  const p = item("inbound", "wamid.B2", { from: null, conv: { test_only_user_id: "US.13491208655302741918" } });
  const e = parseKapsoPayloadV2(p, RECEIVED, { bsuidPaths: BS_PATHS }).events[0] as KapsoInboundV2;
  assert.equal(e.fromWaId, null);
  assert.equal(e.fromBsuid, "US.13491208655302741918");
  const both = parseKapsoPayloadV2(item("inbound", "wamid.B3", { conv: { test_only_user_id: "BS-9" } }), RECEIVED, { bsuidPaths: BS_PATHS }).events[0] as KapsoInboundV2;
  assert.deepEqual([both.fromWaId, both.fromBsuid], ["15550000111", "BS-9"]);
  const ser = serializeKapsoEventV2(e);
  assert.equal(ser.fromWaId, null);
  assert.equal(ser.fromBsuid, "US.13491208655302741918");
  const bad = parseKapsoPayloadV2(item("inbound", "wamid.B4", { from: null, conv: { test_only_user_id: "has space" } }), RECEIVED, { bsuidPaths: BS_PATHS });
  assert.deepEqual(bad.errors, ["item[0].missing_customer_identity"], "a malformed BSUID is not accepted");
  const status = parseKapsoPayloadV2(item("outbound", "wamid.B5", { to: null, conv: { test_only_user_id: "BS-5" } }), SENT, { bsuidPaths: BS_PATHS }).events[0] as KapsoStatusV2;
  assert.deepEqual([status.toWaId, status.toBsuid], [null, "BS-5"]);
});

// ------------------------------------------------------------------------------------------------ retry payload keys vs the SQL
test("kapso v2 retry payloads carry exactly the keys the Rev6 process_webhook_retries branches read", () => {
  const sql = readFileSync(new URL("../../supabase/proposed/20261104000970_kapso_production.sql", import.meta.url), "utf8");
  const branch = (kind: string) => {
    const i = sql.indexOf(`when '${kind}' then`);
    assert.ok(i > 0, kind);
    const j = sql.indexOf("when '", i + 10);
    return new Set([...sql.slice(i, j).matchAll(/p ->> '(\w+)'/g)].map((m) => m[1]));
  };
  const inb = serializeKapsoEventV2(parseKapsoPayloadV2(item("inbound", "wamid.R1"), RECEIVED).events[0] as KapsoInboundV2);
  const st = serializeKapsoEventV2(parseKapsoPayloadV2(item("outbound", "wamid.R2"), FAILED).events[0] as KapsoStatusV2);
  assert.equal(inb.kind, "kapso_inbound_v2");
  assert.equal(st.kind, "kapso_status_v2");
  assert.ok(branch("kapso_inbound_v2").size >= 8 && branch("kapso_status_v2").size >= 10, "the SQL branches were found");
  for (const k of branch("kapso_inbound_v2")) assert.ok(k in inb, `inbound payload lacks ${k}`);
  for (const k of branch("kapso_status_v2")) assert.ok(k in st, `status payload lacks ${k}`);
  assert.equal(typeof inb.sentAt, "string");
});

// ------------------------------------------------------------------------------------------------ handler
test("kapso v2 handler: invalid signature -> 401 first, nothing claimed, nothing revealed", async () => {
  const s = new FakeStore();
  const r = await handleKapsoPostV2(req(item("inbound", "wamid.S1"), RECEIVED, { sig: sign("other body") }), SECRET, s);
  assert.equal(r.httpStatus, 401);
  assert.equal(s.events.size, 0);
  assert.equal(s.inbound.length, 0);
  assert.deepEqual(r.parseErrors, [], "nothing about the request is revealed");
});

test("kapso v2 handler: the signature covers the raw bytes (whitespace, escapes); a re-serialised body is refused", async () => {
  const s = new FakeStore();
  const rawPretty = enc(JSON.stringify(item("inbound", "wamid.S2"), null, 2));
  const compact = enc(JSON.stringify(item("inbound", "wamid.S2")));
  assert.equal((await handleKapsoPostV2({ rawBody: rawPretty, signature: sign(rawPretty), eventName: RECEIVED, payloadVersion: "v2" }, SECRET, s)).httpStatus, 200);
  assert.equal((await handleKapsoPostV2({ rawBody: compact, signature: sign(rawPretty), eventName: RECEIVED, payloadVersion: "v2" }, SECRET, s)).httpStatus, 401, "same JSON value, different bytes");
  const escaped = enc(JSON.stringify(item("inbound", "wamid.S3", { text: "café" })).replace("é", "\\u00e9"));
  assert.equal((await handleKapsoPostV2({ rawBody: escaped, signature: sign(escaped), eventName: RECEIVED, payloadVersion: "v2" }, SECRET, s)).httpStatus, 200);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...compact]);
  const withBom = await handleKapsoPostV2({ rawBody: bom, signature: sign(bom), eventName: RECEIVED, payloadVersion: "v2" }, SECRET, s);
  assert.equal(withBom.httpStatus, 200, "a UTF-8 BOM is part of the signed bytes and is tolerated by the decoder");
  assert.equal((await handleKapsoPostV2({ rawBody: bom, signature: sign(compact), eventName: RECEIVED, payloadVersion: "v2" }, SECRET, s)).httpStatus, 401, "...but the signature must cover the BOM too");
  const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
  const bad = await handleKapsoPostV2({ rawBody: invalidUtf8, signature: sign(invalidUtf8), eventName: RECEIVED, payloadVersion: "v2" }, SECRET, s);
  assert.deepEqual([bad.httpStatus, bad.quarantined, bad.processed, bad.parseErrors], [200, 1, 0, ["payload.invalid_json"]], "signed but not valid UTF-8/JSON is never guessed: recorded, then acknowledged");
});

test("kapso v2 handler: version, JSON and event-name problems come after the signature and are RECORDED (one row each), never dropped", async () => {
  const s = new FakeStore();
  const v = await handleKapsoPostV2(req(item("inbound", "wamid.V1"), RECEIVED, { version: "v1" }), SECRET, s);
  const j = await handleKapsoPostV2(req("{nope", RECEIVED), SECRET, s);
  const u = await handleKapsoPostV2(req(item("inbound", "wamid.V2"), "whatsapp.something.else"), SECRET, s);
  for (const [r, code] of [[v, "payload.unsupported_version"], [j, "payload.invalid_json"], [u, "event.unsupported"]] as const) {
    assert.deepEqual([r.httpStatus, r.quarantined, r.parseErrors], [200, 1, [code]], code);
  }
  assert.equal(s.events.size, 3);
  for (const [key, ev] of s.events) {
    assert.match(key, /^kapso:invalid_payload:[0-9a-f]{64}$/);
    assert.equal(ev.status, "failed");
    assert.equal((ev.payload as { kind: string }).kind, "kapso_quarantined", "the retry job never selects it");
    assert.equal(JSON.stringify(ev.payload).includes("secret customer"), false, "no content of a payload-level record");
  }
  assert.equal([...s.events.values()].find((e) => e.error === "event.unsupported")!.kind, "other");
  // the same bytes again map to the same row (fingerprint), so redelivery never duplicates
  await handleKapsoPostV2(req("{nope", RECEIVED), SECRET, s);
  assert.equal(s.events.size, 3);
  assert.equal([...s.events.values()].find((e) => e.error === "payload.invalid_json")!.attempts, 2);
  assert.equal(s.inbound.length + s.statuses.length, 0);
});

test("kapso v2 handler: inbound customer message, status, duplicate deliveries", async () => {
  const s = new FakeStore();
  const a = await handleKapsoPostV2(req(item("inbound", "wamid.D1"), RECEIVED), SECRET, s);
  assert.deepEqual([a.httpStatus, a.processed, a.duplicates], [200, 1, 0]);
  const again = await handleKapsoPostV2(req(item("inbound", "wamid.D1"), RECEIVED), SECRET, s);
  assert.deepEqual([again.processed, again.duplicates], [0, 1], "Kapso retry of a processed event is a duplicate");
  assert.equal(s.inbound.length, 1);
  const st = await handleKapsoPostV2(req(item("outbound", "wamid.D2"), DELIVERED), SECRET, s);
  assert.deepEqual([st.processed, s.statuses.length], [1, 1]);
  assert.equal(s.statuses[0].origin, null);
  const batch = { batch: true, data: [item("inbound", "wamid.D3"), item("inbound", "wamid.D3"), item("inbound", "wamid.D4")] };
  const b = await handleKapsoPostV2(req(batch, RECEIVED), SECRET, s);
  assert.deepEqual([b.processed, b.duplicates], [2, 1], "duplicates inside one batch");
});

test("kapso v2 handler: a status that cannot be applied yet is failed(status.message_not_found); other failures keep a stable code only", async () => {
  const s = new FakeStore();
  s.statusApplicable = false;
  const r = await handleKapsoPostV2(req(item("outbound", "wamid.F1", { to: null }), SENT), SECRET, s);
  assert.deepEqual([r.failed, r.processed], [1, 0]);
  assert.equal(s.events.get("kapso:status:wamid.F1:sent")!.error, "status.message_not_found");
  const s2 = new FakeStore();
  s2.ingestInbound = async () => { throw { code: "42501", message: 'duplicate key value (+15550000111) "contacts_phone_key"' }; };
  const r2 = await handleKapsoPostV2(req(item("inbound", "wamid.F2"), RECEIVED), SECRET, s2);
  assert.equal(r2.failed, 1);
  assert.equal(s2.events.get("kapso:msg:wamid.F2")!.error, "processing_error", "no customer data in stored errors");
  const s3 = new FakeStore();
  s3.ingestInbound = async () => { throw { message: "kapso.unknown_account" }; };
  await handleKapsoPostV2(req(item("inbound", "wamid.F3"), RECEIVED), SECRET, s3);
  assert.equal(s3.events.get("kapso:msg:wamid.F3")!.error, "kapso.unknown_account");
});

test("kapso v2 handler: unavailable storage -> 503 (redelivery is deduplicated by the event keys)", async () => {
  const s = new FakeStore();
  s.down = true;
  assert.equal((await handleKapsoPostV2(req(item("inbound", "wamid.U1"), RECEIVED), SECRET, s)).httpStatus, 503);
});

// ------------------------------------------------------------------------------------------------ quarantine / history_sync
test("kapso v2 handler: an unknown origin is quarantined - failed, no content stored, never ingested", async () => {
  const s = new FakeStore();
  const r = await handleKapsoPostV2(req(item("inbound", "wamid.Q1", { origin: "brand_new_origin", text: "TOP SECRET TEXT" }), RECEIVED), SECRET, s);
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed, r.failed], [200, 1, 0, 0], "answers 200 so Kapso does not count a failed delivery");
  assert.equal(s.inbound.length, 0);
  const ev = s.events.get("kapso:msg:wamid.Q1")!;
  assert.deepEqual([ev.status, ev.error], ["failed", "origin.unknown"]);
  assert.equal((ev.payload as { kind: string }).kind, "kapso_quarantined");
  const dump = JSON.stringify(ev.payload);
  for (const leak of ["TOP SECRET", "15550000111", "Sara", "secret customer"]) assert.equal(dump.includes(leak), false, `quarantine record leaks ${leak}`);
  // redelivery re-evaluates (it is "retry", not "duplicate"), so a corrected classifier can pick it up
  const again = await handleKapsoPostV2(req(item("inbound", "wamid.Q1", { origin: "brand_new_origin" }), RECEIVED), SECRET, s);
  assert.equal(again.quarantined, 1);
  assert.equal(s.events.get("kapso:msg:wamid.Q1")!.attempts, 2);
});

test("kapso v2 handler: an echo origin on an INBOUND message is a conflict, quarantined (neither customer nor employee)", async () => {
  const s = new FakeStore();
  const r = await handleKapsoPostV2(req(item("inbound", "wamid.Q2", { origin: "business_app" }), RECEIVED), SECRET, s);
  assert.equal(r.quarantined, 1);
  assert.equal(s.events.get("kapso:msg:wamid.Q2")!.error, "origin.direction_conflict");
  assert.equal(s.inbound.length, 0);
});

test("kapso v2 handler: history_sync is acknowledged and ignored - no ingest, no status, payload dropped, no telemetry", async () => {
  const s = new FakeStore();
  const a = await handleKapsoPostV2(req(item("inbound", "wamid.H1", { origin: "history_sync" }), RECEIVED), SECRET, s);
  const b = await handleKapsoPostV2(req(item("outbound", "wamid.H2", { origin: "history_sync" }), SENT), SECRET, s);
  for (const r of [a, b]) assert.deepEqual([r.httpStatus, r.ignored, r.historySyncIgnored, r.processed, r.quarantined], [200, 1, 1, 0, 0]);
  assert.deepEqual([s.inbound.length, s.statuses.length, s.touched.length], [0, 0, 0]);
  assert.equal(s.events.get("kapso:msg:wamid.H1")!.status, "ignored");
  assert.deepEqual(s.events.get("kapso:msg:wamid.H1")!.payload, {}, "an ignored event keeps no payload");
});

test("kapso v2 handler: echoes go to the status path with their origin (never to the customer path)", async () => {
  const s = new FakeStore();
  for (const [i, o] of (["business_app", "other_app", "meta_business_agent"] as const).entries()) {
    const r = await handleKapsoPostV2(req(item("outbound", `wamid.E${i}`, { origin: o }), SENT), SECRET, s);
    assert.equal(r.processed, 1);
  }
  assert.deepEqual(s.statuses.map((x) => x.origin), ["business_app", "other_app", "meta_business_agent"]);
  assert.equal(s.inbound.length, 0);
});

// ------------------------------------------------------------------------------------------------ isolation, telemetry, logging
test("kapso v2 isolation: only phone_number_id reaches the store; company/account ids in the payload are never read", async () => {
  const s = new FakeStore();
  const p = item("inbound", "wamid.I1");
  Object.assign(p.message, { company_id: "00000000-0000-0000-0000-00000000c0de", whatsapp_account_id: "evil" });
  Object.assign(p, { company_id: "00000000-0000-0000-0000-00000000c0de" });
  await handleKapsoPostV2(req(p, RECEIVED), SECRET, s);
  const seen = JSON.stringify([s.inbound, [...s.events.values()].map((e) => e.payload)]);
  assert.equal(/c0de|evil|company|account/i.test(seen), false, seen);
  assert.equal(s.inbound[0].phoneNumberId, PNID);
});

test("kapso v2 isolation: events of two accounts in one batch keep their own phone_number_id", async () => {
  const s = new FakeStore();
  await handleKapsoPostV2(req({ batch: true, data: [item("inbound", "wamid.T1", { pnid: "pnid-A" }), item("inbound", "wamid.T2", { pnid: "pnid-B" })] }, RECEIVED), SECRET, s);
  assert.deepEqual(s.inbound.map((e) => e.phoneNumberId), ["pnid-A", "pnid-B"]);
});

test("kapso v2 telemetry: once per account AFTER the work, best effort, never affecting the answer", async () => {
  const s = new FakeStore();
  const order: string[] = [];
  const ing = s.ingestInbound.bind(s);
  s.ingestInbound = async (e) => { order.push("ingest"); return ing(e); };
  const t = s.touchAccount.bind(s);
  s.touchAccount = async (p) => { order.push("touch"); return t(p); };
  const r = await handleKapsoPostV2(req({ batch: true, data: [item("inbound", "wamid.M1"), item("inbound", "wamid.M2"), item("inbound", "wamid.M3", { pnid: "pnid-B" })] }, RECEIVED), SECRET, s);
  assert.deepEqual(s.touched, ["pnid-A", "pnid-B"]);
  assert.deepEqual(order, ["ingest", "ingest", "ingest", "touch", "touch"]);
  const s2 = new FakeStore();
  s2.failTouch = true;
  const r2 = await handleKapsoPostV2(req(item("inbound", "wamid.M4"), RECEIVED), SECRET, s2);
  assert.deepEqual([r.httpStatus, r2.httpStatus, r2.processed], [200, 200, 1]);
});

test("kapso v2 logging: one structured line of counters/codes; no content, phone, ids, signature or secret", async () => {
  const s = new FakeStore();
  const lines: Record<string, unknown>[] = [];
  const p = req({ batch: true, data: [item("inbound", "wamid.L1", { text: "PRIVATE CONTENT" }), item("inbound", "wamid.L2", { origin: "weird" }), item("outbound", "wamid.L3", { origin: "business_app" })] }, RECEIVED);
  await handleKapsoPostV2(p, SECRET, s, { log: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  const text = JSON.stringify(lines[0]);
  for (const leak of ["PRIVATE", "15550000111", "wamid", "pnid-A", p.signature!, SECRET, "Sara"]) assert.equal(text.includes(leak), false, `log leaks ${leak}`);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["duplicates", "event", "failed", "historySyncIgnored", "http", "ignored", "origins", "parseErrors", "processed", "quarantined"]);
  assert.equal(lines[0].quarantined, 2, "the unknown origin AND the direction-mismatched item (formerly dropped) are both recorded");
  assert.equal(safeDeliveryLog({ httpStatus: 401, processed: 0, duplicates: 0, failed: 0, ignored: 0, quarantined: 0, historySyncIgnored: 0, parseErrors: [], origins: {} }).http, 401);
});

// ------------------------------------------------------------------------------------------------ store argument mapping
test("kapso v2 store: every RPC argument is sent (null when absent); only phone_number_id identifies the account", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db: RpcClient = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: name === "ingest_kapso_inbound" ? [{ o_duplicate: true }] : name === "apply_kapso_status_v2" ? true : name === "finish_kapso_event" ? "finished" : "new", error: null };
    },
  };
  const st = createKapsoStoreV2(db);
  const inb = parseKapsoPayloadV2(item("inbound", "wamid.ST1", { from: null, conv: { test_only_user_id: "BS-1" } }), RECEIVED, { bsuidPaths: BS_PATHS }).events[0] as KapsoInboundV2;
  assert.deepEqual(await st.ingestInbound(inb), { duplicate: true });
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["p_body", "p_from_bsuid", "p_from_wa_id", "p_media", "p_message_type", "p_origin", "p_phone_number_id", "p_profile_name", "p_sent_at", "p_wa_message_id"]);
  assert.equal(calls[0].args.p_from_wa_id, null);
  assert.equal(calls[0].args.p_from_bsuid, "BS-1");
  const sta = parseKapsoPayloadV2(item("outbound", "wamid.ST2", { origin: "business_app" }), SENT).events[0] as KapsoStatusV2;
  assert.equal(await st.applyStatus(sta), true);
  assert.deepEqual(Object.keys(calls[1].args).sort(), ["p_body", "p_error_code", "p_error_message", "p_is_retry", "p_media", "p_message_type", "p_origin", "p_phone_number_id", "p_sent_at", "p_status", "p_to_bsuid", "p_to_wa_id", "p_wa_message_id"]);
  assert.equal(calls[1].args.p_is_retry, false, "the webhook handler never passes isRetry=true (only the retry job does)");
  await st.touchAccount("pnid-A");
  await st.finishEvent("k", "failed");
  assert.deepEqual(calls[2].args, { p_phone_number_id: "pnid-A" });
  assert.equal(calls[3].args.p_error, null);
  const failing = createKapsoStoreV2({ rpc: async () => ({ data: null, error: { message: "kapso.unknown_account" } }) });
  await assert.rejects(() => failing.ingestInbound(inb), (e: { message: string }) => e.message === "kapso.unknown_account");
});

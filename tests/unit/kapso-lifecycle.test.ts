/**
 * Webhook event lifecycle (no database): every signed item ends in a durable state, the answer policy, protocol/account
 * compatibility, BSUID handling, the HTTP layer and the retry cron. Database-side counterparts: scripts/db/concurrency/t7.sh and
 * tests/scratch/kapso-v2-db.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  handleKapsoPostV2, reprocessQuarantinedV2, type HeldRecord, type KapsoAccountClass, type KapsoInboundV2, type KapsoQuarantineReader,
  type KapsoStatusV2, type KapsoStoreV2,
} from "../../src/lib/kapso/v2.ts";
import { handleKapsoPost, type KapsoAccountClassV1, type KapsoStore } from "../../src/lib/kapso/processor.ts";
import type { KapsoMessageEvent, KapsoStatusEvent } from "../../src/lib/kapso/parser.ts";
import { buildInvalidItem, KAPSO_QUARANTINE_MAX_RAW_BYTES, RECOVERABLE_REASONS } from "../../src/lib/kapso/quarantine.ts";
import { protocolDecision } from "../../src/lib/kapso/protocol.ts";
import { verifyKapsoSignature } from "../../src/lib/kapso/signature.ts";
import { handleKapsoWebhookHttp, isJsonContentType, MAX_BODY_BYTES, type KapsoWebhookDeps } from "../../src/lib/kapso/webhook-http.ts";
import { runCronRetry } from "../../src/lib/cron-retry.ts";
import { isBearerAuthorized } from "../../src/lib/cron-auth.ts";
import { EnvError, parseEnv, serverSchemas } from "../../src/env.ts";
import type { ClaimResult } from "../../src/lib/whatsapp/processor.ts";

const SECRET = "unit-test-lifecycle-secret-0123456789"; // throwaway, tests only
const enc = (s: string) => new TextEncoder().encode(s);
const sign = (b: string | Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(b).digest("hex");
const RECEIVED = "whatsapp.message.received", SENT = "whatsapp.message.sent";
const BS_PATHS = [["conversation", "test_only_user_id"]] as const; // TEST-ONLY override location (the real fields: KAPSO_BSUID_PATHS)

function item(direction: "inbound" | "outbound", id: string, o: { pnid?: string; from?: string | null; text?: string; conv?: Record<string, unknown>; ts?: string; origin?: string } = {}) {
  const pnid = o.pnid ?? "pnid-A";
  return {
    message: {
      id, timestamp: o.ts ?? "1790000000", type: "text", text: { body: o.text ?? "private words" },
      ...(o.from === null ? {} : direction === "inbound" ? { from: o.from ?? "15550000111" } : { to: o.from ?? "15550000111" }),
      kapso: { direction, ...(o.origin ? { origin: o.origin } : {}) },
    },
    conversation: { contact_name: "Sara", phone_number_id: pnid, ...o.conv },
    phone_number_id: pnid,
  };
}
const req = (payload: unknown, event: string, o: { version?: string } = {}) => {
  const raw = enc(typeof payload === "string" ? payload : JSON.stringify(payload));
  return { rawBody: raw, signature: sign(raw), eventName: event, payloadVersion: o.version ?? "v2" };
};

type Row = { status: string; attempts: number; error?: string; payload: unknown; kind: string };
/** Mirrors the 978 functions; `fail` names methods that throw like an unreachable database (optionally only from the n-th call). */
class Store implements KapsoStoreV2, KapsoQuarantineReader {
  rows = new Map<string, Row>();
  inbound: KapsoInboundV2[] = [];
  statuses: KapsoStatusV2[] = [];
  wamids = new Set<string>();
  classes = new Map<string, KapsoAccountClass>();
  fail = new Map<string, number>();   // method -> fail from this call number on (1 = always)
  count = new Map<string, number>();
  ingestError: unknown = null;
  private gate(m: string) {
    const c = (this.count.get(m) ?? 0) + 1;
    this.count.set(m, c);
    const from = this.fail.get(m);
    if (from !== undefined && c >= from) throw new Error("fetch failed");
  }
  async claimEvent(e: { eventKey: string; kind: "message" | "status"; phoneNumberId: string; payload: unknown }): Promise<ClaimResult> {
    this.gate("claimEvent");
    const r = this.rows.get(e.eventKey);
    if (!r) { this.rows.set(e.eventKey, { status: "pending", attempts: 1, payload: e.payload, kind: e.kind }); return "new"; }
    if (r.status === "processed" || r.status === "ignored") return "duplicate";
    r.attempts++; r.payload = e.payload; return "retry";
  }
  /** Optional hook run before a finish, to simulate another worker finishing the same row first. */
  beforeFinish: ((key: string) => void) | null = null;
  async finishEvent(key: string, status: "processed" | "failed" | "ignored", error?: string): Promise<"finished" | "already_final"> {
    this.gate(`finish:${status}`);
    this.beforeFinish?.(key);
    const r = this.rows.get(key);
    if (!r) throw { message: "webhook.event_not_found" };
    if (r.status === "processed" || r.status === "ignored") return "already_final";   // terminal (978 as revised)
    r.status = status; r.error = status === "failed" ? error : undefined;
    if (status !== "failed") r.payload = {};
    return "finished";
  }
  async recordHeld(e: HeldRecord): Promise<"recorded" | "duplicate"> {
    this.gate("recordHeld");
    const r = this.rows.get(e.eventKey);
    const kind = r && (r.payload as { kind?: string })?.kind;
    // only an existing quarantine record may be replaced (978 as revised)
    if (r && (r.status === "processed" || r.status === "ignored" || kind !== "kapso_quarantined")) return "duplicate";
    const payload = e.status === "ignored" ? {} : e.payload;
    if (r) Object.assign(r, { status: e.status, attempts: r.attempts + 1, error: e.status === "failed" ? e.reason : undefined, payload });
    else this.rows.set(e.eventKey, { status: e.status, attempts: 1, error: e.status === "failed" ? e.reason : undefined, payload, kind: e.kind });
    return "recorded";
  }
  async accountClass(pn: string): Promise<KapsoAccountClass> { this.gate("accountClass"); return this.classes.has(pn) ? this.classes.get(pn)! : "production"; }
  async ingestInbound(e: KapsoInboundV2) {
    this.gate("ingestInbound");
    if (this.ingestError) throw this.ingestError;
    const dup = this.wamids.has(e.waMessageId); this.wamids.add(e.waMessageId); if (!dup) this.inbound.push(e);
    return { duplicate: dup };
  }
  async applyStatus(e: KapsoStatusV2) { this.gate("applyStatus"); this.statuses.push(e); return true; }
  async touchAccount() { /* telemetry */ }
  async listQuarantined(reason: string) {
    return [...this.rows].filter(([, r]) => r.status === "failed" && r.error === reason && (r.payload as { rawItem?: unknown }).rawItem)
      .map(([eventKey, r]) => ({ eventKey, payload: r.payload }));
  }
}
const quarantined = (s: Store) => [...s.rows].filter(([, r]) => r.status === "failed" && (r.payload as { kind?: string }).kind === "kapso_quarantined");

// ============================================================================================ 1. no signed item disappears
test("lifecycle: every item-level reason becomes ONE durable quarantine row with a machine-readable reason; nothing is ingested", async () => {
  const s = new Store();
  const noMessage = { phone_number_id: "pnid-A" };
  const badPnid = item("inbound", "wamid.P1", { pnid: "has spaces" });
  const badId = { ...item("inbound", "x"), message: { ...item("inbound", "x").message, id: "bad id with spaces" } };
  const mismatch = item("outbound", "wamid.P2");
  const noIdentity = item("inbound", "wamid.P3", { from: null });
  const badTs = item("inbound", "wamid.P4", { ts: "yesterday" });
  const r = await handleKapsoPostV2(req({ batch: true, data: [noMessage, badPnid, badId, mismatch, noIdentity, badTs, "not an object"] }, RECEIVED), SECRET, s);
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed, s.inbound.length], [200, 7, 0, 0]);
  const reasons = quarantined(s).map(([, row]) => row.error).sort();
  assert.deepEqual(reasons, ["invalid.direction_mismatch", "invalid.invalid_message_id", "invalid.invalid_phone_number_id", "invalid.invalid_timestamp",
    "invalid.missing_customer_identity", "invalid.missing_message", "invalid.missing_message"]);
  // recoverable reasons are keyed by the logical event key and keep the item; the others are a fingerprint without content
  assert.ok(s.rows.has("kapso:msg:wamid.P3") && s.rows.has("kapso:msg:wamid.P4"));
  for (const [key, row] of quarantined(s)) {
    const p = row.payload as { rawItem: unknown; reason: string };
    if (key.startsWith("kapso:msg:")) assert.ok(p.rawItem, `${key} keeps its item`);
    else {
      assert.match(key, /^kapso:invalid:[0-9a-f]{64}$/);
      assert.equal(p.rawItem, null);
      assert.equal(JSON.stringify(row.payload).includes("private words"), false, `${key} must not keep content`);
    }
  }
  // the provider redelivers the same batch: same rows (fingerprints / logical keys), no new ones
  assert.equal(s.rows.size, 7);
  const again = await handleKapsoPostV2(req({ batch: true, data: [noMessage, badPnid, badId, mismatch, noIdentity, badTs, "not an object"] }, RECEIVED), SECRET, s);
  assert.deepEqual([again.httpStatus, s.rows.size], [200, 7], "redelivery maps every item to its existing row");
  assert.ok([...s.rows.values()].every((row) => row.attempts === 2));
});

test("lifecycle: the original item is kept only for recoverable reasons and only below the size cap (otherwise recorded without it)", () => {
  const big = item("inbound", "wamid.BIG", { from: null, text: "x".repeat(KAPSO_QUARANTINE_MAX_RAW_BYTES + 10) });
  const e = buildInvalidItem(big, RECEIVED, "missing_customer_identity");
  assert.deepEqual([e.eventKey, e.rawItem, e.rawItemOmitted], ["kapso:msg:wamid.BIG", null, "too_large"]);
  const small = buildInvalidItem(item("inbound", "wamid.SM", { from: null }), RECEIVED, "missing_customer_identity");
  assert.equal(small.rawItemOmitted, null);
  const nonRec = buildInvalidItem(item("outbound", "wamid.NR"), RECEIVED, "direction_mismatch");
  assert.deepEqual([nonRec.rawItem, nonRec.rawItemOmitted], [null, "not_recoverable"]);
  assert.deepEqual(nonRec.shape.message.sort(), ["id", "kapso", "text", "timestamp", "to", "type"], "key NAMES for diagnosis, never values");
  for (const r of ["missing_customer_identity", "missing_customer_phone", "invalid_timestamp", "protocol.v2_required", "account.misconfigured"]) assert.ok(RECOVERABLE_REASONS.has(r), r);
  // an unusable phone_number_id is never kept; a usable one is
  assert.equal(buildInvalidItem(item("inbound", "wamid.Z", { pnid: "evil value; drop" }), RECEIVED, "invalid_phone_number_id").phoneNumberId, null);
  assert.equal(buildInvalidItem(item("outbound", "wamid.Z"), RECEIVED, "direction_mismatch").phoneNumberId, "pnid-A");
});

// ============================================================================================ 2. answer policy
test("lifecycle answers: 503 whenever a state could not be recorded, at every durable step", async () => {
  const cases: Array<[string, (s: Store) => void, unknown]> = [
    ["claim unavailable", (s) => s.fail.set("claimEvent", 1), item("inbound", "wamid.A1")],
    ["quarantine record unavailable", (s) => s.fail.set("recordHeld", 1), item("inbound", "wamid.A2", { from: null })],
    ["account check unavailable", (s) => s.fail.set("accountClass", 1), item("inbound", "wamid.A3")],
    ["ingest AND its failure mark unavailable", (s) => { s.fail.set("ingestInbound", 1); s.fail.set("finish:failed", 1); }, item("inbound", "wamid.A4")],
    ["processed mark AND failure mark unavailable", (s) => { s.fail.set("finish:processed", 1); s.fail.set("finish:failed", 1); }, item("inbound", "wamid.A5")],
    ["payload-level record unavailable", (s) => s.fail.set("recordHeld", 1), "{not json"],
  ];
  for (const [name, setup, payload] of cases) {
    const s = new Store(); setup(s);
    const r = await handleKapsoPostV2(req(payload, RECEIVED), SECRET, s);
    assert.equal(r.httpStatus, 503, name);
  }
});

test("lifecycle answers: 200 when the failure itself is recorded (the retry job owns it); the error is a stable code", async () => {
  const s = new Store();
  s.ingestError = { code: "P0002", message: "kapso.unknown_account" };
  const r = await handleKapsoPostV2(req(item("inbound", "wamid.B1"), RECEIVED), SECRET, s);
  assert.deepEqual([r.httpStatus, r.failed], [200, 1]);
  assert.deepEqual([s.rows.get("kapso:msg:wamid.B1")!.status, s.rows.get("kapso:msg:wamid.B1")!.error], ["failed", "kapso.unknown_account"]);
  assert.equal((s.rows.get("kapso:msg:wamid.B1")!.payload as { kind: string }).kind, "kapso_inbound_v2", "real retry work, not a quarantine");
  const s2 = new Store(); s2.fail.set("finish:processed", 1);
  const r2 = await handleKapsoPostV2(req(item("inbound", "wamid.B2"), RECEIVED), SECRET, s2);
  assert.deepEqual([r2.httpStatus, r2.failed, s2.rows.get("kapso:msg:wamid.B2")!.status], [200, 1, "failed"], "the 'processed' mark failed but the 'failed' mark was written");
});

test("lifecycle answers: mixed batch with an outage after the 2nd item -> 503; the whole-batch retry finishes it with no duplicates", async () => {
  const s = new Store();
  const batch = { batch: true, data: [1, 2, 3, 4].map((i) => item("inbound", `wamid.M${i}`)) };
  s.fail.set("claimEvent", 3);
  const r1 = await handleKapsoPostV2(req(batch, RECEIVED), SECRET, s);
  assert.deepEqual([r1.httpStatus, r1.processed], [503, 2]);
  s.fail.clear();
  const r2 = await handleKapsoPostV2(req(batch, RECEIVED), SECRET, s);
  assert.deepEqual([r2.httpStatus, r2.processed, r2.duplicates], [200, 2, 2]);
  assert.deepEqual(s.inbound.map((e) => e.waMessageId), ["wamid.M1", "wamid.M2", "wamid.M3", "wamid.M4"], "each message ingested exactly once");
});

test("lifecycle answers: a redelivery that now parses replaces the quarantine payload (later failures leave real retry work)", async () => {
  const s = new Store();
  await handleKapsoPostV2(req(item("inbound", "wamid.R1", { from: null }), RECEIVED), SECRET, s);
  assert.equal(s.rows.get("kapso:msg:wamid.R1")!.error, "invalid.missing_customer_identity");
  s.ingestError = { message: "kapso.unknown_account" };
  await handleKapsoPostV2(req(item("inbound", "wamid.R1"), RECEIVED), SECRET, s);   // now with a phone, but the account is not ready
  const row = s.rows.get("kapso:msg:wamid.R1")!;
  assert.deepEqual([row.status, row.error, (row.payload as { kind: string }).kind], ["failed", "kapso.unknown_account", "kapso_inbound_v2"]);
});

test("lifecycle (978 rev.): 'already_final' - another worker finished the event first - counts as a duplicate, never processed or failed", async () => {
  const s = new Store();
  s.beforeFinish = (k) => { const r = s.rows.get(k)!; r.status = "processed"; r.payload = {}; };   // the retry job won the race
  const a = await handleKapsoPostV2(req(item("inbound", "wamid.AF1"), RECEIVED), SECRET, s);
  assert.deepEqual([a.httpStatus, a.processed, a.duplicates, a.failed], [200, 0, 1, 0]);
  const s2 = new Store();
  s2.ingestError = { message: "kapso.identity_conflict" };
  s2.beforeFinish = (k) => { s2.rows.get(k)!.status = "ignored"; };
  const b = await handleKapsoPostV2(req(item("inbound", "wamid.AF2"), RECEIVED), SECRET, s2);
  assert.deepEqual([b.httpStatus, b.failed, b.duplicates, s2.rows.get("kapso:msg:wamid.AF2")!.status], [200, 0, 1, "ignored"], "a failure mark never reopens a terminal row");
});

test("lifecycle (978 rev.): a quarantine write never replaces a pending or failed processable event; it does refresh a quarantine record", async () => {
  const s = new Store();
  const pendingPayload = { kind: "kapso_inbound_v2", waMessageId: "wamid.PQ1" };
  s.rows.set("kapso:msg:wamid.PQ1", { status: "pending", attempts: 1, payload: pendingPayload, kind: "message" });
  s.rows.set("kapso:msg:wamid.PQ2", { status: "failed", attempts: 3, error: "kapso.unknown_account", payload: { kind: "kapso_status_v2" }, kind: "status" });
  const r = await handleKapsoPostV2(req({ batch: true, data: [item("inbound", "wamid.PQ1", { from: null }), item("inbound", "wamid.PQ2", { origin: "brand_new" })] }, RECEIVED), SECRET, s);
  assert.deepEqual([r.httpStatus, r.duplicates, r.quarantined], [200, 2, 0]);
  assert.deepEqual(s.rows.get("kapso:msg:wamid.PQ1"), { status: "pending", attempts: 1, payload: pendingPayload, kind: "message" });
  assert.deepEqual([s.rows.get("kapso:msg:wamid.PQ2")!.status, s.rows.get("kapso:msg:wamid.PQ2")!.attempts, s.rows.get("kapso:msg:wamid.PQ2")!.error], ["failed", 3, "kapso.unknown_account"]);
  await handleKapsoPostV2(req(item("inbound", "wamid.PQ3", { origin: "brand_new" }), RECEIVED), SECRET, s);
  const q2 = await handleKapsoPostV2(req(item("inbound", "wamid.PQ3", { origin: "other_new" }), RECEIVED), SECRET, s);
  assert.deepEqual([q2.quarantined, s.rows.get("kapso:msg:wamid.PQ3")!.attempts, (s.rows.get("kapso:msg:wamid.PQ3")!.payload as { origin: string }).origin], [1, 2, "other_new"], "a quarantine record IS refreshed by a redelivery");
});

test("store-v2 (978 rev.): finish_kapso_event results map 1:1; an unexpected result is never read as success (-> 503)", async () => {
  const { createKapsoStoreV2 } = await import("../../src/lib/kapso/store-v2.ts");
  for (const res of ["finished", "already_final"]) {
    const st = createKapsoStoreV2({ rpc: async () => ({ data: res, error: null }) });
    assert.equal(await st.finishEvent("kapso:msg:x", "processed"), res);
  }
  for (const bad of [null, "", "ok", true, { status: "finished" }]) {
    const st = createKapsoStoreV2({ rpc: async () => ({ data: bad, error: null }) });
    await assert.rejects(() => st.finishEvent("kapso:msg:x", "processed"), /webhook.unexpected_result/, JSON.stringify(bad));
  }
  // through the handler: claim works, finish answers nonsense -> the 'failed' mark answers nonsense too -> 503
  const db = { rpc: async (name: string) => ({ data: name === "claim_kapso_event" ? "new" : name === "kapso_account_protocol" ? "production" : name === "ingest_kapso_inbound" ? [{ o_duplicate: false }] : "weird", error: null }) };
  const r = await handleKapsoPostV2(req(item("inbound", "wamid.SX"), RECEIVED), SECRET, createKapsoStoreV2(db));
  assert.equal(r.httpStatus, 503);
});

// ============================================================================================ 3. protocol / account compatibility
test("protocol matrix: production needs explicit v2; misconfigured accounts are quarantined; sandbox works on both", () => {
  const m = (["v1", "v2"] as const).map((p) => (["sandbox", "production", "misconfigured", "pre_rev6", null] as const).map((a) => protocolDecision(p, a)));
  assert.deepEqual(m, [
    ["process", "protocol.v2_required", "account.misconfigured", "process", "process"],
    ["process", "process", "account.misconfigured", "process", "process"],
  ]);
});

test("protocol v2: a misconfigured account is quarantined with its item (account.misconfigured); other accounts in the batch go on", async () => {
  const s = new Store();
  s.classes.set("pnid-BAD", "misconfigured"); s.classes.set("pnid-SB", "sandbox"); s.classes.set("pnid-NEW", null);
  const r = await handleKapsoPostV2(req({ batch: true, data: [item("inbound", "wamid.C1", { pnid: "pnid-BAD" }), item("inbound", "wamid.C2", { pnid: "pnid-SB" }), item("inbound", "wamid.C3", { pnid: "pnid-NEW" })] }, RECEIVED), SECRET, s);
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed], [200, 1, 2]);
  const row = s.rows.get("kapso:msg:wamid.C1")!;
  assert.deepEqual([row.error, Boolean((row.payload as { rawItem: unknown }).rawItem)], ["account.misconfigured", true]);
  assert.deepEqual(s.inbound.map((e) => e.phoneNumberId), ["pnid-SB", "pnid-NEW"], "unknown accounts go on to the database, which refuses them (retryable)");
  assert.equal(s.count.get("accountClass"), 3, "one lookup per account per delivery");
});

class V1Store implements KapsoStore {
  rows = new Map<string, { status: string; error?: string; payload: unknown }>();
  ingested: string[] = [];
  cls: KapsoAccountClassV1 | Error | { code: string } = "sandbox";
  withCheck = true;
  constructor(o: { cls?: KapsoAccountClassV1 | Error | { code: string }; withCheck?: boolean } = {}) {
    if (o.cls !== undefined) this.cls = o.cls;
    if (o.withCheck === false) this.withCheck = false;
    if (!this.withCheck) delete (this as Partial<V1Store>).accountClass;
  }
  async claimEvent(e: { eventKey: string; payload: unknown }): Promise<ClaimResult> {
    const r = this.rows.get(e.eventKey);
    if (!r) { this.rows.set(e.eventKey, { status: "pending", payload: e.payload }); return "new"; }
    return r.status === "processed" || r.status === "ignored" ? "duplicate" : "retry";
  }
  async finishEvent(k: string, status: string, error?: string) { Object.assign(this.rows.get(k)!, { status, error }); }
  async ingestMessage(e: KapsoMessageEvent) { this.ingested.push(e.waMessageId); return { duplicate: false }; }
  async applyStatus(_e: KapsoStatusEvent) { return true; }
  accountClass? = async (): Promise<KapsoAccountClassV1> => {
    if (this.cls instanceof Error || (typeof this.cls === "object" && this.cls !== null)) throw this.cls;
    return this.cls;
  };
}

test("protocol v1 (default): a PRODUCTION account fails closed - quarantined as protocol.v2_required with its item, never queued as v1 work", async () => {
  const s = new V1Store({ cls: "production" });
  const r = await handleKapsoPost(req(item("inbound", "wamid.V1"), RECEIVED), SECRET, s);
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed, s.ingested.length], [200, 1, 0, 0]);
  const row = s.rows.get("kapso:msg:wamid.V1")!;
  assert.deepEqual([row.status, row.error, (row.payload as { kind: string }).kind], ["failed", "protocol.v2_required", "kapso_quarantined"]);
  const mis = new V1Store({ cls: "misconfigured" });
  await handleKapsoPost(req(item("inbound", "wamid.V2"), RECEIVED), SECRET, mis);
  assert.equal(mis.rows.get("kapso:msg:wamid.V2")!.error, "account.misconfigured");
});

test("protocol v1: sandbox, unknown and pre-Rev6 schemas (function missing: PGRST202 / 42883) keep the Phase 1 behaviour", async () => {
  for (const cls of ["sandbox", null, { code: "PGRST202" }, { code: "42883" }] as const) {
    const s = new V1Store({ cls: cls as KapsoAccountClassV1 | { code: string } });
    const r = await handleKapsoPost(req(item("inbound", "wamid.S1"), RECEIVED), SECRET, s);
    assert.deepEqual([r.httpStatus, r.processed, s.ingested], [200, 1, ["wamid.S1"]], JSON.stringify(cls));
  }
  const noCheck = new V1Store({ withCheck: false });
  assert.equal((await handleKapsoPost(req(item("inbound", "wamid.S2"), RECEIVED), SECRET, noCheck)).processed, 1, "a store without the check behaves as before");
  const down = new V1Store({ cls: new Error("fetch failed") });
  const r = await handleKapsoPost(req(item("inbound", "wamid.S3"), RECEIVED), SECRET, down);
  assert.deepEqual([r.httpStatus, down.ingested.length], [503, 0], "an unreachable check is not guessed: 503");
});

test("protocol env: KAPSO_PROTOCOL missing/empty -> v1 (sandbox default); v2 only when explicit; anything else fails closed naming only the variable", () => {
  const base = { KAPSO_WEBHOOK_SECRET: "0123456789abcdef0123" };
  assert.equal(parseEnv(serverSchemas.kapso, base).KAPSO_PROTOCOL, "v1");
  assert.equal(parseEnv(serverSchemas.kapso, { ...base, KAPSO_PROTOCOL: "  " }).KAPSO_PROTOCOL, "v1");
  assert.equal(parseEnv(serverSchemas.kapso, { ...base, KAPSO_PROTOCOL: "v2" }).KAPSO_PROTOCOL, "v2");
  for (const bad of ["V2", "v3", "auto", "v2 "]) {
    if (bad === "v2 ") { assert.equal(parseEnv(serverSchemas.kapso, { ...base, KAPSO_PROTOCOL: bad }).KAPSO_PROTOCOL, "v2", "surrounding spaces are trimmed"); continue; }
    assert.throws(() => parseEnv(serverSchemas.kapso, { ...base, KAPSO_PROTOCOL: bad }), (e: unknown) => e instanceof EnvError && e.variables.join() === "KAPSO_PROTOCOL" && !e.message.includes(bad));
  }
  assert.throws(() => parseEnv(serverSchemas.kapso, { KAPSO_PROTOCOL: "v2" }), (e: unknown) => e instanceof EnvError && e.variables.join() === "KAPSO_WEBHOOK_SECRET");
});

// ============================================================================================ 4. BSUID
test("BSUID: missing / malformed -> quarantined missing_customer_identity (no phone invented); same BSUID on two accounts stays two accounts", async () => {
  const s = new Store();
  const r = await handleKapsoPostV2(req({ batch: true, data: [
    item("inbound", "wamid.U1", { from: null }),                                                   // no identity at all
    item("inbound", "wamid.U2", { from: null, conv: { test_only_user_id: "has space" } }),          // malformed BSUID
    item("inbound", "wamid.U3", { from: null, pnid: "pnid-A", conv: { test_only_user_id: "BS-SAME" } }),
    item("inbound", "wamid.U4", { from: null, pnid: "pnid-B", conv: { test_only_user_id: "BS-SAME" } }),
  ] }, RECEIVED), SECRET, s, { bsuidPaths: BS_PATHS });
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed], [200, 2, 2]);
  assert.deepEqual(quarantined(s).map(([k, row]) => `${k}=${row.error}`).sort(), ["kapso:msg:wamid.U1=invalid.missing_customer_identity", "kapso:msg:wamid.U2=invalid.missing_customer_identity"]);
  assert.deepEqual(s.inbound.map((e) => [e.phoneNumberId, e.fromBsuid, e.fromWaId]), [["pnid-A", "BS-SAME", null], ["pnid-B", "BS-SAME", null]],
    "the BSUID travels with its own account's phone_number_id; the database scopes the identity to that account");
  const dup = await handleKapsoPostV2(req(item("inbound", "wamid.U3", { from: null, conv: { test_only_user_id: "BS-SAME" } }), RECEIVED), SECRET, s, { bsuidPaths: BS_PATHS });
  assert.deepEqual([dup.duplicates, s.inbound.length], [1, 2], "duplicate BSUID delivery is a duplicate");
});

test("BSUID: a BSUID in an unread location is quarantined, and reprocessQuarantinedV2 completes it once that location is configured", async () => {
  const s = new Store();
  await handleKapsoPostV2(req(item("inbound", "wamid.Q1", { from: null, conv: { test_only_user_id: "BS-77" } }), RECEIVED), SECRET, s);
  await handleKapsoPostV2(req(item("inbound", "wamid.Q2", { from: null }), RECEIVED), SECRET, s);
  assert.equal(s.inbound.length, 0);
  const none = await reprocessQuarantinedV2(s, "invalid.missing_customer_identity");
  assert.deepEqual([none.examined, none.reprocessed, none.stillQuarantined], [2, 0, 2], "still unknown: nothing is guessed");
  const res = await reprocessQuarantinedV2(s, "invalid.missing_customer_identity", { bsuidPaths: BS_PATHS });
  assert.deepEqual([res.reprocessed, res.stillQuarantined, res.unavailable], [1, 1, false]);
  assert.deepEqual([s.inbound[0].waMessageId, s.inbound[0].fromBsuid, s.inbound[0].fromWaId], ["wamid.Q1", "BS-77", null]);
  assert.deepEqual([s.rows.get("kapso:msg:wamid.Q1")!.status, s.rows.get("kapso:msg:wamid.Q2")!.status], ["processed", "failed"]);
  const twice = await reprocessQuarantinedV2(s, "invalid.missing_customer_identity", { bsuidPaths: BS_PATHS });
  assert.deepEqual([twice.reprocessed, s.inbound.length], [0, 1], "reprocessing is idempotent");
});

// ============================================================================================ 5. HTTP layer
function deps(o: { protocol?: "v1" | "v2"; configError?: boolean; v2?: Store; v1?: V1Store; logs?: unknown[] } = {}): KapsoWebhookDeps & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    config: () => { if (o.configError) throw new EnvError(["KAPSO_WEBHOOK_SECRET"]); return { secret: SECRET, protocol: o.protocol ?? "v2" }; },
    storeV1: () => { created.push("v1"); return o.v1 ?? new V1Store(); },
    storeV2: () => { created.push("v2"); return o.v2 ?? new Store(); },
    log: (l) => o.logs?.push(l),
  };
}
const stream = (b: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close(); } });
const http = (body: unknown, h: Record<string, string> = {}, method = "POST") => {
  const raw = enc(typeof body === "string" ? body : JSON.stringify(body));
  const headers: Record<string, string> = { "content-type": "application/json", "x-webhook-signature": sign(raw), "x-webhook-event": RECEIVED, "x-webhook-payload-version": "v2", ...h };
  return { method, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, body: stream(raw) };
};

test("http: method, configuration, content type and size are checked before anything is read or stored", async () => {
  assert.equal((await handleKapsoWebhookHttp(http(item("inbound", "wamid.H1"), {}, "GET"), deps())).status, 405);
  const nc = deps({ configError: true });
  assert.deepEqual(await handleKapsoWebhookHttp(http(item("inbound", "wamid.H1")), nc), { status: 503, body: "not configured" });
  assert.deepEqual(nc.created, []);
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    assert.equal((await handleKapsoWebhookHttp(http(item("inbound", "wamid.H1"), { "content-type": ct }), deps())).status, 415, ct);
  }
  assert.ok(isJsonContentType("application/json; charset=utf-8") && isJsonContentType("Application/JSON") && isJsonContentType(null));
  assert.equal((await handleKapsoWebhookHttp(http(item("inbound", "wamid.H1"), { "content-length": String(MAX_BODY_BYTES + 1) }), deps())).status, 413);
});

test("http: the size cap holds WHILE streaming (an endless body is cut off, never buffered whole)", async () => {
  let pulled = 0, cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) { pulled++; c.enqueue(new Uint8Array(256 * 1024)); }, cancel() { cancelled = true; },
  });
  const d = deps();
  const r = await handleKapsoWebhookHttp({ method: "POST", headers: { get: (n) => (n === "content-type" ? "application/json" : null) }, body: endless }, d);
  assert.equal(r.status, 413);
  assert.ok(cancelled, "the stream is cancelled");
  assert.ok(pulled * 256 * 1024 <= MAX_BODY_BYTES + 512 * 1024, `read at most ~the cap (${pulled} chunks)`);
});

test("http: signature first - missing, malformed or wrong signatures are 401 and touch no store method", async () => {
  const v2 = new Store();
  for (const sig of [null, "", "abc", "sha256=" + "0".repeat(64), "z".repeat(64), "0".repeat(63), "0".repeat(65), sign("other body")]) {
    const h = http(item("inbound", "wamid.H2"));
    const headers = { "content-type": "application/json", "x-webhook-event": RECEIVED, "x-webhook-payload-version": "v2", ...(sig === null ? {} : { "x-webhook-signature": sig }) } as Record<string, string>;
    const r = await handleKapsoWebhookHttp({ ...h, headers: { get: (n) => headers[n.toLowerCase()] ?? null } }, deps({ v2 }));
    assert.equal(r.status, 401, String(sig));
  }
  assert.equal([...v2.count.values()].reduce((a, b) => a + b, 0), 0, "no store call for an unauthenticated request");
  assert.ok(verifyKapsoSignature(enc("x"), sign("x").toUpperCase(), SECRET), "hex case does not matter");
  assert.equal(verifyKapsoSignature(enc("x"), sign("x"), ""), false, "an empty secret verifies nothing");
  // several webhooks, several secrets: any listed secret verifies, an unlisted one never does
  const second = "second-webhook-secret-0123456789";
  const signWith = (key: string, body: string) => createHmac("sha256", key).update(body).digest("hex");
  assert.ok(verifyKapsoSignature(enc("y"), signWith(second, "y"), `${SECRET}, ${second}`), "the second secret of the list verifies");
  assert.ok(verifyKapsoSignature(enc("y"), signWith(SECRET, "y"), `${SECRET},${second}`), "the first secret of the list verifies");
  assert.equal(verifyKapsoSignature(enc("y"), signWith("not-in-the-list-0123456789ab", "y"), `${SECRET},${second}`), false, "a secret that is not listed is refused");
  assert.equal(verifyKapsoSignature(enc("y"), signWith("", "y"), ",,"), false, "empty entries verify nothing");
});

test("http: protocol routing, response body and logs carry no internal detail, content, ids or secrets", async () => {
  const logs: Record<string, unknown>[] = [];
  const v2 = new Store(); v2.ingestError = { message: 'duplicate key (+15550000111) "contacts_phone_key" DETAIL: Key (phone)=(+15550000111)' };
  const r = await handleKapsoWebhookHttp(http(item("inbound", "wamid.H3", { text: "VERY PRIVATE" })), deps({ v2, logs }));
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  const all = JSON.stringify([r, logs, v2.rows.get("kapso:msg:wamid.H3")!.error]);
  for (const leak of ["VERY PRIVATE", "15550000111", "contacts_phone_key", "DETAIL", "wamid.H3", "pnid-A", SECRET]) assert.equal(all.includes(leak), false, leak);
  const v1 = new V1Store();
  const d1 = deps({ protocol: "v1", v1 });
  assert.equal((await handleKapsoWebhookHttp(http(item("inbound", "wamid.H4")), d1)).status, 200);
  assert.deepEqual([d1.created, v1.ingested], [["v1"], ["wamid.H4"]], "v1 configuration -> v1 store only");
  const down = new Store(); down.fail.set("accountClass", 1);
  assert.deepEqual(await handleKapsoWebhookHttp(http(item("inbound", "wamid.H5")), deps({ v2: down })), { status: 503, body: { ok: false } });
});

test("http: request spoofing - company/account ids in body or headers never reach the store; only phone_number_id does", async () => {
  const v2 = new Store();
  const p = item("inbound", "wamid.H6");
  Object.assign(p, { company_id: "00000000-0000-0000-0000-00000000c0de", whatsapp_account_id: "evil-account" });
  Object.assign(p.message, { company_id: "c0de" });
  await handleKapsoWebhookHttp(http(p, { "x-company-id": "c0de", "x-account-id": "evil-account" }), deps({ v2 }));
  const seen = JSON.stringify([v2.inbound, [...v2.rows.values()]]);
  assert.equal(/c0de|evil-account/.test(seen), false, seen);
  assert.equal(v2.inbound[0].phoneNumberId, "pnid-A");
});

// ============================================================================================ 6. retry cron
test("cron: unauthorized never starts the job; authorized runs it once; failures are 500/503 with no internal detail", async () => {
  let runs = 0;
  const job = (r: { data: unknown; error: unknown } | Error) => () => { runs++; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); };
  assert.deepEqual(await runCronRetry(false, job({ data: {}, error: null })), { status: 401, body: "unauthorized" });
  assert.equal(runs, 0);
  assert.deepEqual(await runCronRetry(true, job({ data: { processed: 0, failed: 0, ignored: 0, unconfirmed_expired: 0 }, error: null })),
    { status: 200, body: { ok: true, processed: 0, failed: 0, ignored: 0, unconfirmed_expired: 0 } }, "empty queue");
  assert.deepEqual(await runCronRetry(true, job({ data: { processed: 2, failed: 1, ignored: 0 }, error: null })), { status: 200, body: { ok: true, processed: 2, failed: 1, ignored: 0 } }, "a transient per-event failure stays recoverable (counted, not fatal)");
  assert.deepEqual(await runCronRetry(true, job({ data: { error: "processing_error" }, error: null })), { status: 500, body: { ok: false, error: "processing_error" } }, "the job's own failure: stable code only");
  const leak = await runCronRetry(true, job({ data: null, error: { message: "permission denied for table secret_stuff", details: "x", hint: "y" } }));
  assert.deepEqual(leak, { status: 500, body: { ok: false } });
  assert.deepEqual(await runCronRetry(true, job(new Error("connect ECONNREFUSED 10.0.0.1:5432"))), { status: 503, body: { ok: false } }, "database unavailable");
  assert.equal(runs, 5);
});

test("cron auth: exact bearer secret only, constant-time comparison of equal-length digests; no or short secret authorizes nothing", () => {
  const s = "cron-secret-0123456789abcdef";
  assert.equal(isBearerAuthorized(`Bearer ${s}`, s), true);
  for (const h of [null, "", s, `bearer ${s}`, `Bearer ${s} `, `Bearer ${s}x`, `Bearer ${s.slice(0, -1)}`, "Bearer ", `Basic ${s}`]) assert.equal(isBearerAuthorized(h, s), false, String(h));
  for (const bad of [undefined, null, "", "short"]) assert.equal(isBearerAuthorized(`Bearer ${bad}`, bad), false, String(bad));
});

// ============================================================================================ 7. retry/quarantine guarantees visible from TS
test("retry safety: nothing in the webhook/cron/reprocess modules can send (no outbound client, no send RPC)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["src/lib/kapso/v2.ts", "src/lib/kapso/store-v2.ts", "src/lib/kapso/processor.ts", "src/lib/kapso/quarantine.ts", "src/lib/kapso/webhook-http.ts", "src/lib/cron-retry.ts"]) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    assert.equal(/queue_outbound|record_outbound_result|sendMessage|send_message|fetch\(|api\.kapso|graph\.facebook/i.test(src), false, f);
  }
});

test("statuses keep working through the same lifecycle (claim -> apply -> finish) and are idempotent per status", async () => {
  const s = new Store();
  const a = await handleKapsoPostV2(req(item("outbound", "wamid.ST1"), SENT), SECRET, s);
  const b = await handleKapsoPostV2(req(item("outbound", "wamid.ST1"), SENT), SECRET, s);
  assert.deepEqual([a.processed, b.duplicates, s.statuses.length], [1, 1, 1]);
});

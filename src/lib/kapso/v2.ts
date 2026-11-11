/**
 * Kapso webhook processing, protocol "v2" (account model of the Rev6 proposal: supabase/proposed/20261104000970_kapso_production.sql,
 * lifecycle functions of supabase/proposed/20261104000978_kapso_event_lifecycle.sql). Selected by KAPSO_PROTOCOL=v2; the default
 * protocol ("v1", src/lib/kapso/processor.ts) keeps serving the Phase 1 sandbox.
 *
 * What v2 adds on top of v1, and nothing more:
 *  - the `message.kapso.origin` of every item is classified BEFORE anything is stored:
 *      customer message ........ inbound, origin absent or `cloud_api`            -> ingest_kapso_inbound
 *      CRM / API status ........ outbound, origin absent or `cloud_api`           -> apply_kapso_status_v2
 *      echo (no employee) ...... outbound, origin business_app | other_app | meta_business_agent -> apply_kapso_status_v2
 *      history_sync ............ any direction                                    -> recorded as ignored: no contact, conversation,
 *                                                                                    lead or message is ever created for it
 *      anything else ........... QUARANTINED: the event is kept (failed, without message content) for a person; never treated as a customer
 *  - a customer may be identified by phone, by BSUID, or both. The BSUID is stored as its own identity and NO phone number is ever
 *    derived from it. The fields are the documented ones (KAPSO_BSUID_PATHS, per direction). An item without any customer identity is
 *    QUARANTINED as `invalid.missing_customer_identity` with the original item kept (reprocessQuarantinedV2); an item whose identity
 *    fields disagree (two different BSUIDs, or two different phones) is quarantined as `invalid.conflicting_customer_identity`.
 *  - every signed item ends in a recorded state (src/lib/kapso/quarantine.ts); the answer policy is in docs/KAPSO_WEBHOOK_LIFECYCLE.md:
 *      401 bad/missing signature (nothing stored) | 200 every item processed, duplicate, recorded for retry or quarantined |
 *      503 something could not be recorded (the provider redelivers; already finished items are duplicates then).
 *  - the account behind each phone_number_id must be compatible with v2 (kapso_account_protocol); a misconfigured account quarantines.
 *  - after processing, the account telemetry RPC is called best-effort in its own transaction (never inside a webhook transaction).
 *
 * Company and account are NEVER taken from the request: only `phone_number_id` is sent to the database, which maps it to the account and the
 * account's company (and takes the account-row lock described in the Rev6 plan).
 * Outbound is not part of this module. Nothing here sends anything to Kapso.
 */
import type { ClaimResult } from "../whatsapp/processor.ts";
import {
  clip, extractContent, firstFailure, isObj, isSupportedKapsoEvent, KAPSO_MAX_BATCH_ITEMS, KAPSO_PAYLOAD_VERSION,
  normalizeWaId, parseTimestamp, PHONE_NUMBER_ID, STATUS_BY_EVENT, str, WA_MESSAGE_ID,
  type KapsoEventName, type Obj,
} from "./parser.ts";
import {
  buildInvalidItem, buildInvalidPayload, invalidErrorCode, invalidRecordPayload, type KapsoInvalidItem, type KapsoPayloadReason,
} from "./quarantine.ts";
import { protocolDecision } from "./protocol.ts";
import { extractKapsoMedia, mediaCaption, type KapsoMediaRef } from "./media.ts";
import { verifyKapsoSignature } from "./signature.ts";

type BsuidPaths = readonly (readonly string[])[];
/**
 * Where the CUSTOMER's business-scoped user id is, per direction (Kapso docs: whatsapp/business-scoped-user-ids, webhooks/message-events).
 * Inbound: message.from_user_id and conversation.business_scoped_user_id. Outbound items document only the conversation field.
 * Never read: the parent_* variants (a different, portfolio-level scope) and username (not stable).
 */
export const KAPSO_BSUID_PATHS: { readonly inbound: BsuidPaths; readonly outbound: BsuidPaths } = {
  inbound: [["message", "from_user_id"], ["conversation", "business_scoped_user_id"]],
  outbound: [["conversation", "business_scoped_user_id"]],
};

const BSUID_SHAPE = /^[^\s]{1,128}$/;
const ORIGIN_SHAPE = /^[a-z_]{1,40}$/;
export const ECHO_ORIGINS = ["business_app", "other_app", "meta_business_agent"] as const;
export type EchoOrigin = (typeof ECHO_ORIGINS)[number];

export type KapsoInboundV2 = {
  kind: "kapso_inbound_v2";
  eventKey: string;
  phoneNumberId: string;
  waMessageId: string;
  fromWaId: string | null;
  fromBsuid: string | null;
  origin: string | null;
  profileName: string | null;
  messageType: string;
  body: string | null;
  /** The file of an image / video / audio / document / sticker message (null for everything else). */
  media: KapsoMediaRef | null;
  sentAt: Date;
};
export type KapsoStatusV2 = {
  kind: "kapso_status_v2";
  eventKey: string;
  phoneNumberId: string;
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  toWaId: string | null;
  toBsuid: string | null;
  origin: string | null;
  messageType: string | null;
  body: string | null;
  media: KapsoMediaRef | null;
  sentAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
};
/** An item we will not process; only identifiers and the raw (sanitised) origin are kept, never content. */
export type KapsoHeld = {
  kind: "held";
  eventKey: string;
  phoneNumberId: string;
  waMessageId: string;
  direction: "inbound" | "outbound";
  origin: string | null;
  messageType: string | null;
  sentAt: Date | null;
  decision: "history_sync" | "quarantine";
  reason: string;
};
export type KapsoEventV2 = KapsoInboundV2 | KapsoStatusV2 | KapsoHeld;
/** `sources[i]` is the original item `events[i]` came from (needed only to quarantine it later, e.g. for protocol reasons). */
export type KapsoParseResultV2 = { events: KapsoEventV2[]; sources: unknown[]; invalid: KapsoInvalidItem[]; errors: string[] };

export type OriginDecision =
  | { class: "customer" }
  | { class: "crm_or_api" }
  | { class: "echo"; origin: EchoOrigin }
  | { class: "history_sync" }
  | { class: "quarantine"; reason: "origin.unknown" | "origin.direction_conflict" };

/** Pure classification. `origin` is the raw `message.kapso.origin` (null when absent). */
export function classifyOrigin(direction: "inbound" | "outbound", origin: string | null): OriginDecision {
  if (origin === "history_sync") return { class: "history_sync" };
  const echo = (ECHO_ORIGINS as readonly string[]).includes(origin ?? "");
  if (direction === "inbound") {
    if (origin === null || origin === "cloud_api") return { class: "customer" };
    return { class: "quarantine", reason: echo ? "origin.direction_conflict" : "origin.unknown" };
  }
  if (origin === null || origin === "cloud_api") return { class: "crm_or_api" };
  if (echo) return { class: "echo", origin: origin as EchoOrigin };
  return { class: "quarantine", reason: "origin.unknown" };
}

function readPath(item: Obj, path: readonly string[]): unknown {
  let cur: unknown = item;
  for (const k of path) {
    if (!isObj(cur)) return null;
    cur = (cur as Obj)[k];
  }
  return cur;
}
/** Distinct values at `paths` with the BSUID shape. A value that is present but malformed counts as absent (never stored). */
export function extractBsuids(item: Obj, paths: BsuidPaths): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const v = str(readPath(item, p));
    if (v && BSUID_SHAPE.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** `bsuidPaths` replaces the field list for BOTH directions (tests, or a reprocess with a verified new location). */
export type ParseOptionsV2 = { bsuidPaths?: BsuidPaths };

export function parseKapsoPayloadV2(payload: unknown, eventName: KapsoEventName, opts: ParseOptionsV2 = {}): KapsoParseResultV2 {
  const result: KapsoParseResultV2 = { events: [], sources: [], invalid: [], errors: [] };
  if (!isObj(payload)) { result.errors.push("payload.not_object"); return result; }

  let items: unknown[];
  if (payload.batch === true) {
    if (!Array.isArray(payload.data)) { result.errors.push("batch.missing_data"); return result; }
    if (payload.data.length > KAPSO_MAX_BATCH_ITEMS) { result.errors.push("batch.too_large"); return result; }
    items = payload.data;
  } else items = [payload];

  const reject = (item: unknown, i: number, reason: string) => {
    result.errors.push(`item[${i}].${reason}`);
    result.invalid.push(buildInvalidItem(item, eventName, reason));
  };
  const accept = (item: unknown, ev: KapsoEventV2) => { result.events.push(ev); result.sources.push(item); };

  items.forEach((item, i) => {
    if (!isObj(item) || !isObj(item.message)) return reject(item, i, "missing_message");
    const m = item.message as Obj;
    const conv = isObj(item.conversation) ? (item.conversation as Obj) : {};
    const phoneNumberId = str(item.phone_number_id) ?? str(conv.phone_number_id);
    if (!phoneNumberId || !PHONE_NUMBER_ID.test(phoneNumberId)) return reject(item, i, "invalid_phone_number_id");
    const id = str(m.id);
    if (!id || !WA_MESSAGE_ID.test(id)) return reject(item, i, "invalid_message_id");

    const kapso = isObj(m.kapso) ? (m.kapso as Obj) : {};
    const direction = str(kapso.direction);
    const wantInbound = eventName === "whatsapp.message.received";
    if (direction !== null && direction !== (wantInbound ? "inbound" : "outbound")) return reject(item, i, "direction_mismatch");
    const dir: "inbound" | "outbound" = wantInbound ? "inbound" : "outbound";

    const rawOrigin = str(kapso.origin);
    const originValid = rawOrigin !== null && ORIGIN_SHAPE.test(rawOrigin);
    const origin = rawOrigin === null ? null : originValid ? rawOrigin : "invalid";   // never store arbitrary text
    const decision = originValid || rawOrigin === null ? classifyOrigin(dir, origin) : ({ class: "quarantine", reason: "origin.unknown" } as OriginDecision);
    const content = extractContent(m);
    // A media message's text is its caption only: Kapso's generated description ("Image attached (x.jpg) … URL: https://…") is never stored.
    const media = extractKapsoMedia(m);
    const body = media ? clip(mediaCaption(m)) : content.body;
    const sentAt = parseTimestamp(m.timestamp);
    const status = wantInbound ? null : STATUS_BY_EVENT[eventName as Exclude<KapsoEventName, "whatsapp.message.received">];
    const eventKey = wantInbound ? `kapso:msg:${id}` : `kapso:status:${id}:${status}`;

    if (decision.class === "history_sync" || decision.class === "quarantine") {
      return accept(item, {
        kind: "held", eventKey, phoneNumberId, waMessageId: id, direction: dir, origin, messageType: content.type, sentAt,
        decision: decision.class, reason: decision.class === "quarantine" ? decision.reason : "history_sync",
      });
    }

    // Both phone fields name the customer (conversation.phone_number is the counterpart, phone_number_id the business); a BSUID-only
    // customer has neither. Two fields that disagree are never resolved by picking one.
    const msgWa = normalizeWaId(wantInbound ? m.from : m.to), convWa = normalizeWaId(conv.phone_number);
    const bsuids = extractBsuids(item, opts.bsuidPaths ?? KAPSO_BSUID_PATHS[dir]);
    if ((msgWa && convWa && msgWa !== convWa) || bsuids.length > 1) return reject(item, i, "conflicting_customer_identity");
    const wa = msgWa ?? convWa;
    const bsuid = bsuids[0] ?? null;
    if (wantInbound) {
      if (!wa && !bsuid) return reject(item, i, "missing_customer_identity");
      if (!sentAt) return reject(item, i, "invalid_timestamp");
      return accept(item, {
        kind: "kapso_inbound_v2", eventKey, phoneNumberId, waMessageId: id, fromWaId: wa, fromBsuid: bsuid, origin,
        profileName: clip(str(conv.contact_name)), messageType: content.type, body, media, sentAt,
      });
    }
    const failure = status === "failed" ? firstFailure(m) : { code: null, message: null };
    accept(item, {
      kind: "kapso_status_v2", eventKey, phoneNumberId, waMessageId: id, status: status!, toWaId: wa, toBsuid: bsuid, origin,
      messageType: content.type, body, media, sentAt, errorCode: failure.code, errorMessage: failure.message,
    });
  });
  return result;
}

/** Retry-queue payloads: the keys are exactly the ones process_webhook_retries reads for 'kapso_inbound_v2' / 'kapso_status_v2'. */
export function serializeKapsoEventV2(e: KapsoInboundV2 | KapsoStatusV2): Record<string, unknown> {
  const out: Record<string, unknown> = { ...e, media: e.media ?? null };
  for (const [k, v] of Object.entries(out)) if (v instanceof Date) out[k] = v.toISOString();
  return out;
}
/** Quarantine record: identifiers and the sanitised origin only. No message text, no customer phone, no BSUID, no profile name. */
export function quarantinePayload(e: KapsoHeld): Record<string, unknown> {
  return {
    kind: "kapso_quarantined", eventKey: e.eventKey, phoneNumberId: e.phoneNumberId, waMessageId: e.waMessageId, direction: e.direction,
    origin: e.origin, messageType: e.messageType, reason: e.reason, sentAt: e.sentAt ? e.sentAt.toISOString() : null,
  };
}

/** What the database knows about the account behind a phone_number_id (kapso_account_protocol). null = no active Kapso account. */
export type KapsoAccountClass = "sandbox" | "production" | "misconfigured" | null;

export type HeldRecord = {
  eventKey: string; kind: "message" | "status" | "other"; phoneNumberId: string | null; payload: Record<string, unknown>;
  status: "failed" | "ignored"; reason: string;
};

export interface KapsoStoreV2 {
  /** claim_kapso_event: like claim_webhook_event, but a non-final row gets the NEW payload (a fresh parse replaces a quarantine record). */
  claimEvent(e: { eventKey: string; kind: "message" | "status"; phoneNumberId: string; payload: unknown }): Promise<ClaimResult>;
  /**
   * finish_kapso_event: processed / ignored are terminal. 'finished' = this call moved the row; 'already_final' = the row was already
   * processed/ignored and was left unchanged (whatever status was requested).
   */
  finishEvent(eventKey: string, status: "processed" | "failed" | "ignored", error?: string): Promise<"finished" | "already_final">;
  /**
   * record_kapso_held_event: one atomic write of a quarantined (failed) or ignored item. 'duplicate' = left unchanged because the row
   * is terminal or is a processable event (pending/failed); only an existing quarantine record is refreshed.
   */
  recordHeld(e: HeldRecord): Promise<"recorded" | "duplicate">;
  /** kapso_account_protocol. */
  accountClass(phoneNumberId: string): Promise<KapsoAccountClass>;
  ingestInbound(e: KapsoInboundV2): Promise<{ duplicate: boolean }>;
  /** false = cannot be applied yet (retry-safe); the retry job passes isRetry=true later. */
  applyStatus(e: KapsoStatusV2): Promise<boolean>;
  /** Best-effort account telemetry; its own transaction; failures never matter. */
  touchAccount(phoneNumberId: string): Promise<void>;
}
/** list_kapso_quarantined: quarantine rows of one reason, oldest first. */
export interface KapsoQuarantineReader {
  listQuarantined(reason: string, limit: number): Promise<Array<{ eventKey: string; payload: unknown }>>;
}

export type KapsoOutcomeV2 = {
  httpStatus: 200 | 401 | 503;
  processed: number; duplicates: number; failed: number; ignored: number; quarantined: number; historySyncIgnored: number;
  parseErrors: string[];
  /** origin -> count, sanitised strings only (for the structured log) */
  origins: Record<string, number>;
};
export type KapsoRequestV2 = { rawBody: Uint8Array; signature: string | null; eventName: string | null; payloadVersion: string | null };

export function safeErrorCode(err: unknown): string {
  const raw = err instanceof Error ? err.message
    : typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message
    : String(err);
  const msg = raw.trim();
  return /^[a-z_]+(\.[a-z_]+){1,3}$/.test(msg) && msg.length <= 120 ? msg : "processing_error";
}

export type LogSink = (line: Record<string, unknown>) => void;

/** One structured line per delivery: counters and stable codes only. Never content, phones, ids, signatures or secrets. */
export function safeDeliveryLog(o: KapsoOutcomeV2): Record<string, unknown> {
  return {
    event: "kapso.webhook", http: o.httpStatus, processed: o.processed, duplicates: o.duplicates, failed: o.failed, ignored: o.ignored,
    quarantined: o.quarantined, historySyncIgnored: o.historySyncIgnored, parseErrors: o.parseErrors.slice(0, 5), origins: o.origins,
  };
}

/** Thrown inside the pipeline when a durable write failed: the whole delivery answers 503. */
class StorageUnavailable extends Error {
  constructor() { super("storage.unavailable"); }
}
const durable = async <T>(p: Promise<T>): Promise<T> => {
  try { return await p; } catch { throw new StorageUnavailable(); }
};

const emptyOutcome = (): KapsoOutcomeV2 => ({ httpStatus: 200, processed: 0, duplicates: 0, failed: 0, ignored: 0, quarantined: 0, historySyncIgnored: 0, parseErrors: [], origins: {} });

async function recordInvalid(store: KapsoStoreV2, e: KapsoInvalidItem, out: KapsoOutcomeV2): Promise<void> {
  const r = await durable(store.recordHeld({
    eventKey: e.eventKey, kind: e.dbKind, phoneNumberId: e.phoneNumberId, payload: invalidRecordPayload(e), status: "failed", reason: invalidErrorCode(e),
  }));
  if (r === "duplicate") out.duplicates++; else out.quarantined++;
}

/** One parsed event through the pipeline. Throws StorageUnavailable when its state could not be recorded. */
async function processEventV2(store: KapsoStoreV2, ev: KapsoEventV2, out: KapsoOutcomeV2, touched: Set<string>, onMedia?: (waMessageId: string) => void): Promise<void> {
  if (ev.kind === "held") {
    const ignored = ev.decision === "history_sync";
    const r = await durable(store.recordHeld({
      eventKey: ev.eventKey, kind: ev.direction === "inbound" ? "message" : "status", phoneNumberId: ev.phoneNumberId,
      payload: quarantinePayload(ev), status: ignored ? "ignored" : "failed", reason: ev.reason,
    }));
    if (r === "duplicate") out.duplicates++;
    else if (ignored) { out.ignored++; out.historySyncIgnored++; }
    else out.quarantined++;
    return;
  }
  const claim = await durable(store.claimEvent({
    eventKey: ev.eventKey, kind: ev.kind === "kapso_inbound_v2" ? "message" : "status", phoneNumberId: ev.phoneNumberId,
    payload: serializeKapsoEventV2(ev),
  }));
  if (claim === "duplicate") { out.duplicates++; return; }
  // 'already_final' = another delivery or the retry job finished this event first (processed/ignored are terminal): it is
  // complete, so it counts as a duplicate - never as processed by us, never as failed retry work.
  const failedMark = async (code: string) => {
    if ((await durable(store.finishEvent(ev.eventKey, "failed", code))) === "already_final") out.duplicates++;
    else out.failed++;
  };
  let error: string;
  try {
    if (ev.kind === "kapso_inbound_v2") await store.ingestInbound(ev);
    else if (!(await store.applyStatus(ev))) return await failedMark("status.message_not_found");
    if ((await store.finishEvent(ev.eventKey, "processed")) === "already_final") { out.duplicates++; return; }
    out.processed++;
    touched.add(ev.phoneNumberId);
    if (ev.media && onMedia) { try { onMedia(ev.waMessageId); } catch { /* best effort: the file is also fetched on first view */ } }
    return;
  } catch (err) {
    if (err instanceof StorageUnavailable) throw err;
    error = safeErrorCode(err);
  }
  // The work failed (or its 'processed' mark could not be written): the row keeps the payload for the retry job.
  // If even this write fails, the row may be left 'pending' -> 503, so the provider redelivers (claim answers 'retry').
  await failedMark(error);
}

/** Account compatibility of protocol v2: sandbox and production accounts are both served by the Rev6 wrappers; a misconfigured one is not. */
async function checkAccount(store: KapsoStoreV2, pn: string, cache: Map<string, KapsoAccountClass>): Promise<KapsoAccountClass> {
  if (!cache.has(pn)) cache.set(pn, await durable(store.accountClass(pn)));
  return cache.get(pn)!;
}

export async function handleKapsoPostV2(
  req: KapsoRequestV2, secret: string, store: KapsoStoreV2,
  opts: ParseOptionsV2 & { log?: LogSink; /** called for each processed message that has a file, after it is stored (best-effort prefetch) */ onMedia?: (waMessageId: string) => void } = {},
): Promise<KapsoOutcomeV2> {
  const out = emptyOutcome();
  const done = (o: KapsoOutcomeV2) => { opts.log?.(safeDeliveryLog(o)); return o; };

  // 1. The signature over the RAW bytes first: nothing about an unauthenticated request is revealed or stored.
  if (!verifyKapsoSignature(req.rawBody, req.signature, secret)) return done({ ...out, httpStatus: 401 });

  try {
    // 2. Signed but unusable as a whole: recorded once (fingerprint of the body), then acknowledged.
    const payloadLevel = async (reason: KapsoPayloadReason, parsed?: unknown) => {
      out.parseErrors = [reason];
      await recordInvalid(store, buildInvalidPayload(req.rawBody, req.eventName, req.payloadVersion, reason, parsed), out);
      return done(out);
    };
    if (req.payloadVersion !== KAPSO_PAYLOAD_VERSION) return await payloadLevel("payload.unsupported_version");
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.rawBody)); }
    catch { return await payloadLevel("payload.invalid_json"); }
    if (!isSupportedKapsoEvent(req.eventName)) return await payloadLevel("event.unsupported", payload);

    const parsed = parseKapsoPayloadV2(payload, req.eventName, opts);
    const fatal = parsed.errors.find((e) => e === "batch.too_large" || e === "batch.missing_data" || e === "payload.not_object");
    if (fatal) return await payloadLevel(fatal as KapsoPayloadReason, payload);
    out.parseErrors = parsed.errors;

    // 3. Item by item, in order. A storage failure stops the delivery with 503; what was finished before is a duplicate on redelivery.
    for (const inv of parsed.invalid) await recordInvalid(store, inv, out);
    const touched = new Set<string>();
    const accounts = new Map<string, KapsoAccountClass>();
    for (let i = 0; i < parsed.events.length; i++) {
      const ev = parsed.events[i];
      if ("origin" in ev && ev.origin) out.origins[ev.origin] = (out.origins[ev.origin] ?? 0) + 1;
      const decision = ev.kind === "held" ? "process" : protocolDecision("v2", await checkAccount(store, ev.phoneNumberId, accounts));
      if (decision !== "process") {
        await recordInvalid(store, buildInvalidItem(parsed.sources[i], req.eventName, decision), out);
        continue;
      }
      await processEventV2(store, ev, out, touched, opts.onMedia);
    }
    // Telemetry only after the work is done, one call per account, in its own transaction; errors are swallowed.
    for (const pn of touched) await store.touchAccount(pn).catch(() => undefined);
    return done(out);
  } catch (err) {
    if (err instanceof StorageUnavailable) return done({ ...out, httpStatus: 503 });
    throw err;
  }
}

/**
 * Reprocess quarantine rows whose original item was kept (RECOVERABLE reasons), e.g. once KAPSO_BSUID_PATHS (or `bsuidPaths`) covers a
 * newly verified location. Each row is re-parsed with the CURRENT options; an item that now parses goes through the normal pipeline under its logical
 * key (claim_kapso_event replaces the quarantine payload, so a failure leaves ordinary retry work). An item that still does not parse is
 * left untouched. Nothing here is wired to a route: it is an operator action, run deliberately.
 */
export async function reprocessQuarantinedV2(
  store: KapsoStoreV2 & KapsoQuarantineReader, reason: string, opts: ParseOptionsV2 & { limit?: number } = {},
): Promise<{ examined: number; reprocessed: number; stillQuarantined: number; failed: number; unavailable: boolean }> {
  const res = { examined: 0, reprocessed: 0, stillQuarantined: 0, failed: 0, unavailable: false };
  let rows: Array<{ eventKey: string; payload: unknown }>;
  try { rows = await store.listQuarantined(reason, Math.min(Math.max(opts.limit ?? 100, 1), 500)); }
  catch { return { ...res, unavailable: true }; }
  for (const row of rows) {
    res.examined++;
    const p = isObj(row.payload) ? row.payload : {};
    const eventName = str(p.eventName);
    if (!eventName || !isSupportedKapsoEvent(eventName) || p.rawItem === null || p.rawItem === undefined) { res.stillQuarantined++; continue; }
    const parsed = parseKapsoPayloadV2(p.rawItem, eventName, opts);
    const ev = parsed.events[0];
    if (!ev || ev.kind === "held" || ev.eventKey !== row.eventKey) { res.stillQuarantined++; continue; }
    const out = emptyOutcome();
    try { await processEventV2(store, ev, out, new Set()); }
    catch { return { ...res, unavailable: true }; }
    if (out.processed || out.duplicates) res.reprocessed++; else res.failed++;
  }
  return res;
}

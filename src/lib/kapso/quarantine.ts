/**
 * Durable records for webhook items that cannot be processed (shared by protocol v1 and v2).
 *
 * Every signed item ends in a recorded state; nothing is dropped. An item we cannot process becomes a "quarantine" row in
 * whatsapp_webhook_events (status `failed`, payload kind `kapso_quarantined`, which the retry job never selects):
 *  - event key: the LOGICAL key (`kapso:msg:<wamid>` / `kapso:status:<wamid>:<status>`) when the item names a valid message id and the
 *    problem is recoverable (the customer identity is missing or unreadable, the timestamp is unreadable, the protocol is not
 *    compatible with the account). A later delivery of the same event that CAN be processed claims the same row and completes it.
 *    Otherwise a deterministic fingerprint `kapso:invalid:<sha256>` of the item, so a redelivery maps to the same row (no duplicates).
 *  - a payload-level problem (bad JSON, unsupported version or event, broken batch envelope): `kapso:invalid_payload:<sha256 of the body>`.
 *  - content: only for recoverable reasons the original item is kept (capped at KAPSO_QUARANTINE_MAX_RAW_BYTES) so it can be reprocessed
 *    once the identity can be read; otherwise only identifiers, reason and the key NAMES of the item are kept, never message text.
 *    Failed rows (and so quarantine rows) are deleted by the 30-day intake retention like every other failed row.
 */
import { createHash } from "node:crypto";
import { isObj, isSupportedKapsoEvent, PHONE_NUMBER_ID, str, STATUS_BY_EVENT, WA_MESSAGE_ID, type KapsoEventName, type Obj } from "./parser.ts";

export const KAPSO_QUARANTINE_MAX_RAW_BYTES = 16 * 1024;

/** Item-level reasons the parsers report (the v1 parser reports `missing_customer_phone` where v2 reports `missing_customer_identity`). */
export type KapsoItemReason =
  | "missing_message" | "invalid_phone_number_id" | "invalid_message_id" | "direction_mismatch"
  | "missing_customer_identity" | "missing_customer_phone" | "invalid_timestamp" | "conflicting_customer_identity";
/** Payload-level reasons (the whole signed body). */
export type KapsoPayloadReason =
  | "payload.unsupported_version" | "payload.invalid_json" | "payload.not_object" | "batch.missing_data" | "batch.too_large" | "event.unsupported";

/** Reasons that a later delivery, or a reprocess once the identity can be read, may resolve. Only these keep the original item. */
export const RECOVERABLE_REASONS: ReadonlySet<string> = new Set([
  "missing_customer_identity", "missing_customer_phone", "invalid_timestamp", "protocol.v2_required", "account.misconfigured",
]);

export type KapsoInvalidItem = {
  kind: "invalid";
  eventKey: string;
  dbKind: "message" | "status" | "other";
  /** Only when it has the expected shape; never guessed. */
  phoneNumberId: string | null;
  waMessageId: string | null;
  eventName: string;
  reason: string;
  /** The original item, only for RECOVERABLE_REASONS and only below the size cap. */
  rawItem: unknown | null;
  rawItemOmitted: "too_large" | "not_recoverable" | null;
  /** Key names (not values) of the item and of its message, for diagnosis. */
  shape: { item: string[]; message: string[] };
};

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const KEY_NAME = /^[A-Za-z0-9_]{1,40}$/;
const keyNames = (v: unknown): string[] => (isObj(v) ? Object.keys(v).filter((k) => KEY_NAME.test(k)).slice(0, 25).sort() : []);
/** Header values end up in records; keep only a safe shape. */
export function safeHeaderValue(v: string | null): string {
  if (v === null) return "missing";
  return /^[A-Za-z0-9_.:-]{1,60}$/.test(v) ? v : "invalid";
}

/** Logical event key of an item whose message id is valid, or null. */
export function logicalEventKey(eventName: string, waMessageId: string | null): string | null {
  if (!waMessageId || !WA_MESSAGE_ID.test(waMessageId) || !isSupportedKapsoEvent(eventName)) return null;
  if (eventName === "whatsapp.message.received") return `kapso:msg:${waMessageId}`;
  return `kapso:status:${waMessageId}:${STATUS_BY_EVENT[eventName as Exclude<KapsoEventName, "whatsapp.message.received">]}`;
}

export function buildInvalidItem(item: unknown, eventName: string, reason: string): KapsoInvalidItem {
  const it: Obj = isObj(item) ? item : {};
  const m: Obj = isObj(it.message) ? (it.message as Obj) : {};
  const conv: Obj = isObj(it.conversation) ? (it.conversation as Obj) : {};
  const pn = str(it.phone_number_id) ?? str(conv.phone_number_id);
  const phoneNumberId = pn && PHONE_NUMBER_ID.test(pn) ? pn : null;
  const id = str(m.id);
  const waMessageId = id && WA_MESSAGE_ID.test(id) ? id : null;
  const recoverable = RECOVERABLE_REASONS.has(reason);
  const logical = recoverable ? logicalEventKey(eventName, waMessageId) : null;
  // JSON.parse keeps key order, so the same delivered item always serialises to the same text.
  const serialized = JSON.stringify(item) ?? "null";
  const tooLarge = new TextEncoder().encode(serialized).byteLength > KAPSO_QUARANTINE_MAX_RAW_BYTES;
  const keep = recoverable && logical !== null && !tooLarge;
  return {
    kind: "invalid",
    eventKey: logical ?? `kapso:invalid:${sha256Hex(`${safeHeaderValue(eventName)}\n${serialized}`)}`,
    dbKind: !isSupportedKapsoEvent(eventName) ? "other" : eventName === "whatsapp.message.received" ? "message" : "status",
    phoneNumberId, waMessageId, eventName: safeHeaderValue(eventName), reason,
    rawItem: keep ? item : null,
    rawItemOmitted: keep ? null : recoverable && tooLarge ? "too_large" : "not_recoverable",
    shape: { item: keyNames(it), message: keyNames(m) },
  };
}

/** A signed body that cannot be split into items. Only its fingerprint, size and the safe header values are kept. */
export function buildInvalidPayload(rawBody: Uint8Array, eventName: string | null, payloadVersion: string | null, reason: KapsoPayloadReason, parsed?: unknown): KapsoInvalidItem {
  const top: Obj = isObj(parsed) ? parsed : {};
  const pn = parsed !== undefined && top.batch !== true ? str(top.phone_number_id) : null;
  return {
    kind: "invalid",
    eventKey: `kapso:invalid_payload:${sha256Hex(rawBody)}`,
    dbKind: "other",
    phoneNumberId: pn && PHONE_NUMBER_ID.test(pn) ? pn : null,
    waMessageId: null,
    eventName: `${safeHeaderValue(eventName)};version=${safeHeaderValue(payloadVersion)};bytes=${rawBody.byteLength}`,
    reason, rawItem: null, rawItemOmitted: "not_recoverable",
    shape: { item: keyNames(top), message: [] },
  };
}

/** The stored row payload. `kind` must stay `kapso_quarantined`: the retry job excludes exactly that kind. */
export function invalidRecordPayload(e: KapsoInvalidItem): Record<string, unknown> {
  return {
    kind: "kapso_quarantined", eventKey: e.eventKey, eventName: e.eventName, phoneNumberId: e.phoneNumberId, waMessageId: e.waMessageId,
    reason: e.reason, rawItem: e.rawItem, rawItemOmitted: e.rawItemOmitted, shape: e.shape,
  };
}

/** Machine-readable reason stored in last_error. */
export const invalidErrorCode = (e: KapsoInvalidItem): string => (e.reason.includes(".") ? e.reason : `invalid.${e.reason}`);

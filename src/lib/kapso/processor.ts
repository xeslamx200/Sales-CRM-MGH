/**
 * Kapso webhook processing, independent of HTTP and storage so it can be
 * unit-tested. The route handler supplies a `KapsoStore` backed by the
 * Supabase service-role client (see src/server/whatsapp/kapso-store.ts).
 *
 * Order of checks: the signature over the RAW bytes first (nothing else about
 * an unauthenticated request is revealed or stored), then the payload version,
 * then the JSON. Every signed item ends in a recorded state (processed,
 * duplicate, failed for our own retry job, or quarantined as invalid; see
 * src/lib/kapso/quarantine.ts), and then the delivery answers 200. Kapso
 * retries a non-2xx delivery only twice within ~50 seconds, so 503 is
 * reserved for the case where something could NOT be recorded (redelivery is
 * then deduplicated by the event keys).
 *
 * Idempotency does not rely on Kapso's `X-Idempotency-Key`: the logical keys
 * `kapso:msg:<wamid>` and `kapso:status:<wamid>:<status>` also dedupe the same
 * event arriving in different deliveries, in batches, or in parallel.
 *
 * Protocol check: this path ("v1") serves Kapso SANDBOX accounts only (the
 * 0960 wrappers refuse anything else). When the database knows the account
 * model (Rev6 + supabase/proposed/20261104000978), an item of a production
 * account is quarantined as `protocol.v2_required` with its original item,
 * instead of being queued as v1 retry work that could never succeed.
 */
import type { ClaimResult } from "../whatsapp/processor.ts";
import {
  isObj,
  isSupportedKapsoEvent,
  KAPSO_PAYLOAD_VERSION,
  parseKapsoPayload,
  type KapsoEvent,
  type KapsoMessageEvent,
  type KapsoStatusEvent,
} from "./parser.ts";
import {
  buildInvalidItem,
  buildInvalidPayload,
  invalidErrorCode,
  invalidRecordPayload,
  type KapsoInvalidItem,
  type KapsoPayloadReason,
} from "./quarantine.ts";
import { protocolDecision, type AccountClass } from "./protocol.ts";
import { verifyKapsoSignature } from "./signature.ts";

/** Account model behind a phone_number_id; "pre_rev6" = the database has no account model yet (every Kapso account is a sandbox). */
export type KapsoAccountClassV1 = AccountClass;

export interface KapsoStore {
  claimEvent(e: { eventKey: string; kind: KapsoEvent["kind"] | "other"; phoneNumberId: string | null; payload: unknown }): Promise<ClaimResult>;
  finishEvent(eventKey: string, status: "processed" | "failed" | "ignored", error?: string): Promise<void>;
  ingestMessage(e: KapsoMessageEvent): Promise<{ duplicate: boolean }>;
  /** false = cannot be applied yet (message unknown and customer not named). */
  applyStatus(e: KapsoStatusEvent): Promise<boolean>;
  /** Optional protocol check (kapso_account_protocol). Absent = not checked. */
  accountClass?(phoneNumberId: string): Promise<KapsoAccountClassV1>;
}

export type KapsoOutcome = {
  httpStatus: 200 | 401 | 503;
  processed: number;
  duplicates: number;
  failed: number;
  ignored: number;
  quarantined: number;
  parseErrors: string[];
};

export type KapsoRequest = {
  rawBody: Uint8Array;
  signature: string | null;
  /** `X-Webhook-Event` */
  eventName: string | null;
  /** `X-Webhook-Payload-Version` */
  payloadVersion: string | null;
};

/** `whatsapp_webhook_events.event_kind` accepts message | status | other. */
export function kapsoDbEventKind(kind: KapsoEvent["kind"] | "other"): "message" | "status" | "other" {
  return kind === "kapso_status" ? "status" : kind === "other" ? "other" : "message";
}

/** A database without the function (PostgREST PGRST202, PostgreSQL 42883): the schema predates the account model. */
export function isMissingFunctionError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === "PGRST202" || code === "42883";
}

/**
 * Error text safe to persist: a stable dotted code, never message content.
 * Database rules raise messages that are exactly a dotted key (e.g.
 * "kapso.unknown_account"). The Supabase client reports them as plain
 * `{ code, message }` objects, not Error instances, so both shapes are read.
 * Anything else may contain user data and becomes a generic code.
 */
export function safeKapsoErrorCode(err: unknown): string {
  const raw =
    err instanceof Error ? err.message
    : typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message
    : String(err);
  const msg = raw.trim();
  return /^[a-z_]+(\.[a-z_]+){1,3}$/.test(msg) && msg.length <= 120 ? msg : "processing_error";
}

/**
 * Processes one claimed event. "unrecorded" = the event's state could not be
 * written (its row may still be 'pending'): the delivery must answer 503.
 */
export async function processKapsoEvent(store: KapsoStore, event: KapsoEvent): Promise<"processed" | "failed" | "unrecorded"> {
  let code: string;
  try {
    if (event.kind === "kapso_message") {
      await store.ingestMessage(event);
    } else {
      const applied = await store.applyStatus(event);
      if (!applied) {
        try {
          await store.finishEvent(event.eventKey, "failed", "status.message_not_found");
        } catch {
          return "unrecorded";
        }
        return "failed";
      }
    }
    await store.finishEvent(event.eventKey, "processed");
    return "processed";
  } catch (err) {
    code = safeKapsoErrorCode(err);
  }
  try {
    await store.finishEvent(event.eventKey, "failed", code);
  } catch {
    return "unrecorded";
  }
  return "failed";
}

/** JSON-safe copy of an event for the retry queue; the keys match process_webhook_retries. */
export function serializeKapsoEvent(event: KapsoEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { ...event, media: null };
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Date) out[k] = v.toISOString();
  }
  return out;
}

/** The items of a parsed payload, the same way parseKapsoPayload splits them. */
function itemsOf(payload: unknown): unknown[] {
  if (!isObj(payload)) return [];
  return payload.batch === true ? (Array.isArray(payload.data) ? payload.data : []) : [payload];
}

class Unrecorded extends Error {}

/** Two-step record with the generic RPCs (present on every schema): claim, then finish 'failed' with the reason. */
async function recordInvalidV1(store: KapsoStore, e: KapsoInvalidItem, outcome: KapsoOutcome): Promise<void> {
  let claim: ClaimResult;
  try {
    claim = await store.claimEvent({
      eventKey: e.eventKey,
      kind: e.dbKind === "status" ? "kapso_status" : e.dbKind === "other" ? "other" : "kapso_message",
      phoneNumberId: e.phoneNumberId,
      payload: invalidRecordPayload(e),
    });
    if (claim === "duplicate") {
      outcome.duplicates++;
      return;
    }
    await store.finishEvent(e.eventKey, "failed", invalidErrorCode(e));
  } catch {
    throw new Unrecorded();
  }
  outcome.quarantined++;
}

export async function handleKapsoPost(req: KapsoRequest, secret: string, store: KapsoStore): Promise<KapsoOutcome> {
  const outcome: KapsoOutcome = { httpStatus: 200, processed: 0, duplicates: 0, failed: 0, ignored: 0, quarantined: 0, parseErrors: [] };

  if (!verifyKapsoSignature(req.rawBody, req.signature, secret)) {
    return { ...outcome, httpStatus: 401 };
  }

  try {
    const payloadLevel = async (reason: KapsoPayloadReason, parsedPayload?: unknown) => {
      outcome.parseErrors = [reason];
      await recordInvalidV1(store, buildInvalidPayload(req.rawBody, req.eventName, req.payloadVersion, reason, parsedPayload), outcome);
      return outcome;
    };
    if (req.payloadVersion !== KAPSO_PAYLOAD_VERSION) return await payloadLevel("payload.unsupported_version");

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.rawBody));
    } catch {
      return await payloadLevel("payload.invalid_json");
    }

    // A signed delivery of an event we do not handle: recorded for investigation, then acknowledged.
    if (!isSupportedKapsoEvent(req.eventName)) return await payloadLevel("event.unsupported", payload);

    const parsed = parseKapsoPayload(payload, req.eventName);
    const fatal = parsed.errors.find((e) => e === "batch.too_large" || e === "batch.missing_data" || e === "payload.not_object");
    if (fatal) return await payloadLevel(fatal as KapsoPayloadReason, payload);
    outcome.parseErrors = parsed.errors;

    // Invalid items are recorded, never dropped (the error strings are "item[<i>].<reason>").
    const items = itemsOf(payload);
    for (const err of parsed.errors) {
      const m = /^item\[(\d+)\]\.([a-z_]+)$/.exec(err);
      if (m) await recordInvalidV1(store, buildInvalidItem(items[Number(m[1])], req.eventName, m[2]), outcome);
    }

    const accounts = new Map<string, KapsoAccountClassV1>();
    for (const event of parsed.events) {
      if (store.accountClass) {
        if (!accounts.has(event.phoneNumberId)) {
          let cls: KapsoAccountClassV1;
          try {
            cls = await store.accountClass(event.phoneNumberId);
          } catch (err) {
            if (!isMissingFunctionError(err)) throw new Unrecorded();
            cls = "pre_rev6";
          }
          accounts.set(event.phoneNumberId, cls);
        }
        const decision = protocolDecision("v1", accounts.get(event.phoneNumberId) ?? null);
        if (decision !== "process") {
          const src = items.find((it) => isObj(it) && isObj(it.message) && it.message.id === event.waMessageId);
          await recordInvalidV1(store, buildInvalidItem(src, req.eventName, decision), outcome);
          continue;
        }
      }

      let claim: ClaimResult;
      try {
        claim = await store.claimEvent({
          eventKey: event.eventKey,
          kind: event.kind,
          phoneNumberId: event.phoneNumberId,
          payload: serializeKapsoEvent(event),
        });
      } catch {
        throw new Unrecorded();
      }
      if (claim === "duplicate") {
        outcome.duplicates++;
        continue;
      }
      const result = await processKapsoEvent(store, event);
      if (result === "unrecorded") throw new Unrecorded();
      if (result === "processed") outcome.processed++;
      else outcome.failed++;
    }
    return outcome;
  } catch (err) {
    if (err instanceof Unrecorded) return { ...outcome, httpStatus: 503 };
    throw err;
  }
}

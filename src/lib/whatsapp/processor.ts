/**
 * WhatsApp webhook processing, independent of HTTP and storage so it can be
 * unit-tested. The route handler supplies a `WebhookStore` backed by the
 * Supabase service-role client (see src/server/whatsapp/store.ts).
 *
 * Contract with Meta: answer 200 quickly once the signature is valid and the
 * batch has been recorded; Meta retries non-2xx deliveries. Per-event
 * failures are recorded and retried by our own job, so one bad event never
 * makes Meta redeliver (and us reprocess) the whole batch.
 */
import { verifyMetaSignature } from "./signature.ts";
import {
  parseWebhookPayload,
  type EchoMessageEvent,
  type InboundMessageEvent,
  type StatusEvent,
  type WebhookEvent,
} from "./webhook-parser.ts";

export type ClaimResult = "new" | "retry" | "duplicate";

/**
 * `whatsapp_webhook_events.event_kind` accepts message | status | other.
 * Coexistence echoes are message events; storing "echo" would violate the
 * check constraint, make every claim fail and turn into 503s that Meta
 * redelivers indefinitely. The full event (incl. kind "echo") is kept in the
 * payload, so retries still dispatch it correctly.
 */
export function dbEventKind(kind: WebhookEvent["kind"]): "message" | "status" {
  return kind === "status" ? "status" : "message";
}

export interface WebhookStore {
  claimEvent(e: { eventKey: string; kind: WebhookEvent["kind"]; phoneNumberId: string; payload: unknown }): Promise<ClaimResult>;
  finishEvent(eventKey: string, status: "processed" | "failed" | "ignored", error?: string): Promise<void>;
  ingestMessage(e: InboundMessageEvent): Promise<{ duplicate: boolean }>;
  ingestEcho(e: EchoMessageEvent): Promise<{ duplicate: boolean }>;
  /** false = message not found (e.g. status raced ahead of the send result). */
  applyStatus(e: StatusEvent): Promise<boolean>;
}

export type ProcessOutcome = {
  httpStatus: 200 | 400 | 401 | 503;
  processed: number;
  duplicates: number;
  failed: number;
  parseErrors: string[];
};

/** Error text safe to persist: a stable code, never message content. */
export function safeErrorCode(err: unknown): string {
  // Database rules raise messages that are exactly a dotted key
  // (e.g. "whatsapp.unknown_phone_number_id"). Anything else may contain
  // user data, so it is replaced by a generic code.
  const msg = (err instanceof Error ? err.message : String(err)).trim();
  return /^[a-z_]+(\.[a-z_]+){1,3}$/.test(msg) && msg.length <= 120 ? msg : "processing_error";
}

export async function processEvent(store: WebhookStore, event: WebhookEvent): Promise<"processed" | "failed"> {
  try {
    if (event.kind === "message") {
      await store.ingestMessage(event);
    } else if (event.kind === "echo") {
      await store.ingestEcho(event);
    } else {
      const found = await store.applyStatus(event);
      if (!found) {
        await store.finishEvent(event.eventKey, "failed", "status.message_not_found");
        return "failed";
      }
    }
    await store.finishEvent(event.eventKey, "processed");
    return "processed";
  } catch (err) {
    await store.finishEvent(event.eventKey, "failed", safeErrorCode(err)).catch(() => undefined);
    return "failed";
  }
}

export async function handleWebhookPost(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
  store: WebhookStore,
): Promise<ProcessOutcome> {
  const outcome: ProcessOutcome = { httpStatus: 200, processed: 0, duplicates: 0, failed: 0, parseErrors: [] };

  if (!verifyMetaSignature(rawBody, signatureHeader, appSecret)) {
    return { ...outcome, httpStatus: 401 };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ...outcome, httpStatus: 400, parseErrors: ["payload.invalid_json"] };
  }

  const parsed = parseWebhookPayload(payload);
  outcome.parseErrors = parsed.errors;

  for (const event of parsed.events) {
    let claim: ClaimResult;
    try {
      claim = await store.claimEvent({
        eventKey: event.eventKey,
        kind: event.kind,
        phoneNumberId: event.phoneNumberId,
        payload: serializeEvent(event),
      });
    } catch {
      // Storage unavailable: ask Meta to redeliver. Already-claimed events in
      // this batch are deduplicated on redelivery.
      return { ...outcome, httpStatus: 503 };
    }
    if (claim === "duplicate") {
      outcome.duplicates++;
      continue;
    }
    const result = await processEvent(store, event);
    if (result === "processed") outcome.processed++;
    else outcome.failed++;
  }
  return outcome;
}

/** JSON-safe copy of an event for the retry queue. */
export function serializeEvent(event: WebhookEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { ...event };
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Date) out[k] = v.toISOString();
  }
  return out;
}

export function deserializeEvent(data: Record<string, unknown>): WebhookEvent | null {
  const kind = data.kind;
  if (kind !== "message" && kind !== "echo" && kind !== "status") return null;
  const copy: Record<string, unknown> = { ...data };
  for (const k of ["sentAt", "at"]) {
    if (typeof copy[k] === "string") {
      const d = new Date(copy[k] as string);
      if (Number.isNaN(d.getTime())) return null;
      copy[k] = d;
    }
  }
  return copy as unknown as WebhookEvent;
}

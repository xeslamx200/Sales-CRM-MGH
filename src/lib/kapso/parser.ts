/**
 * Parse a Kapso webhook (payload version v2) into flat, validated events.
 *
 * Kapso names the event only in the `X-Webhook-Event` header; the body is
 * `{ message, conversation, is_new_conversation, phone_number_id }`, or a batch
 * envelope `{ type, batch: true, data: [...], batch_info }` (received messages
 * only). Unknown fields are ignored; malformed parts are reported in `errors`
 * without throwing, so one bad item never blocks the rest of a batch.
 *
 * Phase 1 records text only: media is never fetched or referenced (Kapso hosts
 * it behind its own URLs and we have no verified, safe download path yet), so
 * a media message keeps its type and caption.
 */

export const KAPSO_PAYLOAD_VERSION = "v2";
export const KAPSO_MAX_BATCH_ITEMS = 100;

export type KapsoMessageEvent = {
  kind: "kapso_message";
  eventKey: string;
  phoneNumberId: string;
  waMessageId: string;
  fromWaId: string;
  profileName: string | null;
  messageType: string;
  body: string | null;
  sentAt: Date;
};

export type KapsoStatusEvent = {
  kind: "kapso_status";
  eventKey: string;
  phoneNumberId: string;
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  /** The customer, when the payload names them; needed to record a message we never saw. */
  toWaId: string | null;
  messageType: string | null;
  body: string | null;
  sentAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type KapsoEvent = KapsoMessageEvent | KapsoStatusEvent;

export type KapsoParseResult = {
  events: KapsoEvent[];
  errors: string[];
};

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const MAX_BODY = 4096;

export const KAPSO_EVENT_NAMES = [
  "whatsapp.message.received",
  "whatsapp.message.sent",
  "whatsapp.message.delivered",
  "whatsapp.message.read",
  "whatsapp.message.failed",
] as const;
export type KapsoEventName = (typeof KAPSO_EVENT_NAMES)[number];

export function isSupportedKapsoEvent(name: string | null): name is KapsoEventName {
  return name !== null && (KAPSO_EVENT_NAMES as readonly string[]).includes(name);
}

export const STATUS_BY_EVENT: Record<Exclude<KapsoEventName, "whatsapp.message.received">, KapsoStatusEvent["status"]> = {
  "whatsapp.message.sent": "sent",
  "whatsapp.message.delivered": "delivered",
  "whatsapp.message.read": "read",
  "whatsapp.message.failed": "failed",
};

export function parseTimestamp(v: unknown): Date | null {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!s || !/^\d{9,11}$/.test(s)) return null;
  const d = new Date(Number(s) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function clip(s: string | null): string | null {
  return s == null ? null : s.slice(0, MAX_BODY);
}

/** Digits only, no leading "+": the form the database expects. */
export function normalizeWaId(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const digits = s.replace(/[\s()+-]/g, "");
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

/** Stable, injection-safe shapes only: ids end up in event keys and log codes. */
export const WA_MESSAGE_ID = /^[A-Za-z0-9._=+/-]{1,200}$/;
export const PHONE_NUMBER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Text shown in the inbox for each message type (no media is referenced in Phase 1). */
export function extractContent(m: Obj): { type: string; body: string | null } {
  const type = str(m.type) ?? "unknown";
  const part = isObj(m[type]) ? (m[type] as Obj) : {};
  let body: string | null = null;
  switch (type) {
    case "text":
      body = str(part.body);
      break;
    case "image":
    case "video":
    case "document":
      body = str(part.caption);
      break;
    case "interactive": {
      const reply = isObj(part.button_reply) ? part.button_reply : isObj(part.list_reply) ? part.list_reply : null;
      body = reply ? str((reply as Obj).title) : null;
      break;
    }
    case "button":
      body = str(part.text);
      break;
    case "reaction":
      body = str(part.emoji);
      break;
    default:
      body = null;
  }
  if (body === null && isObj(m.kapso)) body = str((m.kapso as Obj).content);
  return { type, body: clip(body) };
}

export function firstFailure(m: Obj): { code: string | null; message: string | null } {
  const statuses = isObj(m.kapso) ? arr((m.kapso as Obj).statuses) : [];
  for (const s of statuses) {
    if (!isObj(s) || s.status !== "failed") continue;
    const e = arr(s.errors).find(isObj) as Obj | undefined;
    if (e) {
      return {
        code: e.code != null ? String(e.code).slice(0, 40) : null,
        message: str(e.title) ?? str(e.message),
      };
    }
  }
  return { code: null, message: null };
}

/**
 * @param eventName the `X-Webhook-Event` header (already known to be supported)
 */
export function parseKapsoPayload(payload: unknown, eventName: KapsoEventName): KapsoParseResult {
  const result: KapsoParseResult = { events: [], errors: [] };
  if (!isObj(payload)) {
    result.errors.push("payload.not_object");
    return result;
  }

  let items: unknown[];
  if (payload.batch === true) {
    if (!Array.isArray(payload.data)) {
      result.errors.push("batch.missing_data");
      return result;
    }
    if (payload.data.length > KAPSO_MAX_BATCH_ITEMS) {
      result.errors.push("batch.too_large");
      return result;
    }
    items = payload.data;
  } else {
    items = [payload];
  }

  items.forEach((item, i) => {
    const at = `item[${i}]`;
    if (!isObj(item) || !isObj(item.message)) return void result.errors.push(`${at}.missing_message`);
    const m = item.message as Obj;
    const conv = isObj(item.conversation) ? (item.conversation as Obj) : {};

    const phoneNumberId = str(item.phone_number_id) ?? str(conv.phone_number_id);
    if (!phoneNumberId || !PHONE_NUMBER_ID.test(phoneNumberId)) {
      return void result.errors.push(`${at}.invalid_phone_number_id`);
    }
    const id = str(m.id);
    if (!id || !WA_MESSAGE_ID.test(id)) return void result.errors.push(`${at}.invalid_message_id`);

    // Cross-check the (unsigned) header against the (signed) body.
    const direction = isObj(m.kapso) ? str((m.kapso as Obj).direction) : null;
    const wantInbound = eventName === "whatsapp.message.received";
    if (direction !== null && direction !== (wantInbound ? "inbound" : "outbound")) {
      return void result.errors.push(`${at}.direction_mismatch`);
    }

    const content = extractContent(m);
    const sentAt = parseTimestamp(m.timestamp);

    if (wantInbound) {
      const from = normalizeWaId(m.from) ?? normalizeWaId(conv.phone_number);
      if (!from) return void result.errors.push(`${at}.missing_customer_phone`);
      if (!sentAt) return void result.errors.push(`${at}.invalid_timestamp`);
      result.events.push({
        kind: "kapso_message",
        eventKey: `kapso:msg:${id}`,
        phoneNumberId,
        waMessageId: id,
        fromWaId: from,
        profileName: clip(str(conv.contact_name)),
        messageType: content.type,
        body: content.body,
        sentAt,
      });
      return;
    }

    const status = STATUS_BY_EVENT[eventName];
    const failure = status === "failed" ? firstFailure(m) : { code: null, message: null };
    result.events.push({
      kind: "kapso_status",
      eventKey: `kapso:status:${id}:${status}`,
      phoneNumberId,
      waMessageId: id,
      status,
      toWaId: normalizeWaId(m.to) ?? normalizeWaId(conv.phone_number),
      messageType: content.type,
      body: content.body,
      sentAt,
      errorCode: failure.code,
      errorMessage: failure.message,
    });
  });

  return result;
}

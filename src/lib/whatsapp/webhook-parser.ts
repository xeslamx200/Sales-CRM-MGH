/**
 * Parse a WhatsApp Cloud API webhook payload into flat, validated events.
 *
 * Meta batches several changes per POST and retries deliveries, so every
 * event carries a stable `eventKey` used for deduplication. Unknown fields
 * are ignored; malformed parts are reported in `errors` without throwing,
 * so one bad item never blocks the rest of a batch.
 */

export type MediaRef = {
  id: string;
  mimeType?: string;
  sha256?: string;
  filename?: string;
  caption?: string;
};

export type InboundMessageEvent = {
  kind: "message";
  eventKey: string;
  phoneNumberId: string;
  waMessageId: string;
  fromWaId: string;
  profileName: string | null;
  messageType: string;
  body: string | null;
  media: MediaRef | null;
  sentAt: Date;
};

/** A message the business sent from the WhatsApp Business app (coexistence). */
export type EchoMessageEvent = {
  kind: "echo";
  eventKey: string;
  phoneNumberId: string;
  waMessageId: string;
  toWaId: string;
  messageType: string;
  body: string | null;
  media: MediaRef | null;
  sentAt: Date;
};

export type StatusEvent = {
  kind: "status";
  eventKey: string;
  phoneNumberId: string;
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipientWaId: string | null;
  at: Date;
  errorCode: string | null;
  errorMessage: string | null;
};

export type WebhookEvent = InboundMessageEvent | EchoMessageEvent | StatusEvent;

export type ParseResult = {
  events: WebhookEvent[];
  errors: string[];
  ignoredFields: string[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const MAX_BODY = 4096;
const STATUS_VALUES = new Set(["sent", "delivered", "read", "failed"]);

function parseTimestamp(v: unknown): Date | null {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!s || !/^\d{9,11}$/.test(s)) return null;
  const d = new Date(Number(s) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clip(s: string | null): string | null {
  return s == null ? null : s.slice(0, MAX_BODY);
}

/** Text shown in the inbox for each message type. */
function extractContent(m: Obj): { type: string; body: string | null; media: MediaRef | null } {
  const type = str(m.type) ?? "unknown";
  const part = isObj(m[type]) ? (m[type] as Obj) : {};
  switch (type) {
    case "text":
      return { type, body: clip(str(part.body)), media: null };
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const id = str(part.id);
      const media: MediaRef | null = id
        ? {
            id,
            mimeType: str(part.mime_type) ?? undefined,
            sha256: str(part.sha256) ?? undefined,
            filename: str(part.filename) ?? undefined,
            caption: str(part.caption) ?? undefined,
          }
        : null;
      return { type, body: clip(str(part.caption)), media };
    }
    case "location": {
      const lat = typeof part.latitude === "number" ? part.latitude : null;
      const lng = typeof part.longitude === "number" ? part.longitude : null;
      const label = [str(part.name), str(part.address)].filter(Boolean).join(" — ");
      const coords = lat != null && lng != null ? `${lat},${lng}` : "";
      return { type, body: clip([label, coords].filter(Boolean).join(" ") || null), media: null };
    }
    case "interactive": {
      const reply = isObj(part.button_reply) ? part.button_reply : isObj(part.list_reply) ? part.list_reply : null;
      return { type, body: clip(reply ? str((reply as Obj).title) : null), media: null };
    }
    case "button":
      return { type, body: clip(str(part.text)), media: null };
    case "reaction":
      return { type, body: clip(str(part.emoji)), media: null };
    case "contacts": {
      const names = arr(m.contacts)
        .map((c) => (isObj(c) && isObj(c.name) ? str((c.name as Obj).formatted_name) : null))
        .filter(Boolean);
      return { type, body: clip(names.join(", ") || null), media: null };
    }
    default:
      return { type, body: null, media: null };
  }
}

export function parseWebhookPayload(payload: unknown): ParseResult {
  const result: ParseResult = { events: [], errors: [], ignoredFields: [] };
  if (!isObj(payload) || payload.object !== "whatsapp_business_account") {
    result.errors.push("payload.not_whatsapp_business_account");
    return result;
  }

  arr(payload.entry).forEach((entry, ei) => {
    if (!isObj(entry)) return void result.errors.push(`entry[${ei}].invalid`);
    arr(entry.changes).forEach((change, ci) => {
      const where = `entry[${ei}].changes[${ci}]`;
      if (!isObj(change) || !isObj(change.value)) return void result.errors.push(`${where}.invalid`);
      const field = str(change.field);
      const value = change.value as Obj;
      const phoneNumberId = isObj(value.metadata) ? str((value.metadata as Obj).phone_number_id) : null;

      if (field !== "messages" && field !== "smb_message_echoes") {
        result.ignoredFields.push(field ?? "unknown");
        return;
      }
      if (!phoneNumberId) return void result.errors.push(`${where}.missing_phone_number_id`);

      // Profile names arrive in a parallel `contacts` array keyed by wa_id.
      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        if (isObj(c) && str(c.wa_id) && isObj(c.profile) && str((c.profile as Obj).name)) {
          names.set(c.wa_id as string, (c.profile as Obj).name as string);
        }
      }

      arr(value.messages).forEach((m, mi) => {
        const at = `${where}.messages[${mi}]`;
        if (!isObj(m)) return void result.errors.push(`${at}.invalid`);
        const id = str(m.id);
        const from = str(m.from);
        const sentAt = parseTimestamp(m.timestamp);
        if (!id || !from || !/^[1-9]\d{6,14}$/.test(from) || !sentAt) {
          return void result.errors.push(`${at}.missing_required_fields`);
        }
        const content = extractContent(m);
        result.events.push({
          kind: "message",
          eventKey: `msg:${id}`,
          phoneNumberId,
          waMessageId: id,
          fromWaId: from,
          profileName: names.get(from) ?? null,
          messageType: content.type,
          body: content.body,
          media: content.media,
          sentAt,
        });
      });

      arr(value.message_echoes).forEach((m, mi) => {
        const at = `${where}.message_echoes[${mi}]`;
        if (!isObj(m)) return void result.errors.push(`${at}.invalid`);
        const id = str(m.id);
        const to = str(m.to);
        const sentAt = parseTimestamp(m.timestamp);
        if (!id || !to || !/^[1-9]\d{6,14}$/.test(to) || !sentAt) {
          return void result.errors.push(`${at}.missing_required_fields`);
        }
        const content = extractContent(m);
        result.events.push({
          kind: "echo",
          eventKey: `echo:${id}`,
          phoneNumberId,
          waMessageId: id,
          toWaId: to,
          messageType: content.type,
          body: content.body,
          media: content.media,
          sentAt,
        });
      });

      arr(value.statuses).forEach((s, si) => {
        const at = `${where}.statuses[${si}]`;
        if (!isObj(s)) return void result.errors.push(`${at}.invalid`);
        const id = str(s.id);
        const status = str(s.status);
        const when = parseTimestamp(s.timestamp);
        if (!id || !status || !STATUS_VALUES.has(status) || !when) {
          return void result.errors.push(`${at}.missing_required_fields`);
        }
        const firstError = arr(s.errors).find(isObj) as Obj | undefined;
        result.events.push({
          kind: "status",
          eventKey: `status:${id}:${status}`,
          phoneNumberId,
          waMessageId: id,
          status: status as StatusEvent["status"],
          recipientWaId: str(s.recipient_id),
          at: when,
          errorCode: firstError && firstError.code != null ? String(firstError.code) : null,
          errorMessage: firstError ? (str(firstError.title) ?? str(firstError.message)) : null,
        });
      });
    });
  });

  return result;
}

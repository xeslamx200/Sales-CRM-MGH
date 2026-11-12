/**
 * Kapso send client (server-side only: text, and files sent by uploading them first). Kapso exposes the Meta Cloud API shape at
 * https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages with the project API key in `X-API-Key`.
 *
 * Kapso documents NO idempotency key, so a request whose outcome is unknown can never be repeated:
 *   - `definite` failure: Kapso answered with a client-side error (4xx) or a billing/rate-limit refusal. Nothing was sent;
 *     the message is marked failed and a person decides to resend.
 *   - `unconfirmed`: timeout, network error, 5xx, or a 2xx without a message id. The message may or may not have gone out; it stays
 *     queued (record_outbound_unconfirmed), is NEVER resent automatically, and the webhook (whatsapp.message.sent) can still confirm it.
 * The API key is passed in by the caller; this module never reads or logs secrets and never includes request data in results.
 */

export const KAPSO_SEND_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";

export type KapsoSendResult =
  | { ok: true; waMessageId: string }
  | { ok: false; kind: "definite" | "unconfirmed"; code: string; message: string; httpStatus: number | null };

export type KapsoSendOptions = {
  phoneNumberId: string;
  apiKey: string;
  /** Phone number (digits). Exactly one of toWaId / toBsuid: a customer known only by BSUID is addressed with `recipient`. */
  toWaId?: string | null;
  toBsuid?: string | null;
  body: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Codes Kapso / Meta documented for refusals that mean "not sent": shown to the user as the stored error_code. */
const MESSAGE_MAX = 300;

function parseError(json: unknown): { code: string | null; message: string | null } {
  if (typeof json !== "object" || json === null) return { code: null, message: null };
  const j = json as Record<string, unknown>;
  const e = j.error;
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;   // Meta shape: { error: { message, type, code, error_subcode } }
    return { code: o.code != null ? String(o.code) : null, message: typeof o.message === "string" ? o.message : null };
  }
  // Kapso platform shape: { error: "text", code: "insufficient_credits" | "thread_not_owner" | ... }
  return { code: typeof j.code === "string" ? j.code : null, message: typeof e === "string" ? e : null };
}

export function extractKapsoMessageId(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const messages = (json as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const id = (messages[0] as { id?: unknown })?.id;
  return typeof id === "string" && /^[A-Za-z0-9._=+/-]{1,200}$/.test(id) ? id : null;
}

export async function sendKapsoText(opts: KapsoSendOptions): Promise<KapsoSendResult> {
  const { phoneNumberId, apiKey, toWaId, toBsuid, body, timeoutMs = 15_000, fetchImpl = fetch } = opts;
  const refuse = (code: string, message: string): KapsoSendResult => ({ ok: false, kind: "definite", code, message, httpStatus: null });
  if (!/^[A-Za-z0-9]{5,30}$/.test(phoneNumberId)) return refuse("invalid_phone_number_id", "Invalid phone number id");
  // a phone number is always preferred; a BSUID is used only when there is no phone (never derived from it, never both)
  const byPhone = typeof toWaId === "string" && toWaId !== "";
  if (byPhone ? !/^[1-9]\d{6,14}$/.test(toWaId as string) : !(typeof toBsuid === "string" && /^[A-Za-z0-9._:-]{3,140}$/.test(toBsuid))) return refuse("invalid_recipient", "Invalid recipient");
  if (typeof apiKey !== "string" || apiKey.length < 20) return refuse("not_configured", "Kapso API key is not configured");
  if (typeof body !== "string" || body.trim() === "" || body.length > 4096) return refuse("invalid_body", "Invalid message body");
  return postKapsoMessage({
    phoneNumberId, apiKey, timeoutMs, fetchImpl,
    payload: { ...(byPhone ? { to: toWaId } : { recipient: toBsuid }), type: "text", text: { preview_url: false, body } },
  });
}

/** POST one message payload; classifies the outcome as sent / definite refusal / unconfirmed (see the header comment). */
async function postKapsoMessage(o: { phoneNumberId: string; apiKey: string; payload: Record<string, unknown>; timeoutMs: number; fetchImpl: typeof fetch }): Promise<KapsoSendResult> {
  const { phoneNumberId, apiKey, payload, timeoutMs, fetchImpl } = o;
  let res: Response;
  try {
    res = await fetchImpl(`${KAPSO_SEND_BASE}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, kind: "unconfirmed", code: name === "TimeoutError" ? "timeout" : "network_error", message: name, httpStatus: null };
  }

  let json: unknown = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }

  if (res.ok) {
    const id = extractKapsoMessageId(json);
    if (id) return { ok: true, waMessageId: id };
    return { ok: false, kind: "unconfirmed", code: "unexpected_response", message: "No message id in response", httpStatus: res.status };
  }
  const err = parseError(json);
  const code = (err.code ?? `http_${res.status}`).slice(0, 60);
  const message = (err.message ?? `HTTP ${res.status}`).slice(0, MESSAGE_MAX);
  // 5xx: the request may have been processed before the failure. Every 4xx (auth, billing 402, rate limit 429, in-flight 409,
  // thread_not_owner 409, outside the 24h window 422, project review 423, ...) is an explicit refusal: nothing was sent.
  return { ok: false, kind: res.status >= 500 ? "unconfirmed" : "definite", code, message, httpStatus: res.status };
}

export type KapsoUploadResult =
  | { ok: true; mediaId: string }
  | { ok: false; code: string; message: string; httpStatus: number | null };

/**
 * Step 1 of sending a file: upload it to Kapso's media store (multipart). An upload sends nothing to the customer, so EVERY failure here
 * (timeout included) is safe to report as "not sent" and to retry.
 */
export async function uploadKapsoMedia(opts: {
  phoneNumberId: string; apiKey: string; bytes: Uint8Array; mimeType: string; filename: string; timeoutMs?: number; fetchImpl?: typeof fetch;
}): Promise<KapsoUploadResult> {
  const { phoneNumberId, apiKey, bytes, mimeType, filename, timeoutMs = 60_000, fetchImpl = fetch } = opts;
  const refuse = (code: string, message: string): KapsoUploadResult => ({ ok: false, code, message, httpStatus: null });
  if (!/^[A-Za-z0-9]{5,30}$/.test(phoneNumberId)) return refuse("invalid_phone_number_id", "Invalid phone number id");
  if (typeof apiKey !== "string" || apiKey.length < 20) return refuse("not_configured", "Kapso API key is not configured");
  if (bytes.byteLength === 0) return refuse("invalid_media", "Empty file");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([bytes as BlobPart], { type: mimeType }), filename);
  let res: Response;
  try {
    res = await fetchImpl(`${KAPSO_SEND_BASE}/${phoneNumberId}/media`, { method: "POST", headers: { "X-API-Key": apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, code: name === "TimeoutError" ? "timeout" : "network_error", message: name, httpStatus: null };
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (res.ok) {
    const id = typeof json === "object" && json !== null ? (json as { id?: unknown }).id : null;
    if (typeof id === "string" && /^[A-Za-z0-9._=+-]{1,200}$/.test(id)) return { ok: true, mediaId: id };
    return { ok: false, code: "unexpected_response", message: "No media id in response", httpStatus: res.status };
  }
  const err = parseError(json);
  return { ok: false, code: (err.code ?? `http_${res.status}`).slice(0, 60), message: (err.message ?? `HTTP ${res.status}`).slice(0, MESSAGE_MAX), httpStatus: res.status };
}

export type KapsoMediaKind = "image" | "document" | "audio";

/** Step 2: send an uploaded file to a customer known by phone number. Same outcome rules as text (never resent when unconfirmed). */
export async function sendKapsoMedia(opts: {
  phoneNumberId: string; apiKey: string; /** exactly one of toWaId / toBsuid (a customer known only by BSUID is addressed with `recipient`) */ toWaId?: string | null; toBsuid?: string | null; kind: KapsoMediaKind; mediaId: string;
  caption?: string | null; filename?: string | null; /** audio only: show as a voice note (needs OGG/Opus) */ voice?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch;
}): Promise<KapsoSendResult> {
  const { phoneNumberId, apiKey, toWaId, toBsuid, kind, mediaId, caption, filename, voice, timeoutMs = 15_000, fetchImpl = fetch } = opts;
  const refuse = (code: string, message: string): KapsoSendResult => ({ ok: false, kind: "definite", code, message, httpStatus: null });
  if (!/^[A-Za-z0-9]{5,30}$/.test(phoneNumberId)) return refuse("invalid_phone_number_id", "Invalid phone number id");
  const byPhone = typeof toWaId === "string" && toWaId !== "";
  if (byPhone ? !/^[1-9]\d{6,14}$/.test(toWaId as string) : !(typeof toBsuid === "string" && /^[A-Za-z0-9._:-]{3,140}$/.test(toBsuid))) return refuse("invalid_recipient", "Invalid recipient");
  if (typeof apiKey !== "string" || apiKey.length < 20) return refuse("not_configured", "Kapso API key is not configured");
  if (!/^[A-Za-z0-9._=+-]{1,200}$/.test(mediaId)) return refuse("invalid_media", "Invalid media id");
  const media: Record<string, unknown> = { id: mediaId };
  if (kind !== "audio" && caption) media.caption = caption.slice(0, 1024);   // an audio message cannot carry a caption
  if (kind === "document" && filename) media.filename = filename.slice(0, 200);
  if (kind === "audio" && voice) media.voice = true;
  return postKapsoMessage({ phoneNumberId, apiKey, timeoutMs, fetchImpl, payload: { ...(byPhone ? { to: toWaId } : { recipient: toBsuid }), type: kind, [kind]: media } });
}

/**
 * KAPSO_SEND_ALLOWLIST: comma/space separated phone numbers (digits, optional +) allowed as recipients, or `*` for everyone.
 * Fail closed: empty or unreadable means nobody. The check runs BEFORE anything is queued.
 */
export function parseSendAllowlist(raw: string | undefined | null): { all: boolean; numbers: Set<string> } {
  const out = { all: false, numbers: new Set<string>() };
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    if (!part) continue;
    if (part === "*") { out.all = true; continue; }
    const d = part.replace(/[()+-]/g, "");
    if (/^[1-9]\d{6,14}$/.test(d)) out.numbers.add(d);
  }
  return out;
}
export function isRecipientAllowed(list: { all: boolean; numbers: Set<string> }, toWaId: string | null): boolean {
  if (!toWaId) return false;
  return list.all || list.numbers.has(toWaId);
}

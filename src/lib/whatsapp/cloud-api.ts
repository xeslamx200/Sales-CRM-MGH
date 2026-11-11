/**
 * Minimal WhatsApp Cloud API client (server-side only).
 * The access token is passed in by the caller from server environment
 * variables; this module never reads or logs secrets itself.
 */

export type SendResult =
  | { ok: true; waMessageId: string }
  | { ok: false; code: string; message: string; retryable: boolean; httpStatus: number | null };

export type SendTextOptions = {
  phoneNumberId: string;
  accessToken: string;
  toWaId: string;
  body: string;
  apiVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_GRAPH_API_VERSION = "v26.0";

/**
 * Error codes Meta documents as transient (rate limiting / temporary
 * failures). Everything else is treated as permanent so we never loop on,
 * for example, an expired token (190) or the 24h window rule (131047).
 */
const RETRYABLE_CODES = new Set(["1", "2", "4", "17", "32", "613", "80007", "130429", "131000", "131016", "131048", "131056"]);

export function isRetryable(httpStatus: number | null, code: string | null): boolean {
  if (code && RETRYABLE_CODES.has(code)) return true;
  if (httpStatus === 429) return true;
  if (httpStatus != null && httpStatus >= 500) return true;
  return httpStatus == null; // network error / timeout
}

export async function sendTextMessage(opts: SendTextOptions): Promise<SendResult> {
  const {
    phoneNumberId, accessToken, toWaId, body,
    apiVersion = DEFAULT_GRAPH_API_VERSION, timeoutMs = 15_000, fetchImpl = fetch,
  } = opts;

  if (!/^\d{5,30}$/.test(phoneNumberId)) {
    return { ok: false, code: "invalid_phone_number_id", message: "Invalid phone number id", retryable: false, httpStatus: null };
  }
  if (!/^[1-9]\d{6,14}$/.test(toWaId)) {
    return { ok: false, code: "invalid_recipient", message: "Invalid recipient", retryable: false, httpStatus: null };
  }
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    return { ok: false, code: "invalid_api_version", message: "Invalid API version", retryable: false, httpStatus: null };
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: toWaId,
        type: "text",
        text: { preview_url: false, body },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, code: name === "TimeoutError" ? "timeout" : "network_error", message: name, retryable: true, httpStatus: null };
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }

  if (res.ok) {
    const id = extractMessageId(json);
    if (id) return { ok: true, waMessageId: id };
    return { ok: false, code: "unexpected_response", message: "No message id in response", retryable: false, httpStatus: res.status };
  }

  const err = extractError(json);
  return {
    ok: false,
    code: err.code ?? `http_${res.status}`,
    // Meta error titles are safe to store; never include request data.
    message: (err.message ?? `HTTP ${res.status}`).slice(0, 500),
    retryable: isRetryable(res.status, err.code),
    httpStatus: res.status,
  };
}

export function extractMessageId(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const messages = (json as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const id = (messages[0] as { id?: unknown })?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function extractError(json: unknown): { code: string | null; message: string | null } {
  const e = typeof json === "object" && json !== null ? (json as { error?: Record<string, unknown> }).error : undefined;
  if (!e) return { code: null, message: null };
  const code = e.code != null ? String(e.code) : null;
  const data = e.error_data as { details?: unknown } | undefined;
  const message =
    (typeof e.message === "string" && e.message) ||
    (typeof data?.details === "string" && data.details) ||
    null;
  return { code, message };
}

/** Exponential backoff with jitter for retryable sends: 1s, 2s, 4s… capped. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000, rand: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

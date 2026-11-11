/**
 * WhatsApp Cloud API: media, templates and number health (server-side only).
 * Same conventions as cloud-api.ts: inputs validated before any request,
 * the token only ever in the Authorization header, failures returned as
 * stable codes (never thrown, never logged with secrets). Pure and
 * framework-free; `fetchImpl` is injectable for tests.
 */
import {
  DEFAULT_GRAPH_API_VERSION, extractError, extractMessageId, isRetryable, type SendResult,
} from "./cloud-api.ts";

export type GraphOptions = { accessToken: string; apiVersion?: string; timeoutMs?: number; fetchImpl?: typeof fetch };
export type GraphError = { ok: false; code: string; message: string; retryable: boolean; httpStatus: number | null };

const ID = /^\d{5,30}$/;
const WA_ID = /^[1-9]\d{6,14}$/;
const fail = (code: string, message: string): GraphError => ({ ok: false, code, message, retryable: false, httpStatus: null });

/**
 * Errors meaning the credentials themselves are unusable (expired, revoked or
 * invalid token, missing permission). These alert administrators.
 * 190 OAuthException, 102 session, 10 / 200 / 299 permission, HTTP 401.
 */
export function isCredentialError(code: string | null | undefined, httpStatus: number | null | undefined): boolean {
  return httpStatus === 401 || (code != null && ["190", "102", "10", "200", "299"].includes(code));
}

async function graph(
  path: string,
  init: { method?: string; body?: BodyInit; json?: unknown },
  opts: GraphOptions,
): Promise<{ ok: true; json: unknown; status: number } | GraphError> {
  const { accessToken, apiVersion = DEFAULT_GRAPH_API_VERSION, timeoutMs = 20_000, fetchImpl = fetch } = opts;
  if (!/^v\d+\.\d+$/.test(apiVersion)) return fail("invalid_api_version", "Invalid API version");
  let res: Response;
  try {
    res = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${accessToken}`, ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
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
  if (res.ok) return { ok: true, json, status: res.status };
  const e = extractError(json);
  return {
    ok: false, code: e.code ?? `http_${res.status}`, message: (e.message ?? `HTTP ${res.status}`).slice(0, 500),
    retryable: isRetryable(res.status, e.code), httpStatus: res.status,
  };
}

const MB = 1024 * 1024;
/** Outbound media accepted from the CRM, within WhatsApp's limits (documents capped at 25 MB). */
export const OUTBOUND_MEDIA: Record<string, { kind: "image" | "document"; maxBytes: number }> = {
  "image/jpeg": { kind: "image", maxBytes: 5 * MB },
  "image/png": { kind: "image", maxBytes: 5 * MB },
  "application/pdf": { kind: "document", maxBytes: 25 * MB },
  "text/plain": { kind: "document", maxBytes: 25 * MB },
  "application/msword": { kind: "document", maxBytes: 25 * MB },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { kind: "document", maxBytes: 25 * MB },
  "application/vnd.ms-excel": { kind: "document", maxBytes: 25 * MB },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { kind: "document", maxBytes: 25 * MB },
  "application/vnd.ms-powerpoint": { kind: "document", maxBytes: 25 * MB },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { kind: "document", maxBytes: 25 * MB },
};

/** Inbound media we cache and serve (WhatsApp's supported types). */
export const INBOUND_MEDIA_TYPES = new Set([
  ...Object.keys(OUTBOUND_MEDIA), "image/webp", "audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg",
  "video/mp4", "video/3gpp",
]);
export const INBOUND_MEDIA_MAX_BYTES = 100 * MB;

/** Types safe to show inline in the browser; everything else is downloaded. */
export function isInlinePreview(mimeType: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "audio/aac", "audio/mpeg", "audio/mp4", "audio/ogg", "video/mp4"].includes(mimeType);
}

/** Safe file name for storage keys and Content-Disposition. */
export function safeFileName(name: string): string {
  const base = name.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(-120);
  return base && base !== "." && base !== ".." ? base : "file";
}

export async function uploadMedia(
  opts: GraphOptions & { phoneNumberId: string; bytes: Uint8Array; mimeType: string; filename: string },
): Promise<{ ok: true; mediaId: string } | GraphError> {
  if (!ID.test(opts.phoneNumberId)) return fail("invalid_phone_number_id", "Invalid phone number id");
  if (!OUTBOUND_MEDIA[opts.mimeType]) return fail("unsupported_media_type", "Unsupported type");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", opts.mimeType);
  form.append("file", new Blob([opts.bytes as BlobPart], { type: opts.mimeType }), safeFileName(opts.filename));
  const r = await graph(`${opts.phoneNumberId}/media`, { method: "POST", body: form }, opts);
  if (!r.ok) return r;
  const id = (r.json as { id?: unknown })?.id;
  return typeof id === "string" ? { ok: true, mediaId: id } : { ...fail("unexpected_response", "No media id"), httpStatus: r.status };
}

async function sendPayload(phoneNumberId: string, payload: Record<string, unknown>, opts: GraphOptions): Promise<SendResult> {
  if (!ID.test(phoneNumberId)) return fail("invalid_phone_number_id", "Invalid phone number id");
  const r = await graph(`${phoneNumberId}/messages`, {
    method: "POST", json: { messaging_product: "whatsapp", recipient_type: "individual", ...payload },
  }, opts);
  if (!r.ok) return r;
  const id = extractMessageId(r.json);
  return id ? { ok: true, waMessageId: id } : { ...fail("unexpected_response", "No message id in response"), httpStatus: r.status };
}

export function sendMediaMessage(
  opts: GraphOptions & { phoneNumberId: string; toWaId: string; kind: "image" | "document"; mediaId: string; caption?: string | null; filename?: string },
): Promise<SendResult> {
  if (!WA_ID.test(opts.toWaId)) return Promise.resolve(fail("invalid_recipient", "Invalid recipient"));
  const media: Record<string, string> = { id: opts.mediaId };
  if (opts.caption) media.caption = opts.caption.slice(0, 1024);
  if (opts.kind === "document" && opts.filename) media.filename = safeFileName(opts.filename);
  return sendPayload(opts.phoneNumberId, { to: opts.toWaId, type: opts.kind, [opts.kind]: media }, opts);
}

export function sendTemplateMessage(
  opts: GraphOptions & { phoneNumberId: string; toWaId: string; name: string; language: string; params: string[] },
): Promise<SendResult> {
  if (!WA_ID.test(opts.toWaId)) return Promise.resolve(fail("invalid_recipient", "Invalid recipient"));
  if (!/^[a-z0-9_]{1,512}$/.test(opts.name) || !/^[a-zA-Z_]{2,15}$/.test(opts.language)) {
    return Promise.resolve(fail("invalid_template", "Invalid template"));
  }
  const template: Record<string, unknown> = { name: opts.name, language: { code: opts.language } };
  if (opts.params.length) template.components = [{ type: "body", parameters: opts.params.map((text) => ({ type: "text", text })) }];
  return sendPayload(opts.phoneNumberId, { to: opts.toWaId, type: "template", template }, opts);
}

/** Inbound media, step 1: a download URL valid for 5 minutes. */
export async function getMediaUrl(
  opts: GraphOptions & { mediaId: string },
): Promise<{ ok: true; url: string; mimeType: string; size: number | null } | GraphError> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(opts.mediaId)) return fail("invalid_media_id", "Invalid media id");
  const r = await graph(encodeURIComponent(opts.mediaId), {}, opts);
  if (!r.ok) return r;
  const j = r.json as { url?: unknown; mime_type?: unknown; file_size?: unknown };
  if (typeof j?.url !== "string" || !j.url.startsWith("https://")) return { ...fail("unexpected_response", "No media URL"), httpStatus: r.status };
  return {
    ok: true, url: j.url, mimeType: typeof j.mime_type === "string" ? j.mime_type : "application/octet-stream",
    size: typeof j.file_size === "number" ? j.file_size : null,
  };
}

/** Meta's media CDN hosts — the token is never sent anywhere else. */
export function isTrustedMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Inbound media, step 2: download the bytes (token required), bounded in size. */
export async function downloadMedia(
  opts: { url: string; accessToken: string; maxBytes: number; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<{ ok: true; bytes: Uint8Array; mimeType: string } | GraphError> {
  const { fetchImpl = fetch } = opts;
  if (!isTrustedMediaUrl(opts.url)) return fail("untrusted_media_host", "Unexpected media host");
  let res: Response;
  try {
    res = await fetchImpl(opts.url, { headers: { Authorization: `Bearer ${opts.accessToken}` }, signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000) });
  } catch (err) {
    return { ok: false, code: "network_error", message: err instanceof Error ? err.name : "Error", retryable: true, httpStatus: null };
  }
  if (!res.ok) return { ok: false, code: `http_${res.status}`, message: `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 404, httpStatus: res.status };
  if (Number(res.headers.get("content-length") ?? "0") > opts.maxBytes) return { ...fail("media_too_large", "Too large"), httpStatus: res.status };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > opts.maxBytes) return { ...fail("media_too_large", "Too large"), httpStatus: res.status };
  return { ok: true, bytes, mimeType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim() };
}

export type TemplateInfo = {
  name: string; language: string; status: string; category: string; body_text: string; param_count: number; components: unknown[];
};

/** BODY text of a template and its number of {{n}} parameters. */
export function templateBody(components: unknown[]): { body_text: string; param_count: number } {
  const body = (components as { type?: string; text?: string }[]).find((c) => c?.type === "BODY");
  const text = typeof body?.text === "string" ? body.text : "";
  const nums = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return { body_text: text.slice(0, 2048), param_count: nums.length ? Math.max(...nums) : 0 };
}

export async function fetchTemplates(opts: GraphOptions & { wabaId: string }): Promise<{ ok: true; templates: TemplateInfo[] } | GraphError> {
  if (!ID.test(opts.wabaId)) return fail("invalid_waba_id", "Invalid WABA id");
  const templates: TemplateInfo[] = [];
  let path = `${opts.wabaId}/message_templates?fields=name,language,status,category,components&limit=100`;
  for (let page = 0; page < 20 && path; page++) {
    const r = await graph(path, {}, opts);
    if (!r.ok) return r;
    const j = r.json as {
      data?: { name?: string; language?: string; status?: string; category?: string; components?: unknown[] }[];
      paging?: { next?: string };
    };
    for (const t of j.data ?? []) {
      if (!t.name || !t.language || !t.status) continue;
      templates.push({
        name: t.name, language: t.language, status: t.status, category: t.category ?? "UTILITY",
        components: t.components ?? [], ...templateBody(t.components ?? []),
      });
    }
    const next = j.paging?.next ?? "";
    // Follow Meta's own paging links only.
    path = /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\//.test(next) ? next.replace(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\//, "") : "";
  }
  return { ok: true, templates };
}

/** Cheap call that proves the token can access this number. */
export async function checkPhoneNumber(
  opts: GraphOptions & { phoneNumberId: string },
): Promise<{ ok: true; displayPhoneNumber: string | null } | GraphError> {
  if (!ID.test(opts.phoneNumberId)) return fail("invalid_phone_number_id", "Invalid phone number id");
  const r = await graph(`${opts.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, {}, opts);
  if (!r.ok) return r;
  const d = (r.json as { display_phone_number?: unknown })?.display_phone_number;
  return { ok: true, displayPhoneNumber: typeof d === "string" ? d : null };
}

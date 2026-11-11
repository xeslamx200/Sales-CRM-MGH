/**
 * Kapso media (protocol v2): what a webhook says about a file, and how to fetch it safely. Pure functions, no I/O except the injected fetch.
 *
 * Inbound shape (docs: webhooks/message-events; verified against the Platform API on the real number):
 *   message.type = image | video | audio | document | sticker
 *   message.<type> = { id, mime_type, sha256, caption?, filename?, animated?, voice?, link?, url? }
 *   message.kapso.media_data = { url, filename, content_type, byte_size }       (url: a signed Kapso link, fetchable without a key)
 *   message.kapso.transcript = { text }                                           (audio only)
 * The auto-generated `kapso.content` ("Image attached (photo.jpg) [Size…] URL: https://…") is NEVER shown: for media only the caption is text.
 *
 * Download (documented Meta-proxy path): GET {base}/{media_id}?phone_number_id=… with X-API-Key -> { download_url, mime_type, file_size };
 * GET download_url -> bytes. Fallback: the signed `media_data.url`. Only https hosts under kapso.ai are ever requested (no SSRF through a payload).
 */
import { isObj, str, type Obj } from "./parser.ts";

export const KAPSO_META_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";
export const MEDIA_KINDS = ["image", "video", "audio", "document", "sticker"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** What is stored in messages.media for a Kapso file (snake_case: it is JSON in the database; the browser never receives id or url). */
export type KapsoMediaRef = {
  provider: "kapso";
  kind: MediaKind;
  id: string;
  url: string | null;
  mime_type: string | null;
  filename: string | null;
  size: number | null;
  animated?: true;
  voice?: true;
  transcript?: string;
};

const MEDIA_ID = /^[A-Za-z0-9._-]{1,200}$/;
const MIME = /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,80}$/;

/** https and a host under kapso.ai (api.kapso.ai, app.kapso.ai). Anything else is dropped. */
export function isKapsoHost(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "kapso.ai" || u.hostname.endsWith(".kapso.ai")) && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 2 ** 40 ? Math.floor(v) : null);

/** The file reference of a media message, or null (not a media type, or no usable id: such a message keeps its old text behaviour). */
export function extractKapsoMedia(m: Obj): KapsoMediaRef | null {
  const type = str(m.type);
  if (!type || !(MEDIA_KINDS as readonly string[]).includes(type)) return null;
  const part = isObj(m[type]) ? (m[type] as Obj) : {};
  const kapso = isObj(m.kapso) ? (m.kapso as Obj) : {};
  const data = isObj(kapso.media_data) ? (kapso.media_data as Obj) : {};
  const id = str(part.id);
  if (!id || !MEDIA_ID.test(id)) return null;
  const rawUrl = str(data.url) ?? str(kapso.media_url) ?? str(part.url) ?? str(part.link);
  const mime = str(data.content_type) ?? str(part.mime_type);
  const filename = str(data.filename) ?? str(part.filename);
  const transcript = isObj(kapso.transcript) ? str((kapso.transcript as Obj).text) : null;
  const ref: KapsoMediaRef = {
    provider: "kapso", kind: type as MediaKind, id,
    url: isKapsoHost(rawUrl) ? rawUrl : null,
    mime_type: mime && MIME.test(mime.split(";")[0].trim().toLowerCase()) ? mime.split(";")[0].trim().toLowerCase() : null,
    filename: filename ? filename.normalize("NFKC").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) : null,
    size: num(data.byte_size),
  };
  if (part.animated === true) ref.animated = true;
  if (part.voice === true) ref.voice = true;
  if (transcript) ref.transcript = transcript.slice(0, 4000);
  return ref;
}

/** Caption of a media message (the only text it has). */
export function mediaCaption(m: Obj): string | null {
  const type = str(m.type);
  const part = type && isObj(m[type]) ? (m[type] as Obj) : {};
  return str(part.caption);
}

/**
 * Messages stored before media support carry Kapso's auto description as text ("Sticker attached (x.webp) 221 KB · WEBP",
 * "[Audio attached] (voice.ogg) …"). When the file itself is shown, that line is noise (and may contain a link): hide it.
 */
export function isAutoMediaDescription(body: string | null | undefined): boolean {
  if (!body) return false;
  return /^\s*\[?(image|video|audio|voice|document|sticker|file)s?( message)? attached\]?/i.test(body)
    || /^\s*\[(image|video|audio|voice|document|sticker|media_placeholder)\]\s*$/i.test(body);
}

export type KapsoFetched =
  | { ok: true; bytes: Uint8Array; mimeType: string }
  | { ok: false; code: "not_configured" | "not_found" | "too_large" | "unavailable" | "untrusted_host" };

type FetchOpts = {
  apiKey: string; phoneNumberId: string; mediaId: string; url?: string | null;
  maxBytes: number; timeoutMs?: number; fetchImpl?: typeof fetch;
};

async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array | "too_large"> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); return "too_large"; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/**
 * Get the bytes of a Kapso media file. Never throws. The API key only ever goes to api.kapso.ai (documented endpoint); the signed fallback URL is
 * requested WITHOUT the key. Every URL is checked against the kapso.ai host rule first.
 */
export async function fetchKapsoMedia(o: FetchOpts): Promise<KapsoFetched> {
  const f = o.fetchImpl ?? fetch;
  const timeout = () => AbortSignal.timeout(o.timeoutMs ?? 20_000);
  const get = async (url: string, headers?: Record<string, string>) => {
    if (!isKapsoHost(url)) return "untrusted" as const;
    try { return await f(url, { headers, signal: timeout(), redirect: "follow" }); } catch { return null; }
  };
  const finish = async (res: Response, fallbackMime: string | null): Promise<KapsoFetched> => {
    const bytes = await readBounded(res, o.maxBytes).catch(() => null);
    if (bytes === "too_large") return { ok: false, code: "too_large" };
    if (!bytes || bytes.byteLength === 0) return { ok: false, code: "unavailable" };
    const mime = (res.headers.get("content-type") ?? fallbackMime ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
    return { ok: true, bytes, mimeType: MIME.test(mime) ? mime : "application/octet-stream" };
  };

  // 1. documented path: media info (with the key) -> authenticated Kapso download URL
  if (o.apiKey && o.apiKey.length >= 20 && /^[A-Za-z0-9]{5,30}$/.test(o.phoneNumberId) && MEDIA_ID.test(o.mediaId)) {
    const info = await get(`${KAPSO_META_BASE}/${encodeURIComponent(o.mediaId)}?phone_number_id=${encodeURIComponent(o.phoneNumberId)}`, { "X-API-Key": o.apiKey });
    if (info && info !== "untrusted" && info.ok) {
      const j = (await info.json().catch(() => null)) as { download_url?: unknown; mime_type?: unknown } | null;
      const dl = typeof j?.download_url === "string" ? j.download_url : null;
      if (dl) {
        const file = await get(dl);
        if (file && file !== "untrusted" && file.ok) return finish(file, typeof j?.mime_type === "string" ? j.mime_type : null);
      }
    }
  }
  // 2. fallback: the signed link from the webhook (no key sent)
  if (o.url) {
    const file = await get(o.url);
    if (file === "untrusted") return { ok: false, code: "untrusted_host" };
    if (file && file.ok) return finish(file, null);
    if (file && file.status === 404) return { ok: false, code: "not_found" };
  }
  return { ok: false, code: o.apiKey ? "unavailable" : "not_configured" };
}

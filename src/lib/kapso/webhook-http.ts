/**
 * HTTP layer of POST /api/webhooks/kapso, free of Next.js and Supabase imports so every answer can be unit-tested
 * (src/app/api/webhooks/kapso/route.ts only wires the real configuration and stores into it).
 *
 * Before anything is authenticated nothing is stored or revealed:
 *   405 other method | 503 not configured (secret missing, KAPSO_PROTOCOL invalid) | 415 a declared non-JSON content type |
 *   413 body above MAX_BODY_BYTES (declared length checked first, then the real cap WHILE streaming) | 401 bad/missing signature.
 * After the signature, the protocol handler decides (200 = every item has a durable state, 503 = something could not be recorded).
 * The response body is only `{ ok }`; no database detail, code or id is ever returned.
 */
import { handleKapsoPost, type KapsoStore } from "./processor.ts";
import type { KapsoProtocol } from "./protocol.ts";
import { readBodyLimited } from "./signature.ts";
import { handleKapsoPostV2, type KapsoStoreV2, type LogSink } from "./v2.ts";

/** Hard cap on the request body (a batch of 100 text messages is far below it). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type KapsoWebhookDeps = {
  /** Throws when the configuration is missing or invalid (EnvError names variables only). */
  config: () => { secret: string; protocol: KapsoProtocol };
  storeV1: () => KapsoStore;
  storeV2: () => KapsoStoreV2;
  log: LogSink;
  /** Best-effort follow-up for a processed message that has a file (the route schedules the download after the response). */
  onMedia?: (waMessageId: string) => void;
};
export type KapsoHttpRequest = { method: string; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null };
export type KapsoHttpResponse = { status: number; body: { ok: boolean } | string };

/** application/json, with or without parameters (charset). A missing header is accepted: the signature still has to match. */
export function isJsonContentType(v: string | null): boolean {
  if (v === null) return true;
  return v.split(";")[0].trim().toLowerCase() === "application/json";
}

export async function handleKapsoWebhookHttp(req: KapsoHttpRequest, deps: KapsoWebhookDeps): Promise<KapsoHttpResponse> {
  if (req.method !== "POST") return { status: 405, body: "method not allowed" };
  let cfg: { secret: string; protocol: KapsoProtocol };
  try {
    cfg = deps.config();
  } catch {
    return { status: 503, body: "not configured" };
  }
  if (!isJsonContentType(req.headers.get("content-type"))) return { status: 415, body: "unsupported media type" };

  // Cheap rejection first when the sender declares a size, then the real cap while streaming.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { status: 413, body: "payload too large" };
  const raw = await readBodyLimited(req.body, MAX_BODY_BYTES);
  if (raw === "too_large") return { status: 413, body: "payload too large" };

  const r = {
    rawBody: raw,
    signature: req.headers.get("x-webhook-signature"),
    eventName: req.headers.get("x-webhook-event"),
    payloadVersion: req.headers.get("x-webhook-payload-version"),
  };
  if (cfg.protocol === "v2") {
    // Structured, content-free line: counters, stable codes and origin names only (see safeDeliveryLog).
    const o = await handleKapsoPostV2(r, cfg.secret, deps.storeV2(), {
      onMedia: deps.onMedia,
      log: (line) => { if (line.http !== 200 || line.failed || line.quarantined || (line.parseErrors as unknown[]).length) deps.log(line); },
    });
    return { status: o.httpStatus, body: { ok: o.httpStatus === 200 } };
  }
  const o = await handleKapsoPost(r, cfg.secret, deps.storeV1());
  if (o.httpStatus !== 200 || o.failed > 0 || o.quarantined > 0 || o.parseErrors.length > 0) {
    // Counts and stable codes only: never message content.
    deps.log({
      event: "kapso.webhook", protocol: "v1", http: o.httpStatus, processed: o.processed, duplicates: o.duplicates, failed: o.failed,
      ignored: o.ignored, quarantined: o.quarantined, parseErrors: o.parseErrors.slice(0, 5),
    });
  }
  return { status: o.httpStatus, body: { ok: o.httpStatus === 200 } };
}

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Kapso's `X-Webhook-Signature` header: the lowercase/uppercase hex
 * HMAC-SHA256 of the exact raw request body, keyed with the webhook secret
 * (no `sha256=` prefix and no timestamp, unlike Meta's header).
 *
 * `secret` may list several secrets separated by commas (one per Kapso webhook); the signature must match one of them.
 *
 * Must be computed over the raw bytes as received — never over re-serialized
 * JSON — and compared in constant time (the length is checked first because
 * timingSafeEqual throws on unequal lengths).
 */
export function verifyKapsoSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false;
  const given = signatureHeader.trim();
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;

  const received = Buffer.from(given, "hex");
  // Kapso gives every webhook its own signing secret: KAPSO_WEBHOOK_SECRET may hold several, separated by commas (one per webhook).
  // Every secret is tried (no early exit on the first match or mismatch of a prefix), each comparison in constant time.
  let ok = false;
  for (const one of secret.split(",")) {
    const key = one.trim();
    if (!key) continue;
    const expected = createHmac("sha256", key).update(rawBody).digest();
    if (received.length === expected.length && timingSafeEqual(received, expected)) ok = true;
  }
  return ok;
}

/**
 * Read a request body into bytes without ever holding more than `maxBytes`.
 * Returns "too_large" as soon as the limit is crossed, so an oversized or
 * endless body is cut off instead of being buffered.
 */
export async function readBodyLimited(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | "too_large"> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

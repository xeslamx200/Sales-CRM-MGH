import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Meta's `X-Hub-Signature-256` header: "sha256=" + hex HMAC-SHA256 of
 * the exact raw request body, keyed with the Meta App Secret.
 *
 * Must be computed over the raw bytes as received — never over re-serialized
 * JSON — and compared in constant time.
 */
export function verifyMetaSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!appSecret || !signatureHeader) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** For the GET verification handshake (hub.mode / hub.verify_token / hub.challenge). */
export function verifySubscriptionChallenge(
  params: URLSearchParams,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (!verifyToken || mode !== "subscribe" || !token || challenge == null) return { ok: false };

  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  // Echo back only a safe, bounded challenge value.
  if (!/^[\w.-]{1,256}$/.test(challenge)) return { ok: false };
  return { ok: true, challenge };
}

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `Authorization: Bearer <secret>` check, constant time. Both sides are reduced to an HMAC of the same length first, so neither the
 * length of the header nor the position of the first differing byte is observable. No secret (or a too-short one) authorizes nothing.
 */
export function isBearerAuthorized(header: string | null, secret: string | null | undefined): boolean {
  if (!secret || secret.length < 16 || !header) return false;
  const key = "cron-auth";
  const a = createHmac("sha256", key).update(header).digest();
  const b = createHmac("sha256", key).update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

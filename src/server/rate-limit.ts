import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { createAdminClient } from "@/server/supabase/admin";
import type { ServerClient } from "@/server/supabase/server";
import { AppError } from "@/server/action";

/** Limits per action: [max calls, window in seconds]. */
export const LIMITS = {
  sign_in: [10, 600],          // per IP + e-mail
  sign_in_ip: [50, 600],       // per IP, any e-mail
  password_reset: [3, 3600],   // per IP + e-mail
  password_reset_ip: [10, 3600],
  send_message: [30, 60],      // per user
  import_preview: [30, 3600],  // per user
  import_commit: [10, 3600],   // per user
  export: [20, 3600],          // per user
  media_view: [300, 3600],     // per user
  attachment: [60, 3600],      // per user (upload + download links)
  search: [120, 60],           // per user (customer search while typing)
  payment: [60, 3600],         // per user (recording payments)
} as const satisfies Record<string, readonly [number, number]>;
export type LimitedAction = keyof typeof LIMITS;

/** Client IP as seen by the platform (Vercel sets x-forwarded-for). */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim();
}

/** Opaque key: we never store raw e-mails or IP addresses. */
export function hashKey(...parts: string[]): string {
  return "h_" + createHash("sha256").update(parts.join("|").toLowerCase()).digest("hex").slice(0, 40);
}

async function hit(call: PromiseLike<{ data: boolean | null; error: unknown }>): Promise<boolean> {
  const { data, error } = await call;
  if (error) {
    // Fail open: a broken limiter must not lock everyone out. Supabase Auth
    // keeps its own sign-in limits regardless.
    console.warn("[rate-limit] check failed", { code: (error as { code?: string }).code });
    return true;
  }
  return data !== false;
}

/** Signed-in action: counts against the caller's own bucket (DB enforces). */
export async function limitUser(supabase: ServerClient, action: LimitedAction): Promise<void> {
  const [max, windowSec] = LIMITS[action];
  const ok = await hit(supabase.rpc("rate_limit_hit", { p_action: action, p_key: "", p_limit: max, p_window_seconds: windowSec }));
  if (!ok) throw new AppError("rate_limited");
}

/** Unauthenticated action (sign-in, reset): keyed bucket via the service role. */
export async function limitAnonymous(action: LimitedAction, key: string): Promise<void> {
  const [max, windowSec] = LIMITS[action];
  const ok = await hit(createAdminClient().rpc("rate_limit_hit", { p_action: action, p_key: key, p_limit: max, p_window_seconds: windowSec }));
  if (!ok) throw new AppError("rate_limited");
}

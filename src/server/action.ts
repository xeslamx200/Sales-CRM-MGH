import "server-only";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { errorKey, userMessage } from "@/lib/errors.ts";
import { requestLocale } from "@/server/i18n";
import type { ActionResult } from "@/types/action";

export type { ActionResult };

/** Error carrying a stable key from src/lib/errors.ts. */
export class AppError extends Error {
  constructor(key: string) {
    super(key);
    this.name = "AppError";
  }
}

/**
 * Normalize PostgREST errors that don't carry a rule key:
 *  - PGRST116 on `.single()`: no row matched, i.e. RLS hid it or it doesn't
 *    exist. Reported as forbidden (we never reveal which).
 *  - 23505 unique violation: the record already exists.
 */
function normalize(error: unknown): unknown {
  const code = (error as { code?: unknown })?.code;
  if (code === "PGRST116") return new AppError("auth.forbidden");
  // a unique violation raised by one of OUR rules carries its own key (e.g. booking.duplicate); a bare one is the generic "already exists"
  const message = (error as { message?: unknown })?.message;
  if (code === "23505" && !(typeof message === "string" && /^[a-z_]+(\.[a-z_]+){1,3}$/.test(message))) return new AppError("duplicate");
  return error;
}

/** Unwrap a Supabase response, throwing its error (mapped to a key later). */
export function must<T>(res: { data: T; error: unknown }): NonNullable<T> {
  if (res.error) throw normalize(res.error);
  if (res.data == null) throw new AppError("generic");
  return res.data as NonNullable<T>;
}

/** Like must() but allows null data (e.g. RPCs returning void). */
export function check<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw normalize(res.error);
  return res.data;
}

/**
 * Validate `input` with `schema`, run `fn`, and convert any failure into a
 * localized ActionResult. redirect()/notFound() thrown by `fn` propagate.
 */
export async function runAction<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  fn: (data: z.infer<S>) => Promise<T>,
): Promise<ActionResult<T>> {
  const locale = await requestLocale();
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.join(".") || "_";
      if (!fieldErrors[k]) fieldErrors[k] = issue.message;
    }
    return { ok: false, error: userMessage("validation", locale), errorKey: "validation", fieldErrors };
  }
  try {
    return { ok: true, data: await fn(parsed.data) };
  } catch (err) {
    unstable_rethrow(err); // let redirect()/notFound() propagate
    const key = errorKey(err);
    if (key === "generic") logUnexpected(err);
    return { ok: false, error: userMessage(key, locale), errorKey: key };
  }
}

/** Log unexpected errors server-side without request data. */
function logUnexpected(err: unknown) {
  const e = err as { code?: unknown; name?: unknown };
  console.error("[action] unexpected error", { name: e?.name, code: e?.code });
}

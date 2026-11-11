/** What every server action returns to the client. Messages are localized. */
export type ActionResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorKey: string; fieldErrors?: Record<string, string> };

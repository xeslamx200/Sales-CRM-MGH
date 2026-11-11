/** Presentation helpers for the scheduled-job screens/routes, kept free of framework imports so they can be unit-tested. */
export type JobStatusRow = { last_error: string | null; last_details: unknown };

/** What the admin system page shows in the "result" cell: the stable error code, else the stored details as JSON (new keys appear as they are). */
export function formatJobDetails(j: JobStatusRow): string {
  return j.last_error ?? JSON.stringify(j.last_details ?? {});
}

/** Body of GET /api/cron/whatsapp-retry: `ok` plus whatever counters the SQL job returned (processed, failed, ignored, unconfirmed_expired, ...). */
export function cronRetryBody(data: unknown): Record<string, unknown> {
  const d = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return { ok: !d.error, ...d };
}

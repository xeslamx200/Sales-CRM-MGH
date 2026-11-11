import { cronRetryBody } from "./job-status.ts";

/**
 * GET /api/cron/whatsapp-retry, free of framework imports so every answer is unit-tested.
 * The job itself is SQL (run_scheduled_job('webhook_retries') -> process_webhook_retries): bounded per run (limit 100, max 8 attempts),
 * FOR UPDATE SKIP LOCKED (two concurrent runs never take the same event), one transaction per run, no outbound sending of any kind.
 *   401  not authorized: the job is never started
 *   200  the job ran: { ok: true, processed, failed, ignored, ... }
 *   500  the job reported its own failure (stable code only) or the RPC answered an error: { ok: false[, error: <code>] }
 *   503  the database could not be reached: { ok: false }
 */
export type RpcResult = { data: unknown; error: unknown };

export async function runCronRetry(authorized: boolean, runJob: () => PromiseLike<RpcResult>): Promise<{ status: number; body: unknown }> {
  if (!authorized) return { status: 401, body: "unauthorized" };
  let r: RpcResult;
  try {
    r = await runJob();
  } catch {
    return { status: 503, body: { ok: false } };
  }
  if (r.error) return { status: 500, body: { ok: false } };
  const body = cronRetryBody(r.data);
  return { status: body.ok ? 200 : 500, body };
}

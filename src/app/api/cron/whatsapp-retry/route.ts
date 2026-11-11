import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/server/supabase/admin";
import { isAuthorizedCron } from "@/server/cron";
import { runCronRetry } from "@/lib/cron-retry.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual / backup trigger. The job normally runs inside the database every
 * 5 minutes (pg_cron, migration 0870); this route runs the same SQL job on
 * demand, authenticated with CRON_SECRET. Safe to call repeatedly (see
 * src/lib/cron-retry.ts for the answers).
 */
export async function GET(request: NextRequest) {
  const r = await runCronRetry(isAuthorizedCron(request), () => createAdminClient().rpc("run_scheduled_job", { p_job: "webhook_retries" }));
  return typeof r.body === "string" ? new NextResponse(r.body, { status: r.status }) : NextResponse.json(r.body, { status: r.status });
}

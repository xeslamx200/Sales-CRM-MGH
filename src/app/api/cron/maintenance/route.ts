import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/server/supabase/admin";
import { isAuthorizedCron } from "@/server/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual / backup trigger for the database jobs that pg_cron normally runs
 * (migration 0870): task reminders and retention. Idempotent; every run is
 * logged in app.job_runs.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) return new NextResponse("unauthorized", { status: 401 });
  const db = createAdminClient();
  const [reminders, retention] = await Promise.all([
    db.rpc("run_scheduled_job", { p_job: "task_reminders" }),
    db.rpc("run_scheduled_job", { p_job: "retention" }),
  ]);
  if (reminders.error || retention.error) return NextResponse.json({ ok: false }, { status: 500 });
  return NextResponse.json({ ok: true, task_reminders: reminders.data, retention: retention.data });
}

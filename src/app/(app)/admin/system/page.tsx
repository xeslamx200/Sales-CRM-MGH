import { notFound } from "next/navigation";
import { PageHeader, Section } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { formatDateTime, formatNumber } from "@/lib/format.ts";
import { formatJobDetails } from "@/lib/job-status.ts";

/** Super admin: health of the scheduled jobs that run inside the database (pg_cron). */
export default async function SystemPage() {
  const viewer = await getViewer();
  if (!viewer.isSuperAdmin) notFound();
  const { t, locale } = viewer;
  const tz = viewer.companies[0]?.timezone ?? "UTC";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("job_status");
  if (error) throw error;

  return (
    <>
      <PageHeader title={t.system.title} description={t.system.hint} />
      <Section title={t.system.jobs}>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              {[t.system.job, t.system.lastRun, t.common.status, t.system.result, t.system.runs24h].map((h) => (
                <th key={h} className="py-1.5 text-start font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {(data ?? []).map((j) => (
              <tr key={j.job}>
                <td className="py-2">
                  <div className="font-medium">{t.system.jobNames[j.job as keyof typeof t.system.jobNames] ?? j.job}</div>
                  <div className="text-xs text-muted-foreground">{t.system.schedules[j.job as keyof typeof t.system.schedules]}</div>
                </td>
                <td className="py-2 text-xs">{j.last_started_at ? formatDateTime(j.last_started_at, tz, locale) : t.common.never}</td>
                <td className="py-2">
                  {j.last_ok == null ? <StatusBadge tone="warning">{t.system.notYet}</StatusBadge>
                    : j.last_ok ? <StatusBadge tone="success">{t.system.ok}</StatusBadge>
                    : <StatusBadge tone="danger">{t.system.failed}</StatusBadge>}
                </td>
                <td className="py-2"><code dir="ltr" className="text-xs">{formatJobDetails(j)}</code></td>
                <td className="ltr-nums py-2 text-xs">
                  {formatNumber(Number(j.runs_24h), locale)}
                  {Number(j.failures_24h) > 0 && <span className="text-destructive"> ({formatNumber(Number(j.failures_24h), locale)} ✕)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Section>
    </>
  );
}

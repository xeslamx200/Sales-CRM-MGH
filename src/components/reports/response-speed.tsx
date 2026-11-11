import Link from "next/link";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format.ts";
import type { Dictionary, Locale } from "@/i18n";

/** Rows of public.report_response_speed / report_waiting_now (values are not recomputed here). */
export type SpeedRow = {
  day: string | null; turns: number; answered: number; unanswered: number; answered_by_crm: number; answered_by_phone: number;
  avg_seconds: number | null; median_seconds: number | null; p90_seconds: number | null;
  within_5m: number | null; within_15m: number | null; within_60m: number | null;
};
export type WaitingRow = { conversation_id: string; contact_name: string; waiting_since: string; waiting_seconds: number; owner_name: string | null };

type Props = { t: Dictionary; locale: Locale };

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ResponseSpeedTiles({ overall, t, locale }: Props & { overall: SpeedRow | undefined }) {
  const s = t.reports.speed;
  const n = (v: number) => formatNumber(v, locale);
  if (!overall || overall.turns === 0) return <p className="text-sm text-muted-foreground">{t.reports.noData}</p>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile label={s.turns} value={n(overall.turns)} hint={`${s.answered}: ${n(overall.answered)} · ${s.unanswered}: ${n(overall.unanswered)}`} />
      <Tile label={s.median} value={formatDuration(overall.median_seconds, locale)} hint={`${s.average}: ${formatDuration(overall.avg_seconds, locale)}`} />
      <Tile label={s.within15m} value={formatPercent(overall.within_15m, locale)} hint={`${s.within5m}: ${formatPercent(overall.within_5m, locale)} · ${s.within60m}: ${formatPercent(overall.within_60m, locale)}`} />
      <Tile label={s.p90} value={formatDuration(overall.p90_seconds, locale)} hint={`${s.byCrm}: ${n(overall.answered_by_crm)} · ${s.byPhone}: ${n(overall.answered_by_phone)}`} />
    </div>
  );
}

export function WaitingNow({ rows, t, locale }: Props & { rows: WaitingRow[] }) {
  const s = t.reports.speed;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{s.waitingNone}</p>;
  return (
    <ul className="divide-y text-sm">
      {rows.slice(0, 8).map((r) => (
        <li key={r.conversation_id} className="flex items-center justify-between gap-3 py-1.5">
          <Link href={`/inbox?c=${r.conversation_id}`} className="min-w-0 truncate text-primary hover:underline">{r.contact_name}</Link>
          <span className="shrink-0 text-muted-foreground">
            {s.waitingFor} {formatDuration(r.waiting_seconds, locale)} · {r.owner_name ?? s.noOwner}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SpeedDailyTable({ rows, t, locale }: Props & { rows: SpeedRow[] }) {
  const s = t.reports.speed;
  const n = (v: number) => formatNumber(v, locale);
  const days = rows.filter((r) => r.day !== null).reverse();
  if (days.length === 0) return null;
  const heads = [t.common.date, s.turns, s.answered, s.unanswered, s.byCrm, s.byPhone, s.median, s.average, s.within15m];
  return (
    <div className="max-h-96 overflow-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted">
          <tr>{heads.map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-start font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {days.map((r) => (
            <tr key={r.day}>
              <td className="ltr-nums whitespace-nowrap px-3 py-1.5">{r.day}</td>
              <td className="ltr-nums px-3 py-1.5">{n(r.turns)}</td>
              <td className="ltr-nums px-3 py-1.5">{n(r.answered)}</td>
              <td className="ltr-nums px-3 py-1.5">{n(r.unanswered)}</td>
              <td className="ltr-nums px-3 py-1.5">{n(r.answered_by_crm)}</td>
              <td className="ltr-nums px-3 py-1.5">{n(r.answered_by_phone)}</td>
              <td className="ltr-nums px-3 py-1.5">{formatDuration(r.median_seconds, locale)}</td>
              <td className="ltr-nums px-3 py-1.5">{formatDuration(r.avg_seconds, locale)}</td>
              <td className="ltr-nums px-3 py-1.5">{formatPercent(r.within_15m, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

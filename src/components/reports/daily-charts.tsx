"use client";
import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { formatCurrency, formatNumber } from "@/lib/format.ts";

/** One row of public.report_daily_series (values are not recomputed here). */
export type DailyRow = { day: string; leads_created: number; calls_logged: number; tasks_completed: number };

// Validated categorical slots 1–3 (dataviz reference palette, light mode).
// Slot 3 (aqua) is below 3:1 on the surface, so a table view is always offered.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a"] as const;
const GRID = "#e6e8ec";
const AXIS = "#6b7280";

function shortDay(day: string, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en-u-nu-latn", { day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(day + "T12:00:00Z"));
}

/** One row of public.report_workshop_daily: bookings and confirmed money per day and currency (workshop companies). */
export type WorkshopDailyRow = { day: string; currency: string; bookings: number; booked_value: number; collected: number };

/** With `workshop` the revenue part comes from bookings and payments (one chart per currency) (companies without it show no revenue chart). */
export function DailyCharts({ rows, workshop }: { rows: DailyRow[]; workshop?: WorkshopDailyRow[] }) {
  const { t, locale, dir } = useI18n();
  const [table, setTable] = useState(false);
  const rtl = dir === "rtl";
  const series = [
    { key: "leads_created", label: t.reports.kpi.leadsCreated, color: SERIES[0] },
    { key: "tasks_completed", label: t.reports.kpi.tasksCompleted, color: SERIES[2] },
  ] as const;
  const currencies = [...new Set((workshop ?? []).map((w) => w.currency.trim()))].sort();
  const data = rows.map((r) => {
    const w = (workshop ?? []).filter((x) => x.day === r.day);
    const perCur = Object.fromEntries(currencies.map((c) => [`collected_${c}`, w.find((x) => x.currency.trim() === c)?.collected ?? 0]));
    return { ...r, ...perCur, bookings: w.reduce((a, x) => a + x.bookings, 0), label: shortDay(r.day, locale) };
  });
  const num = (v: unknown) => formatNumber(Number(v), locale);

  const tooltipStyle = { borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, direction: dir } as const;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setTable((v) => !v)} aria-pressed={table}>
          <Table2 />{table ? t.reports.showChart : t.reports.showTable}
        </Button>
      </div>
      {table ? (
        <div className="max-h-96 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t.common.date}</th>
                {series.map((s) => <th key={s.key} className="px-3 py-2 text-start font-medium">{s.label}</th>)}
                {workshop && (
                  <>
                    <th className="px-3 py-2 text-start font-medium">{t.workshopDash.bookings}</th>
                    {currencies.map((c) => <th key={c} className="px-3 py-2 text-start font-medium">{t.workshopDash.collected} ({c})</th>)}
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.map((r) => (
                <tr key={r.day}>
                  <td className="ltr-nums px-3 py-1.5">{r.day}</td>
                  {series.map((s) => <td key={s.key} className="ltr-nums px-3 py-1.5">{num(r[s.key])}</td>)}
                  {workshop && (
                    <>
                      <td className="ltr-nums px-3 py-1.5">{num(r.bookings)}</td>
                      {currencies.map((c) => <td key={c} className="ltr-nums px-3 py-1.5">{formatCurrency(Number((r as Record<string, unknown>)[`collected_${c}`] ?? 0), c, locale)}</td>)}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <figure className="flex flex-col gap-2">
            <figcaption className="text-sm font-medium">{t.reports.dailyActivity}</figcaption>
            <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label={t.reports.legend}>
              {series.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />{s.label}
                </li>
              ))}
            </ul>
            <div className="h-64" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" reversed={rtl} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
                  <YAxis orientation={rtl ? "right" : "left"} allowDecimals={false} width={36} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [num(v), name]} cursor={{ stroke: AXIS, strokeWidth: 1 }} />
                  {series.map((s) => (
                    <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
                      dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} strokeLinecap="round" strokeLinejoin="round" />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </figure>
          {workshop ? currencies.map((c) => (
            <figure key={c} className="flex flex-col gap-2" data-testid={`revenue-chart-${c}`}>
              <figcaption className="text-sm font-medium">{t.workshopDash.collected} · {c}</figcaption>
              <p className="text-xs text-muted-foreground">{t.workshopDash.collectedHint}</p>
              <div className="h-64" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" reversed={rtl} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
                    <YAxis orientation={rtl ? "right" : "left"} width={56} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false}
                      tickFormatter={(v) => new Intl.NumberFormat("en", { notation: "compact" }).format(Number(v))} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(0,0,0,0.04)" }}
                      formatter={(v) => [formatCurrency(Number(v), c, locale), t.workshopDash.collected]} />
                    <Bar dataKey={`collected_${c}`} fill={SERIES[0]} maxBarSize={24} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </figure>
          )) : null}
        </div>
      )}
    </div>
  );
}

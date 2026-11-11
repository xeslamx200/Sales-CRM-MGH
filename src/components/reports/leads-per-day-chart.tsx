"use client";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { formatNumber } from "@/lib/format.ts";

/** One row of public.report_leads_per_day (values are not recomputed here). */
export type LeadsDayRow = { day: string; total: number; automatic: number; manual: number };

const AUTOMATIC = "#2a78d6";
const MANUAL = "#eb6834";
const GRID = "#e6e8ec";
const AXIS = "#6b7280";

function shortDay(day: string, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en-u-nu-latn", { day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(day + "T12:00:00Z"));
}

export function LeadsPerDayChart({ rows }: { rows: LeadsDayRow[] }) {
  const { t, locale, dir } = useI18n();
  const [table, setTable] = useState(false);
  const rtl = dir === "rtl";
  const data = rows.map((r) => ({ ...r, label: shortDay(r.day, locale) }));
  const num = (v: unknown) => formatNumber(Number(v), locale);
  const sum = rows.reduce((a, r) => a + r.total, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t.reports.leadsTotal}: <span className="ltr-nums font-semibold text-foreground">{num(sum)}</span></p>
        <Button variant="ghost" size="sm" onClick={() => setTable((v) => !v)} aria-pressed={table}>
          <Table2 />{table ? t.reports.showChart : t.reports.showTable}
        </Button>
      </div>
      {table ? (
        <div className="max-h-80 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t.common.date}</th>
                <th className="px-3 py-2 text-start font-medium">{t.reports.leadsTotal}</th>
                <th className="px-3 py-2 text-start font-medium">{t.reports.leadsAutomatic}</th>
                <th className="px-3 py-2 text-start font-medium">{t.reports.leadsManual}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...rows].reverse().map((r) => (
                <tr key={r.day}>
                  <td className="ltr-nums px-3 py-1.5">{r.day}</td>
                  <td className="ltr-nums px-3 py-1.5 font-medium">{num(r.total)}</td>
                  <td className="ltr-nums px-3 py-1.5">{num(r.automatic)}</td>
                  <td className="ltr-nums px-3 py-1.5">{num(r.manual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <figure className="flex flex-col gap-2">
          <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label={t.reports.legend}>
            <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: AUTOMATIC }} />{t.reports.leadsAutomatic}</li>
            <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: MANUAL }} />{t.reports.leadsManual}</li>
          </ul>
          <div className="h-64" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" reversed={rtl} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
                <YAxis orientation={rtl ? "right" : "left"} allowDecimals={false} width={36} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, direction: dir }} cursor={{ fill: "rgba(0,0,0,0.04)" }}
                  formatter={(v, name) => [num(v), name]} />
                <Bar dataKey="automatic" name={t.reports.leadsAutomatic} stackId="l" isAnimationActive={false} fill={AUTOMATIC} maxBarSize={28} />
                <Bar dataKey="manual" name={t.reports.leadsManual} stackId="l" isAnimationActive={false} fill={MANUAL} maxBarSize={28} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </figure>
      )}
      <p className="text-xs text-muted-foreground">{t.reports.leadsNote}</p>
    </div>
  );
}

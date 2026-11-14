"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/app/status-badge";
import { useI18n } from "@/components/i18n-provider";
import { formatDateTime, formatDuration } from "@/lib/format.ts";

/** Rows of public.report_response_log (nothing is recomputed here). */
export type ResponseLogRow = {
  conversation_id: string; contact_name: string; phone: string | null; asked_at: string; answered_at: string | null;
  answered_by: "crm" | "phone" | null; answered_by_name: string | null; wait_seconds: number; owner_name: string | null;
};

/** Who wrote in the period, when they wrote, when (and from where) they were first answered; those still waiting come first. */
export function ResponseLog({ rows, timeZone }: { rows: ResponseLogRow[]; timeZone: string }) {
  const { t, locale } = useI18n();
  const s = t.reports.speed;
  const [filter, setFilter] = useState<"all" | "waiting" | "answered">("all");
  const waiting = rows.filter((r) => r.answered_at === null).length;
  const shown = rows.filter((r) => filter === "all" || (filter === "waiting") === (r.answered_at === null));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{s.logEmpty}</p>;
  const heads = [s.logCustomer, s.logSent, s.logFirstReply, s.logFrom, s.logWait];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group">
        {([["all", s.logAll, rows.length], ["waiting", s.logWaiting, waiting], ["answered", s.logAnswered, rows.length - waiting]] as const).map(([k, label, n]) => (
          <Button key={k} type="button" size="sm" variant={filter === k ? "secondary" : "outline"} className="rounded-full" aria-pressed={filter === k}
            onClick={() => setFilter(k)}>{label} <span className="ltr-nums">{n}</span></Button>
        ))}
      </div>
      {shown.length === 0 ? <p className="text-sm text-muted-foreground">{s.logNoMatch}</p> : (
        <div className="max-h-[32rem] overflow-auto rounded-lg border bg-card" data-testid="response-log">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr>{heads.map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 text-center font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((r) => (
                <tr key={`${r.conversation_id}-${r.asked_at}`} className="align-middle">
                  <td className="px-3 py-2 text-center">
                    <Link href={`/inbox?c=${r.conversation_id}`} className="font-medium text-primary hover:underline" dir="auto">{r.contact_name}</Link>
                    {r.phone && r.phone.replace(/\D/g, "") !== r.contact_name.replace(/\D/g, "") && <div className="ltr-nums text-xs text-muted-foreground">{r.phone}</div>}
                  </td>
                  <td className="ltr-nums whitespace-nowrap px-3 py-2 text-center">{formatDateTime(r.asked_at, timeZone, locale)}</td>
                  <td className="ltr-nums whitespace-nowrap px-3 py-2 text-center">
                    {r.answered_at ? formatDateTime(r.answered_at, timeZone, locale) : <StatusBadge tone="warning">{s.logStillWaiting}</StatusBadge>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {r.answered_by === "crm" ? <span>{s.logFromCrm}{r.answered_by_name ? <span className="text-muted-foreground"> · {r.answered_by_name}</span> : null}</span>
                      : r.answered_by === "phone" ? <span>{s.logFromPhone}</span> : "—"}
                  </td>
                  <td className="ltr-nums whitespace-nowrap px-3 py-2 text-center">{formatDuration(r.wait_seconds, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length >= 1000 && <p className="text-xs text-muted-foreground">{s.logLimit}</p>}
    </div>
  );
}

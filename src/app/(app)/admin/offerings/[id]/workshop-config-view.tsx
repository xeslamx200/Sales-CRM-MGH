import Link from "next/link";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import type { Dictionary, Locale } from "@/i18n";
import { formatNumber } from "@/lib/format.ts";
import { DeleteGroupButton, FinishGroupButton, GroupDialog } from "./workshop-config-forms";

export type PriceRow = { id: string; country: string; attendance: string; currency: string; price: number; session_price: number | null; is_active: boolean };
export type HistoryRow = { id: number; country: string; attendance: string; old_price: number | null; old_currency: string | null; new_price: number; new_currency: string; new_active: boolean; changed_at: string; actor: string | null };
export type GroupRow = { id: string; name: string; sessions: string[]; capacity: number | null; attendance: string | null; is_active: boolean; finished_at: string | null };
export type GapRow = { country: string; attendance: string };

/** Presentation only: the page (and a scratch preview) pass in already-loaded rows. */
export function WorkshopConfigView({ offering, t, locale, groups }: {
  offering: { id: string; name: string; is_active: boolean }; t: Dictionary; locale: Locale;
  groups: GroupRow[];
}) {
  const id = offering.id;
  const off = offering;
  const w = t.workshopConfig;
  const att = (a: string) => (a === "online" ? w.online : w.offline);
  const th = "px-3 py-2 text-start font-medium";
  return (
    <>
      <PageHeader
        title={off.name}
        description={w.title}
        actions={<Button asChild variant="outline"><Link href="/admin/offerings"><ArrowLeft className="rtl:rotate-180" />{w.back}</Link></Button>}
      />

      <Section title={w.groupsTitle} actions={<GroupDialog offeringId={id} trigger={<Button size="sm"><Plus />{w.newGroup}</Button>} />}>
        <p className="mb-3 text-sm text-muted-foreground">{w.groupsHint}</p>
        {groups.length === 0 ? <p className="text-sm text-muted-foreground">{w.noGroups}</p> : (
          <div className="relative overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr>{[t.common.name, w.colDates, w.attendance, w.colCapacity, t.common.status].map((h) => <th key={h} className={th}>{h}</th>)}<th className="w-12 px-3 py-2"><span className="sr-only">{t.common.actions}</span></th></tr></thead>
              <tbody className="divide-y">
                {groups.map((g) => (
                  <tr key={g.id} className="align-top">
                    <td className={g.is_active ? "px-3 py-2 font-medium" : "px-3 py-2 text-muted-foreground"}>{g.name}</td>
                    <td className="px-3 py-2"><div className="ltr-nums flex flex-wrap justify-center gap-x-2" dir="ltr">{g.sessions.map((d) => <span key={d} className="whitespace-nowrap">{d.replaceAll("-", "/")}</span>)}</div></td>
                    <td className="px-3 py-2">{g.attendance ? att(g.attendance) : w.anyAttendance}</td>
                    <td className="ltr-nums px-3 py-2">{g.capacity == null ? w.noCapacity : formatNumber(g.capacity, locale)}</td>
                    <td className="px-3 py-2">
                      {(() => {
                        // finished by an admin, or by itself once its last session date has passed
                        const lastDate = g.sessions.length ? g.sessions[g.sessions.length - 1] : null;
                        const over = Boolean(g.finished_at) || (lastDate !== null && lastDate < new Date().toISOString().slice(0, 10));
                        return over ? <StatusBadge tone="info">{w.finished}</StatusBadge> : <StatusBadge tone={g.is_active ? "success" : "neutral"}>{g.is_active ? t.common.active : w.inactive}</StatusBadge>;
                      })()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-center gap-0.5">
                      <GroupDialog offeringId={id} group={{ id: g.id, name: g.name, sessions: g.sessions.join("\n"), capacity: g.capacity == null ? "" : String(g.capacity), attendance: (g.attendance ?? "") as "" | "online" | "offline", isActive: g.is_active }}
                        trigger={<Button variant="ghost" size="icon-sm" aria-label={w.editGroup} title={w.editGroup} data-testid="edit-group"><Pencil /></Button>} />
                      <FinishGroupButton offeringId={id} groupId={g.id} finished={Boolean(g.finished_at)} />
                      <DeleteGroupButton offeringId={id} groupId={g.id} name={g.name} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

import Link from "next/link";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import type { Dictionary, Locale } from "@/i18n";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format.ts";
import { countryName } from "@/lib/workshop-config.ts";
import { DeactivatePriceButton, GroupDialog, PriceDialog } from "./workshop-config-forms";

export type PriceRow = { id: string; country: string; attendance: string; currency: string; price: number; is_active: boolean };
export type HistoryRow = { id: number; country: string; attendance: string; old_price: number | null; old_currency: string | null; new_price: number; new_currency: string; new_active: boolean; changed_at: string; actor: string | null };
export type GroupRow = { id: string; name: string; sessions: string[]; capacity: number | null; attendance: string | null; is_active: boolean };
export type GapRow = { country: string; attendance: string };

/** Presentation only: the page (and a scratch preview) pass in already-loaded rows. */
export function WorkshopConfigView({ offering, tz, t, locale, prices, history, groups, gaps }: {
  offering: { id: string; name: string; is_active: boolean }; tz: string; t: Dictionary; locale: Locale;
  prices: PriceRow[]; history: HistoryRow[]; groups: GroupRow[]; gaps: GapRow[];
}) {
  const id = offering.id;
  const off = offering;
  const w = t.workshopConfig;
  const att = (a: string) => (a === "online" ? w.online : w.offline);
  const th = "px-3 py-2 text-start font-medium";
  const myGaps = gaps;
  return (
    <>
      <PageHeader
        title={off.name}
        description={w.title}
        actions={<Button asChild variant="outline"><Link href="/admin/offerings"><ArrowLeft className="rtl:rotate-180" />{w.back}</Link></Button>}
      />

      <Section title={w.pricesTitle} actions={<PriceDialog offeringId={id} trigger={<Button size="sm"><Plus />{w.setPrice}</Button>} />}>
        <p className="mb-3 text-sm text-muted-foreground">{w.pricesHint}</p>
        {prices.length === 0 ? <p className="text-sm text-muted-foreground">{w.noPrices}</p> : (
          <div className="relative overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr>{[w.country, w.attendance, w.price, t.common.status].map((h) => <th key={h} className={th}>{h}</th>)}<th className="w-40 px-3 py-2"><span className="sr-only">{t.common.actions}</span></th></tr></thead>
              <tbody className="divide-y">
                {prices.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2">{countryName(p.country, locale)}</td>
                    <td className="px-3 py-2">{att(p.attendance)}</td>
                    <td className={`ltr-nums px-3 py-2 font-medium ${p.is_active ? "" : "text-muted-foreground line-through"}`}>{formatCurrency(Number(p.price), p.currency, locale)}</td>
                    <td className="px-3 py-2"><StatusBadge tone={p.is_active ? "success" : "neutral"}>{p.is_active ? t.common.active : w.inactive}</StatusBadge></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <PriceDialog offeringId={id} price={{ country: p.country, attendance: p.attendance as "online" | "offline", currency: p.currency, price: String(p.price) }}
                          trigger={<Button variant="ghost" size="icon-sm" aria-label={w.editPrice}><Pencil /></Button>} />
                        {p.is_active && <DeactivatePriceButton offeringId={id} country={p.country} attendance={p.attendance as "online" | "offline"} currency={p.currency} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 rounded-lg border border-dashed bg-card p-3">
          <h3 className="text-sm font-medium">{w.gapsTitle}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{w.gapsHint}</p>
          {off.is_active && myGaps.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {myGaps.map((g) => <li key={`${g.country}-${g.attendance}`}><span className="rounded bg-accent px-2 py-0.5 text-xs text-[color:var(--brand-gold-ink)]">{countryName(g.country, locale)} · {att(g.attendance)} — {w.notConfigured}</span></li>)}
            </ul>
          ) : <p className="text-xs text-muted-foreground">{w.noGaps}</p>}
        </div>
      </Section>

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
                    <td className="px-3 py-2"><div className="ltr-nums flex flex-wrap gap-x-2">{g.sessions.map((d) => <span key={d} className="whitespace-nowrap">{formatDate(d, "UTC", locale)}</span>)}</div></td>
                    <td className="px-3 py-2">{g.attendance ? att(g.attendance) : w.anyAttendance}</td>
                    <td className="ltr-nums px-3 py-2">{g.capacity == null ? w.noCapacity : formatNumber(g.capacity, locale)}</td>
                    <td className="px-3 py-2"><StatusBadge tone={g.is_active ? "success" : "neutral"}>{g.is_active ? t.common.active : w.inactive}</StatusBadge></td>
                    <td className="px-3 py-2">
                      <GroupDialog offeringId={id} group={{ id: g.id, name: g.name, sessions: g.sessions.join("\n"), capacity: g.capacity == null ? "" : String(g.capacity), attendance: (g.attendance ?? "") as "" | "online" | "offline", isActive: g.is_active }}
                        trigger={<Button variant="ghost" size="icon-sm" aria-label={w.editGroup}><Pencil /></Button>} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={w.historyTitle}>
        {history.length === 0 ? <p className="text-sm text-muted-foreground">{w.historyEmpty}</p> : (
          <ul className="divide-y rounded-lg border bg-card text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  {countryName(h.country, locale)} · {att(h.attendance)}:{" "}
                  {h.old_price != null && <span className="ltr-nums text-muted-foreground">{w.was} {formatCurrency(Number(h.old_price), h.old_currency ?? h.new_currency, locale)} → </span>}
                  <b className="ltr-nums">{formatCurrency(Number(h.new_price), h.new_currency, locale)}</b>
                  {!h.new_active && <span className="ms-2 text-xs text-muted-foreground">({w.inactive})</span>}
                </span>
                <span className="text-xs text-muted-foreground">{formatDate(h.changed_at, tz, locale)}{h.actor ? ` · ${w.by} ${h.actor}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

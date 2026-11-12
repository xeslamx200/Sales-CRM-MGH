"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpToLine, ChevronLeft, LayoutGrid, List, ListOrdered, Rows3, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/app/status-badge";
import { useI18n } from "@/components/i18n-provider";
import { saveOfferingOrder } from "@/actions/offerings";
import { normalizeSearch } from "@/components/ui/searchable-select";
import { fmt } from "@/i18n";
import { formatNumber } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

export type WorkshopItem = { id: string; name: string; kind: "course" | "workshop" | "service"; isActive: boolean; groups: number; prices: number };
type View = "cards" | "list" | "compact";
type Sort = "manual" | "name" | "groups";
const PREFS = "crm.workshops.prefs";

/**
 * The workshops of the company: search, filters, three ways to display them, and (for the company admin) an arrange mode that sets the order
 * everyone in the company sees. `items` arrive already in the saved order ("my order"); the view and sort choice are remembered in this browser.
 */
export function WorkshopBoard({ items, companyId, canArrange }: { items: WorkshopItem[]; companyId: string | null; canArrange: boolean }) {
  const { t, locale } = useI18n();
  const b = t.bookings;
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [kind, setKind] = useState<"all" | WorkshopItem["kind"]>("all");
  const [sort, setSort] = useState<Sort>("manual");
  const [view, setView] = useState<View>("cards");
  const [arranging, setArranging] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [pending, start] = useTransition();

  // read after mount: the server cannot know this browser's saved choice, and reading it during render would not match the server HTML
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as { view?: View; sort?: Sort };
      if (p.view === "cards" || p.view === "list" || p.view === "compact") setView(p.view);
      if (p.sort === "manual" || p.sort === "name" || p.sort === "groups") setSort(p.sort);
    } catch { /* no saved choice */ }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  const remember = (next: { view?: View; sort?: Sort }) => {
    try { localStorage.setItem(PREFS, JSON.stringify({ view, sort, ...next })); } catch { /* private mode */ }
  };

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const shown = useMemo(() => {
    const words = normalizeSearch(q).split(/\s+/).filter(Boolean);
    let rows = items.filter((i) =>
      (status === "all" || (status === "active") === i.isActive) && (kind === "all" || i.kind === kind)
      && words.every((w) => normalizeSearch(i.name).includes(w)));
    if (sort === "name") rows = [...rows].sort((a, c) => a.name.localeCompare(c.name, locale === "ar" ? "ar" : "en"));
    if (sort === "groups") rows = [...rows].sort((a, c) => c.groups - a.groups || a.name.localeCompare(c.name));
    return rows;
  }, [items, q, status, kind, sort, locale]);
  const filtered = q.trim() !== "" || status !== "all" || kind !== "all";

  const startArranging = () => { setOrder(items.map((i) => i.id)); setArranging(true); };
  const move = (from: number, to: number) => setOrder((o) => {
    if (to < 0 || to >= o.length) return o;
    const next = [...o];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    return next;
  });
  const save = () => start(async () => {
    if (!companyId) return;
    const res = await saveOfferingOrder({ companyId, ids: order });
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(b.wkOrderSaved);
    setArranging(false); setSort("manual"); remember({ sort: "manual" });
    router.refresh();
  });

  const num = (n: number) => formatNumber(n, locale);
  const meta = (i: WorkshopItem) => (
    <span className="text-sm text-muted-foreground">
      {b.wkGroups}: <b className="ltr-nums text-foreground">{num(i.groups)}</b> · {b.wkPrices}: <b className="ltr-nums text-foreground">{num(i.prices)}</b>
    </span>
  );
  const kindLabel = (k: WorkshopItem["kind"]) => t.enums.offeringKind[k];

  // ------------------------------------------------------------------------------------------------------------ arrange mode
  if (arranging) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{b.wkArrangeHint}</p>
        <div className="sticky top-14 z-10 flex gap-2 rounded-xl border bg-card/95 p-2 backdrop-blur">
          <Button onClick={save} disabled={pending} data-testid="wk-save-order">{b.wkSaveOrder}</Button>
          <Button variant="outline" onClick={() => setArranging(false)} disabled={pending}>{b.wkCancel}</Button>
        </div>
        <ol className="flex flex-col gap-2" data-testid="wk-order-list">
          {order.map((id, idx) => {
            const i = byId.get(id);
            if (!i) return null;
            return (
              <li key={id} className="flex items-center gap-1 rounded-xl border bg-card p-2 ps-3 shadow-sm sm:gap-2">
                <span className="ltr-nums w-7 shrink-0 text-center text-sm text-muted-foreground">{num(idx + 1)}</span>
                <span className="min-w-0 flex-1 truncate font-medium" dir="auto">{i.name}</span>
                {!i.isActive && <StatusBadge>{b.wkInactive}</StatusBadge>}
                <Button type="button" variant="ghost" size="icon" onClick={() => move(idx, 0)} disabled={idx === 0 || pending} aria-label={b.wkMoveTop} title={b.wkMoveTop}><ArrowUpToLine /></Button>
                <Button type="button" variant="ghost" size="icon" onClick={() => move(idx, idx - 1)} disabled={idx === 0 || pending} aria-label={b.wkMoveUp} title={b.wkMoveUp}><ArrowUp /></Button>
                <Button type="button" variant="ghost" size="icon" onClick={() => move(idx, idx + 1)} disabled={idx === order.length - 1 || pending} aria-label={b.wkMoveDown} title={b.wkMoveDown}><ArrowDown /></Button>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  // ------------------------------------------------------------------------------------------------------------ browse mode
  const viewButtons: { v: View; icon: typeof LayoutGrid; label: string }[] = [
    { v: "cards", icon: LayoutGrid, label: b.wkViewCards }, { v: "list", icon: List, label: b.wkViewList }, { v: "compact", icon: Rows3, label: b.wkViewCompact },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={b.wkSearch} aria-label={b.wkSearch} dir="auto" className="ps-8" data-testid="wk-search" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger size="sm" className="w-32" aria-label={t.common.status}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{b.wkAll}</SelectItem>
            <SelectItem value="active">{b.wkActiveOnly}</SelectItem>
            <SelectItem value="inactive">{b.wkInactiveOnly}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
          <SelectTrigger size="sm" className="w-36" aria-label={b.wkAllKinds}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{b.wkAllKinds}</SelectItem>
            {(["workshop", "course", "service"] as const).map((k) => <SelectItem key={k} value={k}>{kindLabel(k)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => { setSort(v as Sort); remember({ sort: v as Sort }); }}>
          <SelectTrigger size="sm" className="w-40" aria-label={b.wkSortLabel}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">{b.wkSortManual}</SelectItem>
            <SelectItem value="name">{b.wkSortName}</SelectItem>
            <SelectItem value="groups">{b.wkSortGroups}</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex rounded-lg border bg-card p-0.5" role="group" aria-label={b.wkViewCards}>
          {viewButtons.map(({ v, icon: Icon, label }) => (
            <Button key={v} type="button" size="icon-sm" variant={view === v ? "secondary" : "ghost"} aria-pressed={view === v} aria-label={label} title={label}
              onClick={() => { setView(v); remember({ view: v }); }}><Icon /></Button>
          ))}
        </div>
        {canArrange && <Button type="button" size="sm" variant="outline" onClick={startArranging} data-testid="wk-arrange"><ListOrdered />{b.wkArrange}</Button>}
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <span>{fmt(b.wkShown, { shown: num(shown.length), total: num(items.length) })}</span>
        {filtered && (
          <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => { setQ(""); setStatus("all"); setKind("all"); }}>
            <X className="size-3" />{b.wkClearFilters}
          </button>
        )}
      </p>

      {shown.length === 0 ? <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{b.wkNoMatch}</p> : view === "cards" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((o) => (
            <Link key={o.id} href={`/workshops/${o.id}`} prefetch={false} className="rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary/40 hover:shadow">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold" dir="auto">{o.name}</h2>
                {!o.isActive && <StatusBadge>{b.wkInactive}</StatusBadge>}
              </div>
              <p className="mt-2">{meta(o)}</p>
            </Link>
          ))}
        </div>
      ) : view === "list" ? (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {shown.map((o) => (
            <li key={o.id}>
              <Link href={`/workshops/${o.id}`} prefetch={false} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" dir="auto">{o.name}</span>
                  <span className="mt-0.5 block">{meta(o)}</span>
                </span>
                <span className="hidden text-xs text-muted-foreground sm:inline">{kindLabel(o.kind)}</span>
                {!o.isActive && <StatusBadge>{b.wkInactive}</StatusBadge>}
                <ChevronLeft className="size-4 shrink-0 text-muted-foreground ltr:rotate-180" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {shown.map((o) => (
            <Link key={o.id} href={`/workshops/${o.id}`} prefetch={false} title={o.name}
              className={cn("flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm hover:border-primary/40", !o.isActive && "opacity-60")}>
              <span className="min-w-0 flex-1 truncate" dir="auto">{o.name}</span>
              <span className="ltr-nums shrink-0 text-xs text-muted-foreground">{num(o.groups)}/{num(o.prices)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

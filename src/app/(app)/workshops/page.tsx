import Link from "next/link";
import { BookOpen } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { formatNumber } from "@/lib/format.ts";

/** The workshops of the active company with their groups and prices at a glance; each opens its own page. */
export default async function WorkshopsPage() {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const b = t.bookings;
  const companyIds = viewer.activeCompany ? [viewer.activeCompany.id] : viewer.scopeCompanyIds;
  const supabase = await createClient();
  const [offs, groups, prices] = await Promise.all([
    supabase.from("company_offerings").select("id, name, kind, is_active").in("company_id", companyIds).order("is_active", { ascending: false }).order("name"),
    supabase.from("workshop_groups").select("offering_id, is_active").in("company_id", companyIds),
    supabase.from("workshop_prices").select("offering_id, is_active").in("company_id", companyIds),
  ]);
  for (const r of [offs, groups, prices]) if (r.error) throw r.error;
  const count = (rows: { offering_id: string; is_active: boolean }[] | null) => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) if (r.is_active) m.set(r.offering_id, (m.get(r.offering_id) ?? 0) + 1);
    return m;
  };
  const g = count(groups.data), p = count(prices.data);
  return (
    <>
      <PageHeader title={b.wkTitle} description={b.wkSub} />
      {(offs.data ?? []).length === 0 ? <EmptyState icon={BookOpen} title={t.offerings.empty} /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(offs.data ?? []).map((o) => (
            <Link key={o.id} href={`/workshops/${o.id}`} className="rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary/40 hover:shadow">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold" dir="auto">{o.name}</h2>
                {!o.is_active && <StatusBadge>{b.wkInactive}</StatusBadge>}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {b.wkGroups}: <b className="ltr-nums text-foreground">{formatNumber(g.get(o.id) ?? 0, locale)}</b> · {b.wkPrices}: <b className="ltr-nums text-foreground">{formatNumber(p.get(o.id) ?? 0, locale)}</b>
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

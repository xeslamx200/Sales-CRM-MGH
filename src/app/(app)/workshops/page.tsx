import { BookOpen } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { WorkshopBoard } from "@/components/workshops/workshop-board";
import { getViewer, isAdminOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";

/** The workshops of the active company with their groups and prices at a glance; each opens its own page. Search, filters, display modes and the saved order live in WorkshopBoard. */
export default async function WorkshopsPage() {
  const viewer = await getViewer();
  const { t } = viewer;
  const b = t.bookings;
  const companyIds = viewer.activeCompany ? [viewer.activeCompany.id] : viewer.scopeCompanyIds;
  const supabase = await createClient();
  const [offs, groups, prices] = await Promise.all([
    // the saved order first (workshops not placed yet follow), then active before inactive, then by name
    supabase.from("company_offerings").select("id, name, kind, is_active, sort_order").in("company_id", companyIds)
      .order("sort_order", { ascending: true, nullsFirst: false }).order("is_active", { ascending: false }).order("name"),
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
        <WorkshopBoard
          companyId={viewer.activeCompany?.id ?? null}
          canArrange={Boolean(viewer.activeCompany) && isAdminOf(viewer, viewer.activeCompany?.id)}
          items={(offs.data ?? []).map((o) => ({ id: o.id, name: o.name, kind: o.kind, isActive: o.is_active, groups: g.get(o.id) ?? 0, prices: p.get(o.id) ?? 0 }))}
        />
      )}
    </>
  );
}

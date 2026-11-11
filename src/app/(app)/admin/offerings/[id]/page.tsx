import { notFound } from "next/navigation";
import { getViewer, isAdminOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { WORKSHOP_COUNTRIES } from "@/lib/workshop-config.ts";
import { WorkshopConfigView } from "./workshop-config-view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prices (workshop x country x attendance) and groups of one workshop. Company admins only; the database enforces every write. */
export default async function WorkshopConfigPage({ params }: PageProps<"/admin/offerings/[id]">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const { data: off } = await supabase.from("company_offerings").select("id, company_id, name, is_active").eq("id", id).maybeSingle();
  if (!off || !isAdminOf(viewer, off.company_id)) notFound();
  const tz = viewer.companies.find((c) => c.id === off.company_id)?.timezone ?? "UTC";

  const [prices, history, groups, gaps] = await Promise.all([
    supabase.from("workshop_prices").select("id, country, attendance, currency, price, is_active").eq("offering_id", id).order("country").order("attendance"),
    supabase.from("workshop_price_history").select("id, country, attendance, old_price, old_currency, new_price, new_currency, new_active, changed_at, changed_by").eq("offering_id", id).order("changed_at", { ascending: false }).limit(30),
    supabase.from("workshop_groups").select("id, name, sessions, capacity, attendance, is_active").eq("offering_id", id).order("starts_on"),
    supabase.rpc("workshop_price_gaps", { p_company_id: off.company_id, p_countries: WORKSHOP_COUNTRIES.map((c) => c.code) }),
  ]);
  for (const r of [prices, history, groups, gaps]) if (r.error) throw r.error;
  const actorIds = [...new Set((history.data ?? []).flatMap((h) => (h.changed_by ? [h.changed_by] : [])))];
  const actors = new Map<string, string>();
  if (actorIds.length) {
    const { data } = await supabase.from("profiles").select("id, full_name").in("id", actorIds);
    for (const p of data ?? []) actors.set(p.id, p.full_name);
  }
  return (
    <WorkshopConfigView
      offering={off} tz={tz} t={t} locale={locale}
      prices={prices.data ?? []}
      history={(history.data ?? []).map((h) => ({ ...h, actor: h.changed_by ? actors.get(h.changed_by) ?? null : null }))}
      groups={groups.data ?? []}
      gaps={(gaps.data ?? []).filter((g) => g.offering_id === id)}
    />
  );
}

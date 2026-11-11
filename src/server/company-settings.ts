import "server-only";
import type { ServerClient } from "@/server/supabase/server";
import { hiddenNavFor, usesWorkshopRevenue } from "@/lib/nav-visibility.ts";

export type CompanyUiSettings = { hiddenNav: readonly string[]; hiddenWidgets: readonly string[]; dashboardMode: "standard" | "workshop"; fromDatabase: boolean };

/**
 * Display settings of a company. The admin's saved settings win; a company that has never saved any keeps the built-in default
 * (src/lib/nav-visibility.ts), so nothing changes until an admin edits them on the settings page.
 */
export async function getCompanyUiSettings(supabase: ServerClient, company: { id: string; slug: string } | null | undefined): Promise<CompanyUiSettings> {
  if (!company) return { hiddenNav: [], hiddenWidgets: [], dashboardMode: "standard", fromDatabase: false };
  const { data, error } = await supabase.from("company_ui_settings").select("hidden_nav, dashboard_mode, hidden_widgets").eq("company_id", company.id).maybeSingle();
  if (!error && data) return { hiddenNav: data.hidden_nav, hiddenWidgets: data.hidden_widgets ?? [], dashboardMode: data.dashboard_mode === "workshop" ? "workshop" : "standard", fromDatabase: true };
  return { hiddenNav: hiddenNavFor(company.slug), hiddenWidgets: [], dashboardMode: usesWorkshopRevenue(company.slug) ? "workshop" : "standard", fromDatabase: false };
}

import "server-only";
import { cache } from "react";
import { createClient, type ServerClient } from "@/server/supabase/server";
import { hiddenNavFor, usesWorkshopRevenue } from "@/lib/nav-visibility.ts";

export type CompanyUiSettings = { hiddenNav: readonly string[]; hiddenWidgets: readonly string[]; dashboardMode: "standard" | "workshop"; fromDatabase: boolean };

// Read once per request: the layout and the page both need it (React's cache() lives for one server request only).
const loadUiSettings = cache(async (companyId: string, slug: string): Promise<CompanyUiSettings> => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("company_ui_settings").select("hidden_nav, dashboard_mode, hidden_widgets").eq("company_id", companyId).maybeSingle();
  if (!error && data) return { hiddenNav: data.hidden_nav, hiddenWidgets: data.hidden_widgets ?? [], dashboardMode: data.dashboard_mode === "workshop" ? "workshop" : "standard", fromDatabase: true };
  return { hiddenNav: hiddenNavFor(slug), hiddenWidgets: [], dashboardMode: usesWorkshopRevenue(slug) ? "workshop" : "standard", fromDatabase: false };
});

/**
 * Display settings of a company. The admin's saved settings win; a company that has never saved any keeps the built-in default
 * (src/lib/nav-visibility.ts), so nothing changes until an admin edits them on the settings page.
 * The first argument is kept for the callers; the read uses the same user session, once per request.
 */
export async function getCompanyUiSettings(_supabase: ServerClient, company: { id: string; slug: string } | null | undefined): Promise<CompanyUiSettings> {
  if (!company) return { hiddenNav: [], hiddenWidgets: [], dashboardMode: "standard", fromDatabase: false };
  return loadUiSettings(company.id, company.slug);
}

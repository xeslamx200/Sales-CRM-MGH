import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { DEFAULT_LOCALE, getDictionary, isLocale, type Dictionary, type Locale } from "@/i18n";
import type { Enums } from "@/types/database";

export const COMPANY_COOKIE = "crm_company";
export const ALL_COMPANIES = "all";

export type Role = Enums<"app_role">;

export type ViewerCompany = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  /** Test-only company (Kapso Sandbox): excluded from every report, KPI and the "all companies" scope. */
  isSandbox: boolean;
  /** null for a super admin without a membership in this company. */
  role: Role | null;
};

export type Viewer = {
  id: string;
  email: string;
  fullName: string;
  locale: Locale;
  isSuperAdmin: boolean;
  companies: ViewerCompany[];
  /** Selected company, or null when a super admin selected "all companies". */
  activeCompany: ViewerCompany | null;
  /** Company ids in scope for lists and reports. */
  scopeCompanyIds: string[];
  t: Dictionary;
};

/**
 * The signed-in user, loaded once per request with their own session (RLS
 * applies). Redirects to /login when there is no valid session or the
 * account is deactivated.
 */
export const getViewer = cache(async (): Promise<Viewer> => {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, locale, is_super_admin, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !profile.is_active) {
    await supabase.auth.signOut();
    redirect("/login?error=inactive");
  }

  // Companies the user can access. RLS returns all active companies for a
  // super admin and only member companies for everyone else.
  const [{ data: companies }, { data: memberships }] = await Promise.all([
    supabase.from("companies").select("id, name, slug, timezone, currency, is_sandbox").eq("is_active", true).order("name"),
    supabase.from("company_memberships").select("company_id, role").eq("user_id", user.id).eq("is_active", true),
  ]);
  const roleBy = new Map((memberships ?? []).map((m) => [m.company_id, m.role]));
  const list: ViewerCompany[] = (companies ?? [])
    .filter((c) => profile.is_super_admin || roleBy.has(c.id))
    .map(({ is_sandbox, ...c }) => ({ ...c, isSandbox: is_sandbox, currency: c.currency.trim(), role: roleBy.get(c.id) ?? null }));

  const cookieStore = await cookies();
  const wanted = cookieStore.get(COMPANY_COOKIE)?.value;
  let active: ViewerCompany | null;
  if (wanted === ALL_COMPANIES && profile.is_super_admin) active = null;
  // A sandbox company is only ever active when chosen explicitly; the default is a real company.
  else active = list.find((c) => c.id === wanted) ?? list.find((c) => !c.isSandbox) ?? list[0] ?? null;

  const locale = isLocale(profile.locale) ? profile.locale : DEFAULT_LOCALE;
  return {
    id: user.id,
    email: user.email ?? profile.email ?? "",
    fullName: profile.full_name || user.email || "",
    locale,
    isSuperAdmin: profile.is_super_admin,
    companies: list,
    activeCompany: active,
    // "All companies" never includes a sandbox company (its data is test data).
    scopeCompanyIds: active ? [active.id] : list.filter((c) => !c.isSandbox).map((c) => c.id),
    t: getDictionary(locale),
  };
});

/** Role helpers for showing/hiding UI. The database enforces the real rules. */
export function roleIn(viewer: Viewer, companyId: string | null | undefined): Role | "super_admin" | null {
  if (viewer.isSuperAdmin) return "super_admin";
  return viewer.companies.find((c) => c.id === companyId)?.role ?? null;
}

export function isAdminOf(viewer: Viewer, companyId: string | null | undefined): boolean {
  const r = roleIn(viewer, companyId);
  return r === "super_admin" || r === "company_admin";
}

export function isManagerOf(viewer: Viewer, companyId: string | null | undefined): boolean {
  const r = roleIn(viewer, companyId);
  return r === "super_admin" || r === "company_admin" || r === "sales_manager";
}

/** Is the viewer an admin of at least one company (or super admin)? */
export function isAnyAdmin(viewer: Viewer): boolean {
  return viewer.isSuperAdmin || viewer.companies.some((c) => c.role === "company_admin");
}

export function isAnyManager(viewer: Viewer): boolean {
  return viewer.isSuperAdmin || viewer.companies.some((c) => c.role === "company_admin" || c.role === "sales_manager");
}

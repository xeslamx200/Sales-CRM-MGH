import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { PageHeader, Section } from "@/components/app/page-header";
import { getViewer, isAdminOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { listMembers } from "@/server/data/members";
import { getCompanyUiSettings } from "@/server/company-settings";
import { getBranding, logoUrl } from "@/server/branding";
import { BrandingForm } from "./branding-form";
import { PeopleSection, type PersonAccount } from "./people-section";
import { ApproversForm, ExclusionRow, TargetCurrencyForm, TargetDefaultRow, UiSettingsForm, type PersonRow } from "./settings-forms";

/** Everything a company admin can configure for the active company without touching the code. */
export default async function CompanySettingsPage() {
  const viewer = await getViewer();
  const company = viewer.activeCompany;
  if (!company || !isAdminOf(viewer, company.id)) notFound();
  const { t } = viewer;
  const c = t.companySettings;
  const supabase = await createClient();

  const [members, policy, approvers, defaults, cur, rates, exclusions, ui, brand, allMembers, teamRows, phoneRows] = await Promise.all([
    listMembers(supabase, [company.id], { activeOnly: true }),
    supabase.from("payment_approval_policy").select("company_id").eq("company_id", company.id).maybeSingle(),
    supabase.from("payment_approvers").select("user_id").eq("company_id", company.id),
    supabase.from("monthly_target_defaults").select("user_id, amount_egp").eq("company_id", company.id),
    supabase.rpc("company_target_currency", { p_company_id: company.id }),
    supabase.from("fx_rates").select("currency"),
    supabase.from("performance_exclusions").select("user_id, reason").eq("company_id", company.id),
    getCompanyUiSettings(supabase, company),
    getBranding(supabase, company.id),
    listMembers(supabase, [company.id]),
    supabase.from("teams").select("id, name").eq("company_id", company.id).order("name"),
    supabase.from("company_memberships").select("user_id, profile:profiles!company_memberships_user_id_fkey(phone)").eq("company_id", company.id),
  ]);
  for (const r of [policy, approvers, defaults, exclusions]) if (r.error) throw r.error;
  const phoneOf = new Map((phoneRows.data ?? []).map((x) => [x.user_id, x.profile?.phone ?? null]));
  const accounts: PersonAccount[] = allMembers.map((m) => ({
    userId: m.userId, name: m.fullName, email: m.email, phone: phoneOf.get(m.userId) ?? null, role: m.role, active: m.isActive && m.profileActive,
  }));

  const person = (m: (typeof members)[number]): PersonRow => ({ userId: m.userId, name: m.fullName, role: t.enums.role[m.role] });
  const everyone = members.map(person);
  const managers = members.filter((m) => m.role === "company_admin" || m.role === "sales_manager").map(person);
  // a monthly target can be set for every person who sells or serves customers: managers, sales agents and CS agents (the database allows exactly these roles)
  const agents = members.filter((m) => m.role === "sales_manager" || m.role === "sales_agent" || m.role === "cs_agent");
  const targetCurrency = (cur.data ?? "EGP").trim();
  const currencies = [...new Set(["EGP", ...(rates.data ?? []).map((r) => r.currency.trim()), targetCurrency])].sort();
  const defaultOf = new Map((defaults.data ?? []).map((d) => [d.user_id, Number(d.amount_egp)]));
  const excludedOf = new Map((exclusions.data ?? []).map((x) => [x.user_id, x.reason ?? ""]));
  const th = "whitespace-nowrap px-3 py-2 text-start font-medium";

  const hub: { href: string; label: string }[] = [
    { href: "/admin/users", label: c.hub.users },
    { href: "/admin/teams", label: c.hub.teams },
    { href: "/admin/whatsapp", label: c.hub.whatsapp },
    { href: "/admin/pipelines", label: c.hub.pipelines },
    { href: "/admin/offerings", label: c.hub.offerings },
    { href: "/performance", label: c.hub.performance },
    { href: "/reports?tab=shifts", label: c.hub.shifts },
    { href: "/admin/companies", label: c.hub.companies },
    { href: "/admin/audit", label: c.hub.audit },
  ];

  return (
    <>
      <PageHeader title={c.title} description={`${company.name} · ${c.hint}`} />
      <Section title={t.people.title}>
        <PeopleSection companyId={company.id} people={accounts} teams={(teamRows.data ?? []).map((x) => ({ value: x.id, label: x.name }))} superAdmin={viewer.isSuperAdmin} viewerId={viewer.id} />
      </Section>
      <Section title={c.approversTitle}>
        <div className="p-4">
          <p className="mb-3 text-sm text-muted-foreground">{c.approversHint}</p>
          <ApproversForm companyId={company.id} people={managers} selected={(approvers.data ?? []).map((a) => a.user_id)} restricted={!!policy.data} />
        </div>
      </Section>
      <Section title={c.targetsTitle}>
        <div className="grid gap-4 p-4">
          <p className="text-sm text-muted-foreground">{c.targetsHint}</p>
          <TargetCurrencyForm companyId={company.id} current={targetCurrency} options={currencies} />
          <div className="relative overflow-x-auto rounded-lg border">
            <table className="w-full text-sm" data-testid="target-defaults">
              <thead className="bg-muted/50"><tr><th className={th}>{c.employee}</th><th className={th}>{c.amount}</th></tr></thead>
              <tbody className="divide-y">
                <TargetDefaultRow key={`co-${defaultOf.get(null as unknown as string) ?? "x"}`} companyId={company.id} userId={null} label={c.companyDefault} value={defaultOf.get(null as unknown as string) ?? null} currency={targetCurrency} />
                {agents.map((m) => (
                  <TargetDefaultRow key={`${m.userId}-${defaultOf.get(m.userId) ?? "x"}`} companyId={company.id} userId={m.userId} label={m.fullName} sub={t.enums.role[m.role]}
                    value={defaultOf.get(m.userId) ?? null} currency={targetCurrency} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
      <Section title={c.exclusionsTitle}>
        <div className="grid gap-3 p-4">
          <p className="text-sm text-muted-foreground">{c.exclusionsHint}</p>
          <div className="relative overflow-x-auto rounded-lg border">
            <table className="w-full text-sm" data-testid="exclusions">
              <tbody className="divide-y">
                {everyone.map((p) => <ExclusionRow key={`${p.userId}-${excludedOf.has(p.userId)}`} companyId={company.id} person={p} excluded={excludedOf.has(p.userId)} reason={excludedOf.get(p.userId) ?? ""} />)}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
      <Section title={c.menuTitle}>
        <div className="p-4"><UiSettingsForm hiddenWidgets={[...ui.hiddenWidgets]} key={`${ui.hiddenNav.join(",")}-${ui.dashboardMode}`} companyId={company.id} hidden={[...ui.hiddenNav]} mode={ui.dashboardMode} usingDefault={!ui.fromDatabase} /></div>
      </Section>
      <Section title={t.branding.title}>
        <div className="grid gap-3 p-4">
          <p className="text-sm text-muted-foreground">{t.branding.hint}</p>
          <BrandingForm key={brand.version} companyId={company.id} initial={brand.colors} custom={brand.custom}
            logoSrc={brand.hasLogo ? logoUrl(company.id, brand.version) : null} plate={brand.logoPlate} />
        </div>
      </Section>
      <Section title={c.hubTitle}>
        <ul className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {hub.map((h) => (
            <li key={h.href}>
              <Link href={h.href} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted">
                <span>{h.label}</span><ArrowUpRight className="size-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

import { notFound } from "next/navigation";
import Link from "next/link";
import { BookOpen, Coins, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { getViewer, isAdminOf, isAnyAdmin } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { formatCurrency } from "@/lib/format.ts";
import { OfferingDialog } from "./offering-form";

/** Company catalogue of courses, workshops and services used to qualify WhatsApp leads. */
export default async function OfferingsPage() {
  const viewer = await getViewer();
  if (!isAnyAdmin(viewer)) notFound();
  const { t } = viewer;
  const companies = viewer.companies.filter((c) => viewer.scopeCompanyIds.includes(c.id) && isAdminOf(viewer, c.id));
  const supabase = await createClient();
  const { data, error } = await supabase.from("company_offerings")
    .select("id, company_id, name, kind, keywords, is_active, price_egp")
    .in("company_id", companies.map((c) => c.id)).order("is_active", { ascending: false }).order("name");
  if (error) throw error;
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const options = companies.map((c) => ({ value: c.id, label: c.name }));

  return (
    <>
      <PageHeader
        title={t.offerings.title}
        description={t.offerings.hint}
        actions={companies.length > 0 && (
          <OfferingDialog companies={options} trigger={<Button><Plus />{t.offerings.newOffering}</Button>} />
        )}
      />
      {(data ?? []).length === 0 ? <EmptyState icon={BookOpen} title={t.offerings.empty} /> : (
        <div className="relative min-w-0 max-w-full overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                {[t.common.name, ...(companies.length > 1 ? [t.common.company] : []), t.offerings.kind, t.offerings.price, t.offerings.keywords, t.common.status].map((h) => (
                  <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>
                ))}
                <th className="w-24 px-3 py-2"><span className="sr-only">{t.common.actions}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(data ?? []).map((o) => (
                <tr key={o.id} className="align-top">
                  <td className={o.is_active ? "px-3 py-2 font-medium" : "px-3 py-2 text-muted-foreground"}>{o.name}</td>
                  {companies.length > 1 && <td className="px-3 py-2">{companyName.get(o.company_id)}</td>}
                  <td className="px-3 py-2">{t.enums.offeringKind[o.kind]}</td>
                  <td className="ltr-nums px-3 py-2">{o.price_egp == null ? <span className="text-xs text-muted-foreground">{t.offerings.noPrice}</span> : formatCurrency(Number(o.price_egp), "EGP", viewer.locale)}</td>
                  <td className="px-3 py-2">
                    {o.keywords.length === 0 ? <span className="text-xs text-muted-foreground">{t.offerings.noKeywords}</span> : (
                      <div className="flex flex-wrap gap-1">
                        {o.keywords.map((k) => <span key={k} dir="auto" className="rounded bg-muted px-1.5 py-0.5 text-xs">{k}</span>)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={o.is_active ? "success" : "neutral"}>{o.is_active ? t.common.active : t.common.inactive}</StatusBadge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Button asChild variant="ghost" size="icon-sm">
                        <Link href={`/admin/offerings/${o.id}`} aria-label={`${t.workshopConfig.open}: ${o.name}`} title={t.workshopConfig.open}><Coins /></Link>
                      </Button>
                      <OfferingDialog
                        companies={options}
                        offering={{ id: o.id, companyId: o.company_id, name: o.name, kind: o.kind, keywords: o.keywords.join("\n"), priceEgp: o.price_egp == null ? "" : String(o.price_egp), isActive: o.is_active }}
                        trigger={<Button variant="ghost" size="icon-sm" aria-label={`${t.offerings.editOffering}: ${o.name}`}><Pencil /></Button>}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { StatusBadge } from "@/components/app/status-badge";
import { getViewer, isAdminOf, isAnyAdmin } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { CompanyDialog } from "./company-form";

export default async function CompaniesPage() {
  const viewer = await getViewer();
  if (!isAnyAdmin(viewer)) notFound();
  const { t } = viewer;
  const supabase = await createClient();
  // RLS: super admin sees every company (incl. inactive); others their own.
  const { data, error } = await supabase.from("companies").select("id, name, slug, timezone, currency, is_active, is_sandbox").order("name");
  if (error) throw error;
  const rows = (data ?? []).filter((c) => isAdminOf(viewer, c.id));

  return (
    <>
      <PageHeader
        title={t.admin.companiesTitle}
        description={t.admin.companiesHint}
        actions={viewer.isSuperAdmin && (
          <CompanyDialog superAdmin trigger={<Button><Plus />{t.admin.newCompany}</Button>} />
        )}
      />
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        empty={{ title: t.common.noResults }}
        columns={[
          { key: "name", header: t.common.name, cell: (r) => <span className="flex flex-wrap items-center gap-1.5 font-medium">{r.name}{r.is_sandbox && <StatusBadge tone="warning">{t.common.sandbox}</StatusBadge>}</span> },
          { key: "slug", header: t.admin.slug, cell: (r) => <code dir="ltr" className="text-xs">{r.slug}</code> },
          { key: "tz", header: t.admin.timezone, cell: (r) => <span dir="ltr">{r.timezone}</span> },
          { key: "cur", header: t.admin.currency, cell: (r) => <span dir="ltr">{r.currency}</span> },
          {
            key: "status", header: t.common.status,
            cell: (r) => <StatusBadge tone={r.is_active ? "success" : "neutral"}>{r.is_active ? t.common.active : t.common.inactive}</StatusBadge>,
          },
          {
            key: "actions", header: <span className="sr-only">{t.common.actions}</span>, className: "w-24",
            cell: (r) => (
              <div className="flex items-center gap-1">
                <Button asChild variant="ghost" size="icon-sm">
                  <Link href={`/admin/companies/${r.id}/hours`} aria-label={`${t.hours.manage}: ${r.name}`}><Clock /></Link>
                </Button>
                <CompanyDialog
                  superAdmin={viewer.isSuperAdmin}
                  company={{ id: r.id, name: r.name, slug: r.slug, timezone: r.timezone, currency: r.currency.trim(), isActive: r.is_active, isSandbox: r.is_sandbox }}
                  trigger={<Button variant="ghost" size="icon-sm" aria-label={t.common.edit}><Pencil /></Button>}
                />
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

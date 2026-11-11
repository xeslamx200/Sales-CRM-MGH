import { notFound } from "next/navigation";
import { Pencil, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { FilterBar } from "@/components/app/filter-bar";
import { StatusBadge } from "@/components/app/status-badge";
import { getViewer, isAdminOf, isAnyAdmin } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { listMembers } from "@/server/data/members";
import { Constants } from "@/types/database";
import { InviteDialog, MembershipDialog, ProfileActiveButton } from "./user-forms";

export default async function UsersPage({ searchParams }: PageProps<"/admin/users">) {
  const viewer = await getViewer();
  if (!isAnyAdmin(viewer)) notFound();
  const { t } = viewer;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim().toLowerCase() : "";
  const role = typeof sp.role === "string" ? sp.role : "";
  const status = typeof sp.status === "string" ? sp.status : "";

  const adminCompanies = viewer.companies.filter((c) => viewer.scopeCompanyIds.includes(c.id) && isAdminOf(viewer, c.id));
  const supabase = await createClient();
  const members = await listMembers(supabase, adminCompanies.map((c) => c.id));
  const companyName = new Map(viewer.companies.map((c) => [c.id, c.name]));

  const rows = members.filter((m) =>
    (!q || m.fullName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
    && (!role || m.role === role)
    && (!status || (status === "active" ? m.isActive && m.profileActive : !(m.isActive && m.profileActive))));

  const roleOptions = Constants.public.Enums.app_role.map((r) => ({ value: r, label: t.enums.role[r] }));

  return (
    <>
      <PageHeader
        title={t.admin.usersTitle}
        description={t.admin.usersHint}
        actions={adminCompanies.length > 0 && (
          <InviteDialog
            companies={adminCompanies.map((c) => ({ value: c.id, label: c.name }))}
            defaultCompanyId={viewer.activeCompany?.id ?? adminCompanies[0]?.id}
            superAdmin={viewer.isSuperAdmin}
            trigger={<Button><UserPlus />{t.admin.inviteUser}</Button>}
          />
        )}
      />
      <FilterBar filters={[
        { type: "search", name: "q", placeholder: t.admin.searchUsers },
        { type: "select", name: "role", label: t.common.role, options: roleOptions },
        { type: "select", name: "status", label: t.common.status, options: [
          { value: "active", label: t.common.active }, { value: "inactive", label: t.common.inactive },
        ] },
      ]} />
      <DataTable
        rows={rows}
        rowKey={(r) => r.membershipId}
        empty={{ title: t.common.noResults }}
        columns={[
          {
            key: "name", header: t.common.name,
            cell: (r) => (
              <div className="flex flex-col items-start">
                <span className="font-medium">{r.fullName}</span>
                <span className="text-xs text-muted-foreground" dir="ltr">{r.email}</span>
              </div>
            ),
          },
          ...(adminCompanies.length > 1 ? [{ key: "company", header: t.common.company, cell: (r: typeof rows[number]) => companyName.get(r.companyId) }] : []),
          { key: "role", header: t.common.role, cell: (r) => t.enums.role[r.role] },
          {
            key: "status", header: t.common.status,
            cell: (r) => !r.profileActive
              ? <StatusBadge tone="danger">{t.admin.accountDeactivated}</StatusBadge>
              : <StatusBadge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? t.common.active : t.admin.membershipInactive}</StatusBadge>,
          },
          {
            key: "actions", header: <span className="sr-only">{t.common.actions}</span>, className: "w-24",
            cell: (r) => r.userId === viewer.id ? null : (
              <div className="flex justify-end gap-1">
                <MembershipDialog
                  membership={{ id: r.membershipId, role: r.role, isActive: r.isActive, name: r.fullName }}
                  superAdmin={viewer.isSuperAdmin}
                  trigger={<Button variant="ghost" size="icon-sm" aria-label={t.common.edit}><Pencil /></Button>}
                />
                {viewer.isSuperAdmin && <ProfileActiveButton userId={r.userId} name={r.fullName} active={r.profileActive} />}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

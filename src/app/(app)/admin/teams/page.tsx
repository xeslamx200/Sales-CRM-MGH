import { notFound } from "next/navigation";
import { Pencil, Plus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { getViewer, isAdminOf, isAnyManager } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { listMembers } from "@/server/data/members";
import { AddMemberForm, RemoveMemberButton, TeamDialog } from "./team-forms";

export default async function TeamsPage() {
  const viewer = await getViewer();
  if (!isAnyManager(viewer)) notFound();
  const { t } = viewer;
  const supabase = await createClient();
  const companyIds = viewer.scopeCompanyIds;

  const [{ data: teams, error }, members] = await Promise.all([
    supabase.from("teams")
      .select("id, company_id, name, manager_id, is_active, manager:profiles!teams_manager_id_fkey(full_name), members:team_memberships(user_id, profile:profiles!team_memberships_user_id_fkey(full_name))")
      .in("company_id", companyIds).order("name"),
    listMembers(supabase, companyIds, { activeOnly: true }),
  ]);
  if (error) throw error;

  const companyName = new Map(viewer.companies.map((c) => [c.id, c.name]));
  const adminCompanies = viewer.companies.filter((c) => companyIds.includes(c.id) && isAdminOf(viewer, c.id));
  const managersBy = (companyId: string) => members
    .filter((m) => m.companyId === companyId && (m.role === "company_admin" || m.role === "sales_manager"))
    .map((m) => ({ value: m.userId, label: m.fullName }));
  const membersBy = (companyId: string) => members
    .filter((m) => m.companyId === companyId)
    .map((m) => ({ value: m.userId, label: `${m.fullName} — ${t.enums.role[m.role]}` }));

  return (
    <>
      <PageHeader
        title={t.admin.teamsTitle}
        description={t.admin.teamsHint}
        actions={adminCompanies.length > 0 && (
          <TeamDialog
            companies={adminCompanies.map((c) => ({ value: c.id, label: c.name }))}
            managersByCompany={Object.fromEntries(adminCompanies.map((c) => [c.id, managersBy(c.id)]))}
            trigger={<Button><Plus />{t.admin.newTeam}</Button>}
          />
        )}
      />
      {(teams ?? []).length === 0 ? (
        <EmptyState icon={UsersRound} title={t.admin.noTeams} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(teams ?? []).map((team) => {
            const canEdit = isAdminOf(viewer, team.company_id);
            const memberIds = new Set(team.members.map((m) => m.user_id));
            return (
              <section key={team.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="font-semibold">{team.name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {companyIds.length > 1 && <>{companyName.get(team.company_id)} · </>}
                      {t.admin.manager}: {team.manager?.full_name ?? t.common.none}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {!team.is_active && <StatusBadge>{t.common.inactive}</StatusBadge>}
                    {canEdit && (
                      <TeamDialog
                        team={{ id: team.id, companyId: team.company_id, name: team.name, managerId: team.manager_id, isActive: team.is_active }}
                        companies={[{ value: team.company_id, label: companyName.get(team.company_id) ?? "" }]}
                        managersByCompany={{ [team.company_id]: managersBy(team.company_id) }}
                        trigger={<Button variant="ghost" size="icon-sm" aria-label={t.common.edit}><Pencil /></Button>}
                      />
                    )}
                  </div>
                </div>
                <ul className="flex flex-col divide-y rounded-md border text-sm">
                  {team.members.length === 0 && <li className="p-2 text-muted-foreground">{t.admin.noMembers}</li>}
                  {team.members.map((m) => (
                    <li key={m.user_id} className="flex items-center justify-between gap-2 px-2 py-1.5">
                      <span>{m.profile?.full_name ?? "—"}</span>
                      {canEdit && (
                        <RemoveMemberButton teamId={team.id} companyId={team.company_id} userId={m.user_id}
                          name={m.profile?.full_name ?? ""} />
                      )}
                    </li>
                  ))}
                </ul>
                {canEdit && (
                  <AddMemberForm teamId={team.id} companyId={team.company_id}
                    options={membersBy(team.company_id).filter((o) => !memberIds.has(o.value))} />
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

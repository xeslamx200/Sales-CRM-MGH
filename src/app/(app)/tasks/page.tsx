import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { DataTable, Pagination } from "@/components/app/data-table";
import { FilterBar } from "@/components/app/filter-bar";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { TaskDialog } from "@/components/crm/record-actions";
import { TaskRowActions } from "@/components/crm/task-row-actions";
import { getViewer, isAnyManager } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { listMembers, peopleOptions } from "@/server/data/members";
import { PAGE_SIZE } from "@/server/data/leads";
import { todayBounds } from "@/server/crm";
import { oneOf, page as pageParam, uuid } from "@/lib/search-params";
import { formatDateTime } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

const VIEWS = ["mine", "today", "upcoming", "overdue", "completed", "team"] as const;
type View = (typeof VIEWS)[number];

const SELECT = "id, company_id, title, status, priority, due_at, completed_at, assigned_to, outcome, lead:leads!tasks_lead_id_company_id_fkey(id, title), contact:contacts!tasks_contact_id_fkey(id, full_name), assignee:profiles!tasks_assigned_to_fkey(full_name)";

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const manager = isAnyManager(viewer);
  const view: View = oneOf(sp, "view", VIEWS) ?? "mine";
  const page = pageParam(sp);
  const tz = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  const today = todayBounds(tz);
  const nowIso = new Date().toISOString();
  const supabase = await createClient();
  const members = await listMembers(supabase, viewer.scopeCompanyIds, { activeOnly: true });

  let q = supabase.from("tasks").select(SELECT, { count: "exact" }).in("company_id", viewer.scopeCompanyIds);
  const open = ["open", "in_progress"] as const;
  switch (view) {
    case "mine": q = q.eq("assigned_to", viewer.id).in("status", open).order("due_at", { ascending: true, nullsFirst: false }); break;
    case "today": q = q.eq("assigned_to", viewer.id).in("status", open).gte("due_at", today.start).lt("due_at", today.end).order("due_at"); break;
    case "upcoming": q = q.eq("assigned_to", viewer.id).in("status", open).gte("due_at", today.end).order("due_at"); break;
    case "overdue": q = q.eq("assigned_to", viewer.id).in("status", open).lt("due_at", nowIso).order("due_at"); break;
    case "completed": q = q.eq("completed_by", viewer.id).eq("status", "completed").order("completed_at", { ascending: false }); break;
    case "team": {
      // RLS already limits this to tasks of people the viewer manages.
      q = q.neq("assigned_to", viewer.id).in("status", open).order("due_at", { ascending: true, nullsFirst: false });
      const who = uuid(sp, "assignee");
      if (who) q = q.eq("assigned_to", who);
      break;
    }
  }
  const { data, count, error } = await q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error) throw error;

  const tabs: { key: View; label: string }[] = [
    { key: "mine", label: t.tasks.mine }, { key: "today", label: t.tasks.today }, { key: "upcoming", label: t.tasks.upcoming },
    { key: "overdue", label: t.tasks.overdue }, { key: "completed", label: t.tasks.completed },
    ...(manager ? [{ key: "team" as View, label: t.tasks.team }] : []),
  ];
  const scopeCompanies = viewer.companies.filter((c) => viewer.scopeCompanyIds.includes(c.id));

  return (
    <>
      <PageHeader
        title={t.nav.tasks}
        actions={scopeCompanies.length > 0 && (
          <TaskDialog
            companyId={viewer.activeCompany?.id ?? scopeCompanies[0].id}
            companies={scopeCompanies.map((c) => ({ value: c.id, label: c.name }))}
            assignees={Object.fromEntries(scopeCompanies.map((c) => [c.id, peopleOptions(members, c.id)]))}
            defaultAssignee={viewer.id}
            trigger={<Button><Plus />{t.records.newTask}</Button>}
          />
        )}
      />
      <nav className="flex flex-wrap gap-1 border-b" aria-label={t.nav.tasks}>
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.key === "mine" ? "/tasks" : `/tasks?view=${tab.key}`}
            aria-current={view === tab.key ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              view === tab.key ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {view === "team" && (
        <FilterBar filters={[{ type: "select", name: "assignee", label: t.records.assignee, options: peopleOptions(members).filter((p) => p.value !== viewer.id) }]} />
      )}
      <DataTable
        rows={data ?? []}
        rowKey={(r) => r.id}
        empty={{ title: t.tasks.empty[view] }}
        columns={[
          {
            key: "title", header: t.common.title,
            cell: (r) => (
              <div className="flex flex-col items-start">
                <span className="font-medium">{r.title}</span>
                {r.lead ? <Link href={`/leads/${r.lead.id}`} className="text-xs text-primary hover:underline">{r.lead.title}</Link>
                  : r.contact ? <Link href={`/contacts/${r.contact.id}`} className="text-xs text-primary hover:underline">{r.contact.full_name}</Link>
                  : null}
                {view === "completed" && r.outcome && <span className="text-xs text-muted-foreground">{r.outcome}</span>}
              </div>
            ),
          },
          {
            key: "due", header: view === "completed" ? t.tasks.completedAt : t.records.dueAt,
            cell: (r) => {
              const at = view === "completed" ? r.completed_at : r.due_at;
              if (!at) return <span className="text-muted-foreground">{t.records.noDueDate}</span>;
              const late = view !== "completed" && Date.parse(at) < Date.now();
              return <span className={cn("text-xs", late && "font-medium text-destructive")}>{formatDateTime(at, tz, locale)}</span>;
            },
          },
          { key: "priority", header: t.leads.priority, cell: (r) => <StatusBadge tone={toneFor(r.priority)}>{t.enums.priority[r.priority]}</StatusBadge> },
          ...(view === "team" ? [{ key: "assignee", header: t.records.assignee, cell: (r: NonNullable<typeof data>[number]) => r.assignee?.full_name ?? t.common.unassigned }] : []),
          { key: "status", header: t.common.status, cell: (r) => <StatusBadge tone={toneFor(r.status)}>{t.enums.taskStatus[r.status]}</StatusBadge> },
          { key: "actions", header: <span className="sr-only">{t.common.actions}</span>, className: "w-24", cell: (r) => <TaskRowActions id={r.id} status={r.status} /> },
        ]}
      />
      <Pagination page={page} pageSize={PAGE_SIZE} total={count ?? 0} searchParams={sp} basePath="/tasks" t={t} />
    </>
  );
}

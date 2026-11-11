import Link from "next/link";
import { Download, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { DataTable, Pagination } from "@/components/app/data-table";
import { FilterBar } from "@/components/app/filter-bar";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { LeadCreateDialog } from "@/components/crm/lead-create";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { listMembers, peopleOptions } from "@/server/data/members";
import { PAGE_SIZE, leadsQuery, matchingContactIds } from "@/server/data/leads";
import { todayBounds } from "@/server/crm";
import { oneOf, page as pageParam, str, uuid } from "@/lib/search-params";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format.ts";
import { Constants } from "@/types/database";
import { cn } from "@/lib/utils";

const E = Constants.public.Enums;

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const supabase = await createClient();
  const tz = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  const today = todayBounds(tz);
  const page = pageParam(sp);
  const q = str(sp, "q");

  const filters = {
    companyIds: viewer.scopeCompanyIds,
    q,
    status: oneOf(sp, "status", E.lead_status),
    source: oneOf(sp, "source", E.lead_source),
    priority: oneOf(sp, "priority", E.priority_level),
    interest: oneOf(sp, "interest", E.lead_interest),
    offeringId: uuid(sp, "offering"),
    owner: str(sp, "owner"),
    followUp: oneOf(sp, "followup", ["overdue", "today", "upcoming"] as const),
    archived: str(sp, "archived") === "1",
    viewerId: viewer.id,
    todayStart: today.start,
    todayEnd: today.end,
  };
  const contactIds = q ? await matchingContactIds(supabase, q) : null;
  const [{ data, count, error }, members, { data: offeringRows }] = await Promise.all([
    leadsQuery(supabase, filters, contactIds)
      .order("created_at", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    listMembers(supabase, viewer.scopeCompanyIds, { activeOnly: true }),
    supabase.from("company_offerings").select("id, company_id, name").in("company_id", viewer.scopeCompanyIds).order("name"),
  ]);
  if (error) throw error;

  const companyName = new Map(viewer.companies.map((c) => [c.id, c.name]));
  const currencyOf = new Map(viewer.companies.map((c) => [c.id, c.currency]));
  const multi = viewer.scopeCompanyIds.length > 1;
  const people = peopleOptions(members);
  const exportHref = `/api/export/leads?${new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" && k !== "page" ? [[k, v]] : [])),
  ).toString()}`;

  return (
    <>
      <PageHeader
        title={t.nav.leads}
        actions={
          <>
            <Button variant="outline" asChild><Link href="/leads/import"><Upload />{t.common.import}</Link></Button>
            <Button variant="outline" asChild><a href={exportHref}><Download />{t.common.export}</a></Button>
            <LeadCreateDialog
              companies={viewer.companies.filter((c) => viewer.scopeCompanyIds.includes(c.id)).map((c) => ({ value: c.id, label: c.name }))}
              defaultCompanyId={viewer.activeCompany?.id ?? viewer.companies[0]?.id ?? ""}
              ownersByCompany={Object.fromEntries(viewer.scopeCompanyIds.map((id) => [id, peopleOptions(members, id)]))}
              defaultOwnerId={viewer.activeCompany?.role ? viewer.id : null}
              trigger={<Button><Plus />{t.leads.newLead}</Button>}
            />
          </>
        }
      />
      <FilterBar filters={[
        { type: "search", name: "q", placeholder: t.leads.searchPlaceholder },
        { type: "select", name: "status", label: t.common.status, options: E.lead_status.filter((s) => s !== "converted").map((s) => ({ value: s, label: t.enums.leadStatus[s] })) },
        { type: "select", name: "owner", label: t.common.owner, options: [
          { value: "me", label: t.common.me }, { value: "unassigned", label: t.common.unassigned }, ...people,
        ] },
        { type: "select", name: "followup", label: t.leads.followUp, options: [
          { value: "overdue", label: t.leads.followOverdue }, { value: "today", label: t.leads.followToday },
          { value: "upcoming", label: t.leads.followUpcoming },
        ] },
        { type: "select", name: "source", label: t.leads.source, options: E.lead_source.map((s) => ({ value: s, label: t.enums.leadSource[s] })) },
        { type: "select", name: "interest", label: t.autoLeads.filterInterest, options: E.lead_interest.map((s) => ({ value: s, label: t.enums.leadInterest[s] })) },
        { type: "select", name: "offering", label: t.autoLeads.filterOffering,
          options: (offeringRows ?? []).map((o) => ({ value: o.id, label: multi ? `${o.name} · ${companyName.get(o.company_id) ?? ""}` : o.name })) },
        { type: "select", name: "priority", label: t.leads.priority, options: E.priority_level.map((s) => ({ value: s, label: t.enums.priority[s] })) },
        { type: "select", name: "archived", label: t.leads.archived, allLabel: t.common.no, options: [{ value: "1", label: t.common.yes }] },
      ]} />
      <DataTable
        rows={data ?? []}
        rowKey={(r) => r.id}
        empty={{ title: t.leads.empty, description: t.leads.emptyHint }}
        columns={[
          {
            key: "title", header: t.common.title,
            cell: (r) => (
              <div className="flex flex-col items-start">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Link href={`/leads/${r.id}`} className="font-medium text-primary hover:underline">{r.title}</Link>
                  {r.is_sandbox && <StatusBadge tone="warning">{t.common.sandbox}</StatusBadge>}
                </span>
                <span className="text-xs text-muted-foreground">
                  {r.contact?.full_name}
                  {r.contact?.phone_e164 && <> · <span className="ltr-nums">{r.contact.phone_e164}</span></>}
                </span>
              </div>
            ),
          },
          ...(multi ? [{ key: "company", header: t.common.company, cell: (r: NonNullable<typeof data>[number]) => companyName.get(r.company_id) }] : []),
          { key: "status", header: t.common.status, cell: (r) => <StatusBadge tone={toneFor(r.status)}>{t.enums.leadStatus[r.status]}</StatusBadge> },
          { key: "priority", header: t.leads.priority, cell: (r) => <StatusBadge tone={toneFor(r.priority)}>{t.enums.priority[r.priority]}</StatusBadge> },
          { key: "owner", header: t.common.owner, cell: (r) => r.owner?.full_name ?? <span className="text-muted-foreground">{t.common.unassigned}</span> },
          { key: "source", header: t.leads.source, cell: (r) => (r.auto_created ? t.autoLeads.automatic : t.enums.leadSource[r.source]) },
          {
            key: "interest", header: t.autoLeads.interest,
            cell: (r) => <StatusBadge tone={r.interest === "interested" ? "success" : r.interest === "unassessed" || r.interest === "not_interested" ? "neutral" : "warning"}>{t.enums.leadInterest[r.interest]}</StatusBadge>,
          },
          { key: "offering", header: t.autoLeads.offering, cell: (r) => r.offering?.name ?? <span className="text-muted-foreground">—</span> },
          {
            key: "value", header: t.leads.estimatedValue, className: "text-end",
            cell: (r) => <span className="ltr-nums">{r.estimated_value != null ? formatCurrency(r.estimated_value, currencyOf.get(r.company_id) ?? "QAR", locale) : "—"}</span>,
          },
          {
            key: "follow", header: t.leads.nextFollowUp,
            cell: (r) => r.next_follow_up_at
              ? <span className={cn("text-xs", Date.parse(r.next_follow_up_at) < Date.parse(today.start) && "font-medium text-destructive")}>{formatDateTime(r.next_follow_up_at, tz, locale)}</span>
              : "—",
          },
          { key: "created", header: t.common.createdAt, cell: (r) => <span className="text-xs">{formatDate(r.created_at, tz, locale)}</span> },
        ]}
      />
      <Pagination page={page} pageSize={PAGE_SIZE} total={count ?? 0} searchParams={sp} basePath="/leads" t={t} />
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { ScrollText } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Pagination } from "@/components/app/data-table";
import { FilterBar } from "@/components/app/filter-bar";
import { EmptyState } from "@/components/app/states";
import { entityHref } from "@/components/shell/entity-href";
import { getViewer, isAdminOf, isAnyAdmin } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { listMembers, peopleOptions } from "@/server/data/members";
import { zonedLocalToUtc } from "@/lib/dates/zoned.ts";
import { formatDateTime } from "@/lib/format.ts";
import { oneOf, page as pageParam, str, uuid } from "@/lib/search-params";
import { PAGE_SIZE } from "@/server/data/leads";

const ACTIONS = [
  "company.created", "company.updated", "membership.created", "membership.updated", "membership.deleted",
  "user.activated", "user.deactivated", "user.super_admin_granted", "user.super_admin_revoked",
  "team.created", "team.updated", "team.member_added", "team.member_removed",
  "lead.created", "lead.reassigned", "lead.archived", "lead.unarchived",
  "task.completed", "task.reassigned", "contact.merged",
  "conversation.assigned", "conversation.company_changed", "whatsapp.credentials_failed", "whatsapp.credentials_restored",
  "lead.interest_changed", "lead.offering_changed",
] as const;
const ENTITIES = ["company", "company_membership", "profile", "team", "lead", "task", "contact", "conversation", "whatsapp_account"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** Metadata keys that point at a record page; the target page applies its own access check. */
const LINKED: Record<string, string> = { lead_id: "lead", merged_contact_id: "contact", conversation_id: "conversation" };

/**
 * Audit log (append-only). Visible to super admins (everything) and company
 * admins (their companies) — enforced by RLS (audit_select), not by this page.
 */
export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const viewer = await getViewer();
  if (!isAnyAdmin(viewer)) notFound();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const page = pageParam(sp);
  const tz = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";
  const adminCompanies = viewer.companies.filter((c) => viewer.scopeCompanyIds.includes(c.id) && isAdminOf(viewer, c.id));
  const supabase = await createClient();

  let q = supabase.from("audit_logs").select("id, company_id, actor_id, action, entity_type, entity_id, metadata, created_at", { count: "exact" });
  // Company-scoped rows for the selected companies; a super admin in "all
  // companies" mode also sees global rows (profiles, merges).
  q = viewer.isSuperAdmin && !viewer.activeCompany
    ? q
    : q.in("company_id", adminCompanies.map((c) => c.id));
  const action = oneOf(sp, "action", ACTIONS);
  const entity = oneOf(sp, "entity", ENTITIES);
  const actor = uuid(sp, "actor");
  const from = str(sp, "from");
  const to = str(sp, "to");
  if (action) q = q.eq("action", action);
  if (entity) q = q.eq("entity_type", entity);
  if (actor) q = q.eq("actor_id", actor);
  if (from && YMD.test(from)) q = q.gte("created_at", zonedLocalToUtc(`${from}T00:00`, tz) ?? from);
  if (to && YMD.test(to)) q = q.lt("created_at", zonedLocalToUtc(`${to}T00:00`, tz) ? new Date(Date.parse(zonedLocalToUtc(`${to}T00:00`, tz)!) + 86_400_000).toISOString() : to);
  const { data, count, error } = await q.order("id", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error) throw error;

  // Resolve ids in actor_id and metadata to names. Every lookup runs with the
  // viewer's session, so only rows they may see resolve; the rest stay short ids.
  const kindOf = (k: string) =>
    /(^|_)(user_id|owner_id|manager_id)$|^assigned_to$/.test(k) ? "person"
      : k.endsWith("stage_id") ? "stage"
        : k.endsWith("team_id") ? "team"
          : k.endsWith("offering_id") ? "offering"
            : k.endsWith("company_id") ? "company" : null;
  const want = { person: new Set<string>(), stage: new Set<string>(), team: new Set<string>(), offering: new Set<string>() };
  for (const r of data ?? []) {
    if (r.actor_id) want.person.add(r.actor_id);
    for (const [k, v] of Object.entries((r.metadata ?? {}) as Record<string, unknown>)) {
      const kind = kindOf(k);
      if (typeof v === "string" && UUID.test(v) && kind && kind !== "company") want[kind].add(v);
    }
  }
  const [people, stages, teams, offerings, members] = await Promise.all([
    want.person.size ? supabase.from("profiles").select("id, full_name, email").in("id", [...want.person]) : null,
    want.stage.size ? supabase.from("pipeline_stages").select("id, name").in("id", [...want.stage]) : null,
    want.team.size ? supabase.from("teams").select("id, name").in("id", [...want.team]) : null,
    want.offering.size ? supabase.from("company_offerings").select("id, name").in("id", [...want.offering]) : null,
    listMembers(supabase, adminCompanies.map((c) => c.id)),
  ]);
  const names = {
    person: new Map((people?.data ?? []).map((p) => [p.id, p.full_name || p.email || p.id.slice(0, 8)])),
    stage: new Map((stages?.data ?? []).map((s) => [s.id, s.name])),
    team: new Map((teams?.data ?? []).map((s) => [s.id, s.name])),
    offering: new Map((offerings?.data ?? []).map((s) => [s.id, s.name])),
    company: new Map(viewer.companies.map((c) => [c.id, c.name])),
  };
  const actionLabel = (a: string) => (t.audit.actions as Record<string, string>)[a] ?? a;
  const fmtValue = (k: string, v: unknown): string => {
    if (v == null) return "—";
    const kind = kindOf(k);
    if (typeof v === "string" && UUID.test(v)) return (kind && names[kind].get(v)) || v.slice(0, 8);
    if (typeof v === "string" && k.endsWith("role")) return (t.enums.role as Record<string, string>)[v] ?? v;
    if (typeof v === "string" && k.endsWith("interest")) return (t.enums.leadInterest as Record<string, string>)[v] ?? v;
    if (k === "source" && (v === "auto_keyword" || v === "employee")) return v === "auto_keyword" ? t.autoLeads.offeringAuto : t.autoLeads.offeringEmployee;
    if (typeof v === "boolean") return v ? t.common.yes : t.common.no;
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };

  return (
    <>
      <PageHeader title={t.audit.title} description={t.audit.hint} />
      <FilterBar filters={[
        { type: "select", name: "action", label: t.audit.action, options: ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })) },
        { type: "select", name: "entity", label: t.audit.entity, options: ENTITIES.map((e) => ({ value: e, label: (t.audit.entities as Record<string, string>)[e] ?? e })) },
        { type: "select", name: "actor", label: t.audit.actor, options: peopleOptions(members) },
        { type: "date", name: "from", label: t.common.from },
        { type: "date", name: "to", label: t.common.to },
      ]} />
      {(data ?? []).length === 0 ? <EmptyState icon={ScrollText} title={t.common.noResults} /> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                {[t.common.date, t.audit.actor, t.audit.action, t.audit.entity, t.audit.details].map((h) => (
                  <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {(data ?? []).map((r) => {
                const href = entityHref(r.entity_type === "company_membership" ? null : r.entity_type, r.entity_id);
                const meta = Object.entries((r.metadata ?? {}) as Record<string, unknown>);
                return (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{formatDateTime(r.created_at, tz, locale)}</td>
                    <td className="px-3 py-2">{r.actor_id ? names.person.get(r.actor_id) ?? r.actor_id.slice(0, 8) : <span className="text-muted-foreground">{t.audit.system}</span>}</td>
                    <td className="px-3 py-2 font-medium">{actionLabel(r.action)}</td>
                    <td className="px-3 py-2">
                      {(t.audit.entities as Record<string, string>)[r.entity_type] ?? r.entity_type}
                      {href && <> · <Link href={href} className="text-primary hover:underline">{t.common.view}</Link></>}
                      {r.company_id && viewer.scopeCompanyIds.length > 1 && <div className="text-xs text-muted-foreground">{names.company.get(r.company_id)}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {meta.map(([k, v]) => (
                          <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            <span className="text-muted-foreground">{(t.audit.fields as Record<string, string>)[k] ?? k}:</span>{" "}
                            {typeof v === "string" && UUID.test(v) && LINKED[k]
                              ? <Link href={entityHref(LINKED[k], v)!} className="text-primary hover:underline">{t.common.view}</Link>
                              : fmtValue(k, v)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={count ?? 0} searchParams={sp} basePath="/admin/audit" t={t} />
    </>
  );
}

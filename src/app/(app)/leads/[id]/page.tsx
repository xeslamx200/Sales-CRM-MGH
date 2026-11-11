import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarPlus, NotebookPen, Pencil, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailList, PageHeader, Section } from "@/components/app/page-header";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { Timeline } from "@/components/crm/timeline";
import {
  ActivityDialog, ArchiveButton, AssignDialog, CompleteTaskButton, LeadEditDialog, LeadStatusSelect, TaskDialog,
} from "@/components/crm/record-actions";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { leadTimeline } from "@/server/data/timeline";
import { listMembers, peopleOptions } from "@/server/data/members";
import { listAttachments } from "@/server/data/attachments";
import { LeadQualification } from "@/components/crm/lead-qualification";
import { AttachmentList, AttachmentUpload } from "@/components/crm/attachments";
import { companyTz } from "@/server/crm";
import { formatCurrency, formatDateTime } from "@/lib/format.ts";
import { utcToZonedLocal } from "@/lib/dates/zoned.ts";

export default async function LeadPage({ params }: PageProps<"/leads/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const supabase = await createClient();

  const { data: lead } = await supabase.from("leads")
    .select("*, contact:contacts!leads_contact_id_fkey(id, full_name, phone_e164, email), owner:profiles!leads_owner_id_fkey(full_name), creator:profiles!leads_created_by_fkey(full_name)")
    .eq("id", id).maybeSingle();
  if (!lead) notFound(); // RLS: not visible = not found

  const tz = companyTz(viewer, lead.company_id);
  const company = viewer.companies.find((c) => c.id === lead.company_id);
  const [timeline, members, openTasks, attachments, offerings] = await Promise.all([
    leadTimeline(supabase, lead),
    listMembers(supabase, [lead.company_id], { activeOnly: true }),
    supabase.from("tasks").select("id, title, due_at, assigned_to, status").eq("lead_id", id)
      .in("status", ["open", "in_progress"]).order("due_at", { ascending: true, nullsFirst: false }),
    listAttachments(supabase, viewer, "lead", id, tz),
    supabase.from("company_offerings").select("id, name, is_active").eq("company_id", lead.company_id).order("name"),
  ]);
  const people = peopleOptions(members);
  const archived = Boolean(lead.archived_at);

  return (
    <>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{lead.title}
          <StatusBadge tone={toneFor(lead.status)}>{t.enums.leadStatus[lead.status]}</StatusBadge>
          {archived && <StatusBadge>{t.leads.archivedBadge}</StatusBadge>}
          {lead.is_sandbox && <StatusBadge tone="warning">{t.common.sandbox}</StatusBadge>}
        </span>}
        description={<>
          {company?.name} · <Link href={`/contacts/${lead.contact?.id}`} className="text-primary hover:underline">{lead.contact?.full_name}</Link>
        </>}
        actions={!archived && (
          <>
            <LeadStatusSelect leadId={lead.id} status={lead.status} />
            <AssignDialog id={lead.id} ownerId={lead.owner_id} options={people}
              trigger={<Button variant="outline" size="sm"><UserCog />{t.common.assign}</Button>} />
            <ActivityDialog companyId={lead.company_id} leadId={lead.id} contactId={lead.contact_id}
              trigger={<Button variant="outline" size="sm"><NotebookPen />{t.records.logActivity}</Button>} />
            <TaskDialog companyId={lead.company_id} leadId={lead.id} contactId={lead.contact_id}
              assignees={{ [lead.company_id]: people }} defaultAssignee={lead.owner_id ?? viewer.id}
              trigger={<Button variant="outline" size="sm"><CalendarPlus />{t.records.newTask}</Button>} />
          </>
        )}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title={t.timeline.title} className="lg:col-span-2">
          <Timeline items={timeline} t={t} locale={locale} tz={tz} />
        </Section>
        <div className="flex flex-col gap-4">
          <Section
            title={t.common.details}
            actions={!archived && (
              <LeadEditDialog
                lead={{
                  id: lead.id, title: lead.title, source: lead.source, campaign: lead.campaign, referralSource: lead.referral_source,
                  priority: lead.priority, estimatedValue: lead.estimated_value,
                  nextFollowUpAt: utcToZonedLocal(lead.next_follow_up_at, tz), notes: lead.notes,
                }}
                trigger={<Button variant="ghost" size="icon-sm" aria-label={t.common.edit}><Pencil /></Button>}
              />
            )}
          >
            <DetailList items={[
              { label: t.common.phone, value: lead.contact?.phone_e164 ? <span className="ltr-nums">{lead.contact.phone_e164}</span> : null },
              { label: t.common.email, value: lead.contact?.email ? <span dir="ltr">{lead.contact.email}</span> : null },
              { label: t.common.owner, value: lead.owner?.full_name ?? t.common.unassigned },
              { label: t.common.createdBy, value: lead.auto_created ? t.autoLeads.automatic : lead.creator?.full_name },
              { label: t.leads.priority, value: <StatusBadge tone={toneFor(lead.priority)}>{t.enums.priority[lead.priority]}</StatusBadge> },
              { label: t.leads.source, value: lead.auto_created ? t.autoLeads.automatic : t.enums.leadSource[lead.source] },
              { label: t.leads.campaign, value: lead.campaign },
              { label: t.leads.estimatedValue, value: lead.estimated_value != null ? <span className="ltr-nums">{formatCurrency(lead.estimated_value, company?.currency ?? "QAR", locale)}</span> : null },
              { label: t.leads.nextFollowUp, value: lead.next_follow_up_at ? formatDateTime(lead.next_follow_up_at, tz, locale) : null },
              { label: t.leads.firstContacted, value: lead.first_contacted_at ? formatDateTime(lead.first_contacted_at, tz, locale) : null },
              { label: t.leads.lastActivity, value: lead.last_activity_at ? formatDateTime(lead.last_activity_at, tz, locale) : null },
              { label: t.common.createdAt, value: formatDateTime(lead.created_at, tz, locale) },
            ]} />
            {lead.notes && <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-2 text-sm">{lead.notes}</p>}
          </Section>
          <Section title={t.autoLeads.leadPanel + " · " + t.autoLeads.interest}>
            <LeadQualification
              idPrefix="lead"
              leadId={lead.id}
              interest={lead.interest}
              offeringId={lead.offering_id}
              offeringSource={lead.offering_source as "auto_keyword" | "employee" | null}
              offerings={(offerings.data ?? []).map((o) => ({ value: o.id, label: o.name, active: o.is_active }))}
              disabled={archived}
            />
            {lead.conversation_id && (
              <p className="mt-3 text-xs">
                <Link href={`/inbox?c=${lead.conversation_id}`} className="text-primary hover:underline">{t.autoLeads.openConversation}</Link>
              </p>
            )}
          </Section>
          <Section title={t.records.openTasks}>
            {(openTasks.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.records.noOpenTasks}</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {(openTasks.data ?? []).map((task) => (
                  <li key={task.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{task.title}</p>
                      <p className="text-xs text-muted-foreground">{task.due_at ? formatDateTime(task.due_at, tz, locale) : t.records.noDueDate}</p>
                    </div>
                    <CompleteTaskButton taskId={task.id} size="icon-sm" />
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={t.attachments.title} actions={!archived && <AttachmentUpload entityType="lead" entityId={lead.id} />}>
            <AttachmentList items={attachments} />
          </Section>
          <div className="flex justify-end">
            <ArchiveButton id={lead.id} archived={archived} />
          </div>
        </div>
      </div>
    </>
  );
}

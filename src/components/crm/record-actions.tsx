"use client";
import { useMemo, useTransition } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError, SelectField, SubmitButton, TextareaField, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { ConfirmDialog, FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import {
  activitySchema, assignSchema, leadUpdateSchema, taskCompleteSchema, taskCreateSchema,
} from "@/schemas/crm";
import { archiveLead, assignLead, setLeadStatus, updateLead } from "@/actions/leads";
import { completeTask, createTask, logActivity } from "@/actions/work";
import { Constants, type Enums } from "@/types/database";
import type { ActionResult } from "@/types/action";

const E = Constants.public.Enums;

// ------------------------------------------------------------------ status
export function LeadStatusSelect({ leadId, status, disabled }: { leadId: string; status: Enums<"lead_status">; disabled?: boolean }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const options = E.lead_status.filter((s) => s !== "converted");
  return (
    <Select
      value={status}
      disabled={disabled || pending || status === "converted"}
      onValueChange={(v) =>
        start(async () => {
          const res = await setLeadStatus({ id: leadId, status: v as Exclude<Enums<"lead_status">, "converted"> });
          if (!res.ok) toast.error(res.error);
        })
      }
    >
      <SelectTrigger size="sm" className="w-40" aria-label={t.common.status}><SelectValue /></SelectTrigger>
      <SelectContent>
        {status === "converted" && <SelectItem value="converted">{t.enums.leadStatus.converted}</SelectItem>}
        {options.map((s) => <SelectItem key={s} value={s}>{t.enums.leadStatus[s]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ------------------------------------------------------------------ assign
export function AssignDialog({
  id, ownerId, options, trigger, action = assignLead, withReason = true,
}: {
  id: string; ownerId: string | null; options: Option[]; trigger: React.ReactNode;
  action?: (input: { id: string; ownerId: string | null; reason?: string | null }) => Promise<ActionResult<null>>;
  withReason?: boolean;
}) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.common.assign} description={t.records.assignHint}>
      {(close) => <AssignForm id={id} ownerId={ownerId} options={options} action={action} withReason={withReason} onDone={close} />}
    </FormDialog>
  );
}

function AssignForm({
  id, ownerId, options, action, withReason, onDone,
}: {
  id: string; ownerId: string | null; options: Option[]; withReason: boolean; onDone: () => void;
  action: (input: { id: string; ownerId: string | null; reason?: string | null }) => Promise<ActionResult<null>>;
}) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: assignSchema,
    defaultValues: { id, ownerId, reason: "" },
    action,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <SelectField control={form.control} name="ownerId" label={t.common.owner} options={options} emptyLabel={t.common.unassigned} />
        {withReason && <TextareaField control={form.control} name="reason" label={t.common.reason} rows={2} />}
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

// ---------------------------------------------------------------- activity
export function ActivityDialog({
  companyId, leadId, contactId, trigger,
}: { companyId: string; leadId?: string; contactId?: string; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.records.logActivity}>
      {(close) => <ActivityForm companyId={companyId} leadId={leadId} contactId={contactId} onDone={close} />}
    </FormDialog>
  );
}

function ActivityForm({
  companyId, leadId, contactId, onDone,
}: { companyId: string; leadId?: string; contactId?: string; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: activitySchema,
    defaultValues: {
      companyId, leadId: leadId ?? null, contactId: contactId ?? null,
      type: "note", occurredAt: "", durationMinutes: null, outcome: "", body: "",
    },
    action: logActivity,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField control={form.control} name="type" label={t.records.activityType}
            options={E.activity_type.filter((a) => a !== "whatsapp" && a !== "call").map((a) => ({ value: a, label: t.enums.activityType[a] }))} />
          <TextField control={form.control} name="occurredAt" type="datetime-local" label={t.records.occurredAt} dir="ltr"
            description={t.records.occurredAtHint} />
          <TextField control={form.control} name="durationMinutes" type="number" label={t.records.durationMinutes} dir="ltr" />
          <TextField control={form.control} name="outcome" label={t.records.outcome} />
        </div>
        <TextareaField control={form.control} name="body" label={t.common.notes} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

// ------------------------------------------------------------------- tasks
export function TaskDialog({
  companyId, companies, leadId, contactId, assignees, defaultAssignee, trigger,
}: {
  companyId: string; companies?: Option[]; leadId?: string; contactId?: string;
  assignees: Record<string, Option[]>; defaultAssignee: string; trigger: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.records.newTask}>
      {(close) => (
        <TaskForm companyId={companyId} companies={companies} leadId={leadId} contactId={contactId}
          assignees={assignees} defaultAssignee={defaultAssignee} onDone={close} />
      )}
    </FormDialog>
  );
}

function TaskForm({
  companyId, companies, leadId, contactId, assignees, defaultAssignee, onDone,
}: {
  companyId: string; companies?: Option[]; leadId?: string; contactId?: string;
  assignees: Record<string, Option[]>; defaultAssignee: string; onDone: () => void;
}) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: taskCreateSchema,
    defaultValues: {
      companyId, title: "", description: "", dueAt: "", priority: "medium", assignedTo: defaultAssignee,
      leadId: leadId ?? null, contactId: contactId ?? null,
    },
    action: createTask,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  const current = form.watch("companyId");
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        {companies && companies.length > 1 && <SelectField control={form.control} name="companyId" label={t.common.company} options={companies} />}
        <TextField control={form.control} name="title" label={t.common.title} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField control={form.control} name="dueAt" type="datetime-local" label={t.records.dueAt} dir="ltr" />
          <SelectField control={form.control} name="priority" label={t.leads.priority}
            options={E.priority_level.map((p) => ({ value: p, label: t.enums.priority[p] }))} />
          <SelectField control={form.control} name="assignedTo" label={t.records.assignee} options={assignees[current] ?? []}
            emptyLabel={t.common.unassigned} className="sm:col-span-2" />
        </div>
        <TextareaField control={form.control} name="description" label={t.common.description} rows={2} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

export function CompleteTaskButton({ taskId, size = "sm" }: { taskId: string; size?: "sm" | "icon-sm" }) {
  const { t } = useI18n();
  return (
    <FormDialog
      trigger={
        <Button variant="outline" size={size} aria-label={t.records.complete}>
          <Check />{size === "sm" && t.records.complete}
        </Button>
      }
      title={t.records.completeTask}
      description={t.records.completeHint}
    >
      {(close) => <CompleteForm taskId={taskId} onDone={close} />}
    </FormDialog>
  );
}

function CompleteForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: taskCompleteSchema,
    defaultValues: { id: taskId, outcome: "" },
    action: completeTask,
    successMessage: t.records.taskDone,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextareaField control={form.control} name="outcome" label={t.records.outcome} rows={3} />
        <DialogFooter><SubmitButton pending={pending}>{t.records.complete}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

// ---------------------------------------------------------------- convert
// -------------------------------------------------------------- edit lead
type LeadEdit = {
  id: string; title: string; source: Enums<"lead_source">; campaign: string | null; referralSource: string | null;
  priority: Enums<"priority_level">; estimatedValue: number | null; nextFollowUpAt: string; notes: string | null;
};

export function LeadEditDialog({ lead, trigger }: { lead: LeadEdit; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.leads.editLead} className="sm:max-w-2xl">
      {(close) => <LeadEditForm lead={lead} onDone={close} />}
    </FormDialog>
  );
}

function LeadEditForm({ lead, onDone }: { lead: LeadEdit; onDone: () => void }) {
  const { t } = useI18n();
  const defaults = useMemo(() => ({ ...lead, estimatedValue: lead.estimatedValue ?? "" }), [lead]);
  const { form, submit, pending } = useActionForm({
    schema: leadUpdateSchema,
    defaultValues: defaults,
    action: updateLead,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="title" label={t.common.title} />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField control={form.control} name="source" label={t.leads.source}
            options={E.lead_source.map((s) => ({ value: s, label: t.enums.leadSource[s] }))} />
          <TextField control={form.control} name="campaign" label={t.leads.campaign} />
          <TextField control={form.control} name="referralSource" label={t.leads.referral} />
          <SelectField control={form.control} name="priority" label={t.leads.priority}
            options={E.priority_level.map((s) => ({ value: s, label: t.enums.priority[s] }))} />
          <TextField control={form.control} name="estimatedValue" label={t.leads.estimatedValue} inputMode="decimal" dir="ltr" />
          <TextField control={form.control} name="nextFollowUpAt" type="datetime-local" label={t.leads.nextFollowUp} dir="ltr" />
        </div>
        <TextareaField control={form.control} name="notes" label={t.common.notes} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

export function ArchiveButton({
  id, archived, action = archiveLead,
}: { id: string; archived: boolean; action?: (i: { id: string; archived: boolean }) => Promise<ActionResult<null>> }) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      trigger={<Button variant="outline" size="sm">{archived ? <ArchiveRestore /> : <Archive />}{archived ? t.common.unarchive : t.common.archive}</Button>}
      title={archived ? t.common.unarchive : t.common.archive}
      description={archived ? t.records.unarchiveHint : t.records.archiveHint}
      destructive={!archived}
      onConfirm={() => action({ id, archived: !archived })}
      successMessage={t.common.saved}
    />
  );
}

"use client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { FormError, SelectField, SubmitButton, TextareaField, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { leadCreateSchema } from "@/schemas/crm";
import { createLead } from "@/actions/leads";
import { Constants } from "@/types/database";
import { fmt } from "@/i18n";

const E = Constants.public.Enums;

export function LeadCreateDialog({
  companies, defaultCompanyId, ownersByCompany, defaultOwnerId, trigger,
}: { companies: Option[]; defaultCompanyId: string; ownersByCompany: Record<string, Option[]>; defaultOwnerId: string | null; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.leads.newLead} className="sm:max-w-2xl">
      {(close) => <LeadCreateForm companies={companies} defaultCompanyId={defaultCompanyId} ownersByCompany={ownersByCompany} defaultOwnerId={defaultOwnerId} onDone={close} />}
    </FormDialog>
  );
}

function LeadCreateForm({
  companies, defaultCompanyId, ownersByCompany, defaultOwnerId, onDone,
}: { companies: Option[]; defaultCompanyId: string; ownersByCompany: Record<string, Option[]>; defaultOwnerId: string | null; onDone: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const { form, submit, pending } = useActionForm({
    schema: leadCreateSchema,
    defaultValues: {
      companyId: defaultCompanyId, fullName: "", phone: "", email: "", title: "", source: "phone", campaign: "",
      priority: "medium", estimatedValue: "", ownerId: defaultOwnerId, nextFollowUpAt: "", notes: "",
    },
    action: createLead,
    onSuccess: (r) => {
      if (r.matchedExisting && r.openLeads > 1) toast.warning(fmt(t.leads.existingOpenLeads, { count: r.openLeads - 1 }));
      else if (r.matchedExisting) toast.info(t.leads.linkedExistingContact);
      else toast.success(t.leads.created);
      onDone();
      router.push(`/leads/${r.leadId}`);
    },
  });
  const companyId = form.watch("companyId");
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        {companies.length > 1 && <SelectField control={form.control} name="companyId" label={t.common.company} options={companies} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField control={form.control} name="fullName" label={t.leads.contactName} />
          <TextField control={form.control} name="phone" type="tel" label={t.common.phone} placeholder="+974 5555 0001"
            description={t.leads.phoneHint} />
          <TextField control={form.control} name="email" type="email" label={t.common.email} />
          <TextField control={form.control} name="title" label={t.common.title} description={t.leads.titleHint} />
          <SelectField control={form.control} name="source" label={t.leads.source}
            options={E.lead_source.filter((s) => s !== "import").map((s) => ({ value: s, label: t.enums.leadSource[s] }))} />
          <TextField control={form.control} name="campaign" label={t.leads.campaign} />
          <SelectField control={form.control} name="priority" label={t.leads.priority}
            options={E.priority_level.map((s) => ({ value: s, label: t.enums.priority[s] }))} />
          <TextField control={form.control} name="estimatedValue" label={t.leads.estimatedValue} inputMode="decimal" dir="ltr" />
          <SelectField control={form.control} name="ownerId" label={t.common.owner} options={ownersByCompany[companyId] ?? []}
            emptyLabel={t.common.unassigned} description={t.leads.ownerHint} />
          <TextField control={form.control} name="nextFollowUpAt" type="datetime-local" label={t.leads.nextFollowUp} dir="ltr" />
        </div>
        <TextareaField control={form.control} name="notes" label={t.common.notes} />
        <DialogFooter>
          <SubmitButton pending={pending}>{t.common.create}</SubmitButton>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

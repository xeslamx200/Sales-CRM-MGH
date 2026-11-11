"use client";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { CheckboxField, FormError, SubmitButton, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { companySchema } from "@/schemas/admin";
import { saveCompany } from "@/actions/admin";

type Company = { id?: string; name: string; slug: string; timezone: string; currency: string; isActive: boolean; isSandbox?: boolean };

export function CompanyDialog({ company, superAdmin, trigger }: { company?: Company; superAdmin: boolean; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={company ? t.admin.editCompany : t.admin.newCompany}>
      {(close) => <CompanyForm company={company} superAdmin={superAdmin} onDone={close} />}
    </FormDialog>
  );
}

function CompanyForm({ company, superAdmin, onDone }: { company?: Company; superAdmin: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: companySchema,
    defaultValues: company ? { ...company, isSandbox: company.isSandbox ?? false } : { name: "", slug: "", timezone: "Asia/Qatar", currency: "QAR", isActive: true, isSandbox: false },
    action: saveCompany,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="name" label={t.common.name} />
        <TextField control={form.control} name="slug" label={t.admin.slug} dir="ltr" disabled={!superAdmin}
          description={t.admin.slugHint} />
        <div className="grid grid-cols-2 gap-3">
          <TextField control={form.control} name="timezone" label={t.admin.timezone} dir="ltr" description={t.admin.timezoneHint} />
          <TextField control={form.control} name="currency" label={t.admin.currency} dir="ltr" />
        </div>
        <CheckboxField control={form.control} name="isActive" label={t.common.active} disabled={!superAdmin} />
        {/* Chosen at creation only: a sandbox company can never become a real one (and vice versa). */}
        {!company && superAdmin && (
          <CheckboxField control={form.control} name="isSandbox" label={t.admin.sandboxCompany} description={t.admin.sandboxCompanyHint} />
        )}
        <DialogFooter>
          <SubmitButton pending={pending}>{t.common.save}</SubmitButton>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

"use client";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { CheckboxField, FormError, SelectField, SubmitButton, TextareaField, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { saveOffering } from "@/actions/offerings";
import { offeringSchema } from "@/schemas/admin";
import { Constants, type Enums } from "@/types/database";

type Offering = { id: string; companyId: string; name: string; kind: Enums<"offering_kind">; keywords: string; priceEgp: string; isActive: boolean };

export function OfferingDialog({ companies, offering, trigger }: { companies: Option[]; offering?: Offering; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={offering ? t.offerings.editOffering : t.offerings.newOffering} description={t.offerings.keywordsHint}>
      {(close) => <OfferingForm companies={companies} offering={offering} onDone={close} />}
    </FormDialog>
  );
}

function OfferingForm({ companies, offering, onDone }: { companies: Option[]; offering?: Offering; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: offeringSchema,
    defaultValues: offering ?? { companyId: companies[0]?.value ?? "", name: "", kind: "course", keywords: "", priceEgp: "", isActive: true },
    action: saveOffering,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  const kinds = Constants.public.Enums.offering_kind.map((k) => ({ value: k, label: t.enums.offeringKind[k] }));
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        {companies.length > 1 && !offering && <SelectField control={form.control} name="companyId" label={t.common.company} options={companies} />}
        <TextField control={form.control} name="name" label={t.common.name} />
        <SelectField control={form.control} name="kind" label={t.offerings.kind} options={kinds} />
        <TextField control={form.control} name="priceEgp" label={t.offerings.price} description={t.offerings.priceHint} inputMode="decimal" dir="ltr" />
        <TextareaField control={form.control} name="keywords" label={t.offerings.keywords} rows={4} />
        <CheckboxField control={form.control} name="isActive" label={t.common.active} description={t.offerings.inactiveNote} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

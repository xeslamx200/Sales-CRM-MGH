"use client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { FormError, SelectField, SubmitButton, TextareaField, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { contactCompanySchema, contactCreateSchema, contactUpdateSchema } from "@/schemas/crm";
import { createContact, updateContact, updateContactCompany } from "@/actions/contacts";
import { Constants, type Enums } from "@/types/database";
import { fmt } from "@/i18n";

export function ContactCreateDialog({
  companies, defaultCompanyId, trigger,
}: { companies: Option[]; defaultCompanyId: string; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.contacts.newContact} description={t.contacts.newContactHint}>
      {(close) => <ContactCreateForm companies={companies} defaultCompanyId={defaultCompanyId} onDone={close} />}
    </FormDialog>
  );
}

function ContactCreateForm({ companies, defaultCompanyId, onDone }: { companies: Option[]; defaultCompanyId: string; onDone: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const { form, submit, pending } = useActionForm({
    schema: contactCreateSchema,
    defaultValues: { companyId: defaultCompanyId, fullName: "", phone: "", email: "" },
    action: createContact,
    onSuccess: (r) => {
      if (r.matchedExisting) toast.info(t.contacts.linkedExisting);
      else if (r.possibleDuplicates > 0) toast.warning(fmt(t.contacts.possibleDuplicates, { count: r.possibleDuplicates }));
      else toast.success(t.common.saved);
      onDone();
      router.push(`/contacts/${r.contactId}`);
    },
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        {companies.length > 1 && <SelectField control={form.control} name="companyId" label={t.common.company} options={companies} />}
        <TextField control={form.control} name="fullName" label={t.common.fullName} />
        <TextField control={form.control} name="phone" type="tel" label={t.common.phone} placeholder="+974 5555 0001" description={t.leads.phoneHint} />
        <TextField control={form.control} name="email" type="email" label={t.common.email} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.create}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

type Identity = { id: string; fullName: string; phone: string | null; email: string | null };

export function ContactEditDialog({ contact, trigger }: { contact: Identity; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.contacts.editIdentity} description={t.contacts.identityHint}>
      {(close) => <ContactEditForm contact={contact} onDone={close} />}
    </FormDialog>
  );
}

function ContactEditForm({ contact, onDone }: { contact: Identity; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: contactUpdateSchema,
    defaultValues: { id: contact.id, fullName: contact.fullName, phone: contact.phone ?? "", email: contact.email ?? "" },
    action: updateContact,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="fullName" label={t.common.fullName} />
        <TextField control={form.control} name="phone" type="tel" label={t.common.phone} description={t.contacts.phoneChangeHint} />
        <TextField control={form.control} name="email" type="email" label={t.common.email} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

type Link = { id: string; relationship: Enums<"contact_relationship">; ownerId: string | null; notes: string | null };

export function ContactCompanyDialog({ link, owners, companyName, trigger }: { link: Link; owners: Option[]; companyName: string; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.contacts.companyRelationship} description={companyName}>
      {(close) => <ContactCompanyForm link={link} owners={owners} onDone={close} />}
    </FormDialog>
  );
}

function ContactCompanyForm({ link, owners, onDone }: { link: Link; owners: Option[]; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: contactCompanySchema,
    defaultValues: { id: link.id, relationship: link.relationship, ownerId: link.ownerId, notes: link.notes ?? "" },
    action: updateContactCompany,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <SelectField control={form.control} name="relationship" label={t.contacts.relationship}
          options={Constants.public.Enums.contact_relationship.map((r) => ({ value: r, label: t.enums.relationship[r] }))} />
        <SelectField control={form.control} name="ownerId" label={t.common.owner} options={owners} emptyLabel={t.common.unassigned} />
        <TextareaField control={form.control} name="notes" label={t.contacts.companyNotes} description={t.contacts.companyNotesHint} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

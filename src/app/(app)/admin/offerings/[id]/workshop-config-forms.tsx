"use client";
import { useRouter } from "next/navigation";
import { FieldGroup } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { CheckboxField, FormError, SelectField, SubmitButton, TextareaField, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { ConfirmDialog, FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { deactivateWorkshopPrice, saveWorkshopGroup, setWorkshopPrice } from "@/actions/workshop-config";
import { workshopGroupSchema, workshopPriceSchema } from "@/schemas/workshops";
import { WORKSHOP_COUNTRIES, WORKSHOP_CURRENCIES } from "@/lib/workshop-config.ts";

type Price = { country: string; attendance: "online" | "offline"; currency: string; price: string };

export function PriceDialog({ offeringId, price, trigger }: { offeringId: string; price?: Price; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={price ? t.workshopConfig.editPrice : t.workshopConfig.setPrice} description={t.workshopConfig.pricesHint}>
      {(close) => <PriceForm offeringId={offeringId} price={price} onDone={close} />}
    </FormDialog>
  );
}

function PriceForm({ offeringId, price, onDone }: { offeringId: string; price?: Price; onDone: () => void }) {
  const { t, locale } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: workshopPriceSchema,
    defaultValues: price ? { offeringId, ...price } : { offeringId, country: "QA", attendance: "online", currency: "QAR", price: "" },
    action: setWorkshopPrice,
    successMessage: t.workshopConfig.saved,
    onSuccess: onDone,
  });
  const countries = WORKSHOP_COUNTRIES.map((c) => ({ value: c.code, label: `${c[locale]} (${c.code})` }));
  const currencies = WORKSHOP_CURRENCIES.map((c) => ({ value: c, label: c }));
  const attendances = [{ value: "online", label: t.workshopConfig.online }, { value: "offline", label: t.workshopConfig.offline }];
  const fixed = Boolean(price);   // an existing combination is edited by its price / currency only
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <SelectField control={form.control} name="country" label={t.workshopConfig.country} options={countries} disabled={fixed} />
        <SelectField control={form.control} name="attendance" label={t.workshopConfig.attendance} options={attendances} disabled={fixed} />
        <SelectField control={form.control} name="currency" label={t.workshopConfig.currency} options={currencies} />
        <TextField control={form.control} name="price" label={t.workshopConfig.price} inputMode="decimal" dir="ltr" />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

export function DeactivatePriceButton({ offeringId, country, attendance, currency }: { offeringId: string; country: string; attendance: "online" | "offline"; currency: string }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={<Button variant="ghost" size="xs">{t.workshopConfig.deactivate}</Button>}
      title={t.workshopConfig.deactivateTitle} description={t.workshopConfig.deactivateHint} confirmLabel={t.workshopConfig.deactivate}
      successMessage={t.workshopConfig.deactivated}
      onConfirm={async () => { const r = await deactivateWorkshopPrice({ offeringId, country, attendance, currency }); if (r.ok) router.refresh(); return r; }}
    />
  );
}

type Group = { id: string; name: string; sessions: string; capacity: string; attendance: "" | "online" | "offline"; isActive: boolean };

export function GroupDialog({ offeringId, group, trigger }: { offeringId: string; group?: Group; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={group ? t.workshopConfig.editGroup : t.workshopConfig.newGroup} description={t.workshopConfig.groupsHint}>
      {(close) => <GroupForm offeringId={offeringId} group={group} onDone={close} />}
    </FormDialog>
  );
}

function GroupForm({ offeringId, group, onDone }: { offeringId: string; group?: Group; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: workshopGroupSchema,
    defaultValues: group ? { offeringId, ...group } : { offeringId, name: "", sessions: "", capacity: "", attendance: "", isActive: true },
    action: saveWorkshopGroup,
    successMessage: t.workshopConfig.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="name" label={t.workshopConfig.groupName} />
        <TextareaField control={form.control} name="sessions" label={t.workshopConfig.sessions} description={t.workshopConfig.sessionsHint} rows={4} />
        <TextField control={form.control} name="capacity" label={t.workshopConfig.capacity} description={t.workshopConfig.capacityHint} inputMode="numeric" dir="ltr" />
        <SelectField control={form.control} name="attendance" label={t.workshopConfig.attendance} emptyLabel={t.workshopConfig.anyAttendance}
          options={[{ value: "online", label: t.workshopConfig.online }, { value: "offline", label: t.workshopConfig.offline }]} />
        <CheckboxField control={form.control} name="isActive" label={t.common.active} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

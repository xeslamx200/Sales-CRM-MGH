"use client";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { FormError, SelectField, SubmitButton, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { targetSchema } from "@/schemas/crm";
import { createTarget } from "@/actions/reports";
import { Constants } from "@/types/database";

export function TargetDialog({
  companyId, people, teams, trigger,
}: { companyId: string; people: Option[]; teams: Option[]; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.reports.newTarget} description={t.reports.targetHint}>
      {(close) => <TargetForm companyId={companyId} people={people} teams={teams} onDone={close} />}
    </FormDialog>
  );
}

function monthBounds() {
  const d = new Date();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function TargetForm({ companyId, people, teams, onDone }: { companyId: string; people: Option[]; teams: Option[]; onDone: () => void }) {
  const { t } = useI18n();
  const month = monthBounds();
  const { form, submit, pending } = useActionForm({
    schema: targetSchema,
    defaultValues: {
      companyId, metric: "collected_egp", scope: "user", teamId: null, userId: null,
      periodStart: month.start, periodEnd: month.end, targetValue: "",
    },
    action: createTarget,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  const scope = form.watch("scope");
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <SelectField control={form.control} name="metric" label={t.reports.metric}
          options={Constants.public.Enums.target_metric.filter((m) => !["calls_logged", "won_revenue", "deals_won"].includes(m)).map((m) => ({ value: m, label: t.enums.targetMetric[m] }))} />
        <SelectField control={form.control} name="scope" label={t.reports.targetFor} options={[
          { value: "user", label: t.reports.employee }, { value: "team", label: t.common.team },
          { value: "company", label: t.reports.wholeCompany },
        ]} />
        {scope === "user" && <SelectField control={form.control} name="userId" label={t.reports.employee} options={people} />}
        {scope === "team" && <SelectField control={form.control} name="teamId" label={t.common.team} options={teams} />}
        <div className="grid grid-cols-2 gap-3">
          <TextField control={form.control} name="periodStart" type="date" label={t.common.from} dir="ltr" />
          <TextField control={form.control} name="periodEnd" type="date" label={t.common.to} dir="ltr" />
        </div>
        <TextField control={form.control} name="targetValue" label={t.reports.targetValue} inputMode="decimal" dir="ltr" />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

"use client";
import { z } from "zod";
import { BellPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FormError, SubmitButton, TextareaField } from "@/components/form/fields";
import { SingleDateField } from "@/components/form/multi-date-field";
import { useActionForm } from "@/components/form/use-action-form";
import { FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { createTask } from "@/actions/work";

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  note: z.string().trim().max(1000).optional(),
});

/**
 * "Remind me to follow up on this customer on day X": a task for me with that day and time (the company's clock), linked to the lead / customer.
 * When the time comes it pops up on the site (RemindersWatcher) and the notification bell tells me too.
 */
export function ReminderDialog({ companyId, leadId, contactId, name, size = "sm" }: { companyId: string; leadId?: string; contactId?: string; name: string; size?: "sm" | "xs" }) {
  const { t } = useI18n();
  const r = t.reminders;
  return (
    <FormDialog trigger={<Button variant="outline" size={size} data-testid="remind-me"><BellPlus />{r.remindMe}</Button>} title={r.title} description={r.hint}>
      {(close) => <ReminderForm companyId={companyId} leadId={leadId} contactId={contactId} name={name} onDone={close} />}
    </FormDialog>
  );
}

function ReminderForm({ companyId, leadId, contactId, name, onDone }: { companyId: string; leadId?: string; contactId?: string; name: string; onDone: () => void }) {
  const { t } = useI18n();
  const r = t.reminders;
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { date: "", time: "10:00", note: "" },
    action: async (v) => createTask({
      companyId, title: `${r.followUp}: ${name}`.slice(0, 200), description: v.note ?? null, dueAt: `${v.date}T${v.time}`, priority: "medium",
      assignedTo: null, leadId: leadId ?? null, contactId: contactId ?? null,
    }),
    successMessage: r.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <SingleDateField control={form.control} name="date" label={r.day} min={today} />
        {form.formState.errors.date && <p className="text-sm text-destructive" role="alert">{r.dayRequired}</p>}
        <Field>
          <FieldLabel htmlFor="reminder-time">{r.time}</FieldLabel>
          <Input id="reminder-time" type="time" dir="ltr" {...form.register("time")} />
        </Field>
        <TextareaField control={form.control} name="note" label={r.note} rows={2} />
        <SubmitButton pending={pending}>{r.save}</SubmitButton>
      </FieldGroup>
    </form>
  );
}

"use client";
import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckboxField, FormError, SelectField, SubmitButton, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { ConfirmDialog, FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { teamSchema } from "@/schemas/admin";
import { addTeamMember, removeTeamMember, saveTeam } from "@/actions/admin";
import { fmt } from "@/i18n";

type Team = { id?: string; companyId: string; name: string; managerId: string | null; isActive: boolean };

export function TeamDialog({
  team, companies, managersByCompany, trigger,
}: { team?: Team; companies: Option[]; managersByCompany: Record<string, Option[]>; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={team ? t.admin.editTeam : t.admin.newTeam}>
      {(close) => <TeamForm team={team} companies={companies} managersByCompany={managersByCompany} onDone={close} />}
    </FormDialog>
  );
}

function TeamForm({
  team, companies, managersByCompany, onDone,
}: { team?: Team; companies: Option[]; managersByCompany: Record<string, Option[]>; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: teamSchema,
    defaultValues: team ?? { companyId: companies[0]?.value ?? "", name: "", managerId: null, isActive: true },
    action: saveTeam,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  const companyId = form.watch("companyId");
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        {!team && companies.length > 1 && (
          <SelectField control={form.control} name="companyId" label={t.common.company} options={companies} />
        )}
        <TextField control={form.control} name="name" label={t.common.name} />
        <SelectField control={form.control} name="managerId" label={t.admin.manager}
          options={managersByCompany[companyId] ?? []} emptyLabel={t.common.none} description={t.admin.managerHint} />
        <CheckboxField control={form.control} name="isActive" label={t.common.active} />
        <DialogFooter>
          <SubmitButton pending={pending}>{t.common.save}</SubmitButton>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

export function AddMemberForm({ teamId, companyId, options }: { teamId: string; companyId: string; options: Option[] }) {
  const { t } = useI18n();
  const [userId, setUserId] = useState("");
  const [pending, start] = useTransition();
  if (options.length === 0) return null;
  return (
    <div className="flex gap-2">
      <Select value={userId} onValueChange={setUserId}>
        <SelectTrigger size="sm" className="flex-1" aria-label={t.admin.addMember}>
          <SelectValue placeholder={t.admin.addMember} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={!userId || pending}
        onClick={() =>
          start(async () => {
            const res = await addTeamMember({ teamId, companyId, userId });
            if (res.ok) setUserId("");
            else toast.error(res.error);
          })
        }
      >
        <Plus />
        {t.common.add}
      </Button>
    </div>
  );
}

export function RemoveMemberButton({ teamId, companyId, userId, name }: { teamId: string; companyId: string; userId: string; name: string }) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      trigger={<Button variant="ghost" size="icon-xs" aria-label={t.admin.removeMember}><X /></Button>}
      title={t.admin.removeMember}
      description={fmt(t.admin.removeMemberConfirm, { name })}
      destructive
      onConfirm={() => removeTeamMember({ teamId, companyId, userId })}
    />
  );
}

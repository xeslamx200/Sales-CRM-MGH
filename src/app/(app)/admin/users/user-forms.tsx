"use client";
import { Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { CheckboxField, FormError, SelectField, SubmitButton, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { ConfirmDialog, FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { inviteSchema, membershipUpdateSchema } from "@/schemas/admin";
import { inviteUser, setProfileActive, updateMembership } from "@/actions/admin";
import { fmt } from "@/i18n";
import type { Enums } from "@/types/database";

type Role = Enums<"app_role">;

const ROLES: Role[] = ["company_admin", "sales_manager", "sales_agent", "cs_agent"];

function useRoleOptions(superAdmin: boolean): Option[] {
  const { t } = useI18n();
  // Only the super admin can create or edit company admins (enforced by the DB).
  return ROLES.filter((r) => superAdmin || r !== "company_admin").map((r) => ({ value: r, label: t.enums.role[r] }));
}

export function InviteDialog({
  companies, defaultCompanyId, superAdmin, trigger,
}: { companies: Option[]; defaultCompanyId?: string; superAdmin: boolean; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.admin.inviteUser} description={t.admin.inviteHint}>
      {(close) => <InviteForm companies={companies} defaultCompanyId={defaultCompanyId} superAdmin={superAdmin} onDone={close} />}
    </FormDialog>
  );
}

function InviteForm({
  companies, defaultCompanyId, superAdmin, onDone,
}: { companies: Option[]; defaultCompanyId?: string; superAdmin: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const roles = useRoleOptions(superAdmin);
  const { form, submit, pending } = useActionForm({
    schema: inviteSchema,
    defaultValues: { email: "", fullName: "", companyId: defaultCompanyId ?? "", role: "sales_agent" },
    action: inviteUser,
    onSuccess: (data) => {
      toast.success(data.invited ? t.admin.invitationSent : t.admin.memberAdded);
      onDone();
    },
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="email" type="email" label={t.common.email} />
        <TextField control={form.control} name="fullName" label={t.common.fullName} />
        {companies.length > 1 && <SelectField control={form.control} name="companyId" label={t.common.company} options={companies} />}
        <SelectField control={form.control} name="role" label={t.common.role} options={roles} />
        <DialogFooter>
          <SubmitButton pending={pending}>{t.admin.sendInvite}</SubmitButton>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

export function MembershipDialog({
  membership, superAdmin, trigger,
}: { membership: { id: string; role: Role; isActive: boolean; name: string }; superAdmin: boolean; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.admin.editMembership} description={membership.name}>
      {(close) => <MembershipForm membership={membership} superAdmin={superAdmin} onDone={close} />}
    </FormDialog>
  );
}

function MembershipForm({
  membership, superAdmin, onDone,
}: { membership: { id: string; role: Role; isActive: boolean }; superAdmin: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const roles = useRoleOptions(superAdmin || membership.role === "company_admin");
  const { form, submit, pending } = useActionForm({
    schema: membershipUpdateSchema,
    defaultValues: { id: membership.id, role: membership.role, isActive: membership.isActive },
    action: updateMembership,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <SelectField control={form.control} name="role" label={t.common.role} options={roles} />
        <CheckboxField control={form.control} name="isActive" label={t.admin.membershipActive}
          description={t.admin.membershipActiveHint} />
        <DialogFooter>
          <SubmitButton pending={pending}>{t.common.save}</SubmitButton>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** Super admin only: deactivating an account removes all access immediately. */
export function ProfileActiveButton({ userId, name, active }: { userId: string; name: string; active: boolean }) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={active ? t.admin.deactivateAccount : t.admin.activateAccount}>
          {active ? <PowerOff className="text-destructive" /> : <Power className="text-emerald-700" />}
        </Button>
      }
      title={active ? t.admin.deactivateAccount : t.admin.activateAccount}
      description={fmt(active ? t.admin.deactivateConfirm : t.admin.activateConfirm, { name })}
      destructive={active}
      onConfirm={() => setProfileActive({ userId, isActive: !active })}
      successMessage={t.common.saved}
    />
  );
}

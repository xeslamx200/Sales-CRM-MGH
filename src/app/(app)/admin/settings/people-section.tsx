"use client";
import { useEffect } from "react";
import { KeyRound, Pencil, UserMinus, UserPlus, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { CheckboxField, FormError, SelectField, SubmitButton, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { ConfirmDialog, FormDialog } from "@/components/app/dialogs";
import { StatusBadge } from "@/components/app/status-badge";
import { useI18n } from "@/components/i18n-provider";
import { createPersonSchema, resetPasswordSchema, updatePersonSchema } from "@/schemas/people";
import { createPersonAction, removePersonAction, resetPasswordAction, updatePersonAction } from "@/actions/people";
import { fmt } from "@/i18n";
import type { Enums } from "@/types/database";

type Role = Enums<"app_role">;
export type PersonAccount = { userId: string; name: string; email: string; phone: string | null; role: Role; active: boolean; customRoleId: string | null; customRoleName: string | null };
export type CustomRoleOption = { id: string; name: string; base: Role };

const ROLES: Role[] = ["company_admin", "sales_manager", "sales_agent", "cs_agent"];
// no look-alike characters (0/O, 1/l/I) so a password read out loud or typed from a message is not mistyped
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("") + "7";
}

function useRoleOptions(superAdmin: boolean): Option[] {
  const { t } = useI18n();
  // only a super admin creates or changes a company admin (the database enforces it too)
  return ROLES.filter((r) => superAdmin || r !== "company_admin").map((r) => ({ value: r, label: t.enums.role[r] }));
}

/** Company settings -> People: create accounts (e-mail + password), edit details, reset passwords, remove people. */
export function PeopleSection({ companyId, people, teams, superAdmin, viewerId, customRoles }: {
  companyId: string; people: PersonAccount[]; teams: Option[]; superAdmin: boolean; viewerId: string; customRoles: CustomRoleOption[];
}) {
  const { t } = useI18n();
  const p = t.people;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 p-4" data-testid="people-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{p.hint}</p>
        <AddPersonDialog customRoles={customRoles} companyId={companyId} teams={teams} superAdmin={superAdmin}
          trigger={<Button size="sm" data-testid="add-person"><UserPlus />{p.add}</Button>} />
      </div>
      <div className="relative min-w-0 max-w-full overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-start font-medium">{t.common.name}</th>
              <th className="px-3 py-2 text-start font-medium">{t.common.phone}</th>
              <th className="px-3 py-2 text-start font-medium">{t.common.role}</th>
              <th className="px-3 py-2 text-start font-medium">{t.common.status}</th>
              <th className="px-3 py-2 text-end font-medium"><span className="sr-only">{t.common.actions}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {people.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">{t.common.noResults}</td></tr>}
            {people.map((x) => {
              const locked = (x.role === "company_admin" && !superAdmin);   // only a super admin changes a company admin
              return (
                <tr key={x.userId} data-testid={`person-${x.email}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{x.name}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">{x.email}</div>
                  </td>
                  <td className="px-3 py-2" dir="ltr">{x.phone ?? "—"}</td>
                  <td className="px-3 py-2">{x.customRoleName ? <>{x.customRoleName} <span className="text-xs text-muted-foreground">({t.enums.role[x.role]})</span></> : t.enums.role[x.role]}</td>
                  <td className="px-3 py-2"><StatusBadge tone={x.active ? "success" : "neutral"}>{x.active ? t.common.active : t.common.inactive}</StatusBadge></td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {!locked && (
                        <>
                          <EditPersonDialog customRoles={customRoles} companyId={companyId} person={x} superAdmin={superAdmin} self={x.userId === viewerId}
                            trigger={<Button variant="ghost" size="icon-sm" aria-label={p.edit}><Pencil /></Button>} />
                          <PasswordDialog companyId={companyId} person={x}
                            trigger={<Button variant="ghost" size="icon-sm" aria-label={p.resetPassword}><KeyRound /></Button>} />
                          {x.userId !== viewerId && (
                            <ConfirmDialog
                              trigger={<Button variant="ghost" size="icon-sm" aria-label={p.remove}><UserMinus className="text-destructive" /></Button>}
                              title={p.remove} description={fmt(p.removeConfirm, { name: x.name })} destructive confirmLabel={p.remove}
                              onConfirm={() => removePersonAction({ companyId, userId: x.userId })} successMessage={p.removed} />
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddPersonDialog({ companyId, teams, superAdmin, trigger, customRoles }: { companyId: string; teams: Option[]; superAdmin: boolean; trigger: React.ReactNode; customRoles: CustomRoleOption[] }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.people.add} description={t.people.addHint}>
      {(close) => <AddPersonForm customRoles={customRoles} companyId={companyId} teams={teams} superAdmin={superAdmin} onDone={close} />}
    </FormDialog>
  );
}

function AddPersonForm({ companyId, teams, superAdmin, onDone, customRoles }: { companyId: string; teams: Option[]; superAdmin: boolean; onDone: () => void; customRoles: CustomRoleOption[] }) {
  const { t } = useI18n();
  const roles = useRoleOptions(superAdmin);
  const { form, submit, pending } = useActionForm({
    schema: createPersonSchema,
    defaultValues: { companyId, fullName: "", email: "", phone: null, role: "sales_agent", customRoleId: null, password: "", teamId: null },
    action: createPersonAction,
    onSuccess: (r) => { toast.success(r.createdAccount ? t.people.created : t.people.attached); onDone(); },
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="fullName" label={t.common.name} />
        <TextField control={form.control} name="email" type="email" dir="ltr" label={t.common.email} />
        <TextField control={form.control} name="phone" type="tel" dir="ltr" label={t.common.phone} />
        <RoleFields form={form} roles={roles} customRoles={customRoles} />
        {teams.length > 0 && <SelectField control={form.control} name="teamId" label={t.people.team} options={[{ value: "", label: t.people.noTeam }, ...teams]} />}
        <div className="grid gap-1.5">
          <TextField control={form.control} name="password" dir="ltr" label={t.people.password} description={t.people.passwordHint} />
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => form.setValue("password", generatePassword(), { shouldValidate: true })}>
            <Wand2 />{t.people.generate}
          </Button>
        </div>
        <DialogFooter><SubmitButton pending={pending}>{t.people.add}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

function EditPersonDialog({ companyId, person, superAdmin, self, trigger, customRoles }: { companyId: string; person: PersonAccount; superAdmin: boolean; self: boolean; trigger: React.ReactNode; customRoles: CustomRoleOption[] }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.people.edit} description={person.name}>
      {(close) => <EditPersonForm customRoles={customRoles} companyId={companyId} person={person} superAdmin={superAdmin} self={self} onDone={close} />}
    </FormDialog>
  );
}

function EditPersonForm({ companyId, person, superAdmin, self, onDone, customRoles }: { companyId: string; person: PersonAccount; superAdmin: boolean; self: boolean; onDone: () => void; customRoles: CustomRoleOption[] }) {
  const { t } = useI18n();
  const roles = useRoleOptions(superAdmin || person.role === "company_admin");
  const { form, submit, pending } = useActionForm({
    schema: updatePersonSchema,
    defaultValues: { companyId, userId: person.userId, fullName: person.name, email: person.email, phone: person.phone, role: person.role, customRoleId: person.customRoleId, isActive: person.active },
    action: updatePersonAction,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="fullName" label={t.common.name} />
        <TextField control={form.control} name="email" type="email" dir="ltr" label={t.common.email} />
        <TextField control={form.control} name="phone" type="tel" dir="ltr" label={t.common.phone} />
        <RoleFields form={form} roles={roles} customRoles={customRoles} disabled={self || person.role === "company_admin"} />
        <CheckboxField control={form.control} name="isActive" label={t.people.activeInCompany} description={t.people.activeHint} disabled={self} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

function PasswordDialog({ companyId, person, trigger }: { companyId: string; person: PersonAccount; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.people.resetPassword} description={person.name}>
      {(close) => <PasswordForm companyId={companyId} person={person} onDone={close} />}
    </FormDialog>
  );
}

function PasswordForm({ companyId, person, onDone }: { companyId: string; person: PersonAccount; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: resetPasswordSchema,
    defaultValues: { companyId, userId: person.userId, password: "" },
    action: resetPasswordAction,
    successMessage: t.people.passwordSaved,
    onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="password" dir="ltr" label={t.people.password} description={t.people.passwordHint} />
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => form.setValue("password", generatePassword(), { shouldValidate: true })}>
          <Wand2 />{t.people.generate}
        </Button>
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

/**
 * Built-in role plus (optionally) a custom role of the company. A custom role sits on one built-in role: choosing it sets the role field to that base
 * role (the database does the same), so the two can never disagree.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RoleFields({ form, roles, customRoles, disabled }: { form: any; roles: Option[]; customRoles: CustomRoleOption[]; disabled?: boolean }) {
  const { t } = useI18n();
  const custom = (form.watch("customRoleId") as string | null) || "";
  const base = customRoles.find((r) => r.id === custom)?.base;
  useEffect(() => { if (base) form.setValue("role", base, { shouldValidate: true }); }, [base, form]);
  return (
    <>
      <SelectField control={form.control} name="role" label={t.common.role} options={roles} disabled={disabled || Boolean(base)} />
      {customRoles.length > 0 && (
        <SelectField control={form.control} name="customRoleId" label={t.roles.customRole} description={t.roles.customRoleHint} disabled={disabled}
          options={[{ value: "", label: t.roles.noCustomRole }, ...customRoles.map((r) => ({ value: r.id, label: `${r.name} (${t.enums.role[r.base]})` }))]} />
      )}
    </>
  );
}

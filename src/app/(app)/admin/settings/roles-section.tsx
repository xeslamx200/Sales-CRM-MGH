"use client";
import { useState, useTransition } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog, FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { deleteRole, saveRole } from "@/actions/roles";
import { HIDEABLE_PAGES, PERMISSION_KEYS, type HideablePage, type PermissionKey } from "@/lib/permissions";
import { fmt } from "@/i18n";
import type { Enums } from "@/types/database";

type Role = Enums<"app_role">;
export type RoleRow = { id: string; name: string; base: Role; hiddenNav: string[]; denied: PermissionKey[]; members: number };
const BASES: Role[] = ["sales_manager", "sales_agent", "cs_agent"];
const box = "size-4 rounded border-input accent-primary";

/** Company settings -> Roles: the company admin adds roles, chooses what each may do and which pages it sees. */
export function RolesSection({ companyId, roles }: { companyId: string; roles: RoleRow[] }) {
  const { t } = useI18n();
  const r = t.roles;
  return (
    <div className="grid min-w-0 gap-3 p-4" data-testid="roles-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-muted-foreground">{r.hint}</p>
        <RoleDialog companyId={companyId} role={null} trigger={<Button size="sm" data-testid="add-role"><Plus />{r.add}</Button>} />
      </div>
      {roles.length === 0 ? <p className="text-sm text-muted-foreground">{r.empty}</p> : (
        <div className="relative min-w-0 max-w-full overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>{[r.name, r.baseRole, r.pagesHidden, r.actionsOff, r.people, ""].map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y">
              {roles.map((x) => (
                <tr key={x.id}>
                  <td className="px-3 py-2 font-medium" dir="auto">{x.name}</td>
                  <td className="px-3 py-2">{t.enums.role[x.base]}</td>
                  <td className="px-3 py-2">{x.hiddenNav.length === 0 ? "—" : x.hiddenNav.map((p) => r.pages[p as HideablePage] ?? p).join("، ")}</td>
                  <td className="px-3 py-2">{x.denied.length === 0 ? "—" : x.denied.map((k) => r.actions[k]).join("، ")}</td>
                  <td className="ltr-nums px-3 py-2">{x.members}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-center gap-1">
                      <RoleDialog companyId={companyId} role={x} trigger={<Button size="icon-sm" variant="ghost" aria-label={r.edit} title={r.edit}><Pencil /></Button>} />
                      <ConfirmDialog
                        trigger={<Button size="icon-sm" variant="ghost" aria-label={r.remove} title={r.remove} disabled={x.members > 0}><Trash2 /></Button>}
                        title={fmt(r.removeTitle, { name: x.name })} description={r.removeHint} confirmLabel={r.remove} destructive successMessage={r.removed}
                        onConfirm={() => deleteRole({ id: x.id })} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RoleDialog({ companyId, role, trigger }: { companyId: string; role: RoleRow | null; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={role ? t.roles.edit : t.roles.add} description={t.roles.dialogHint} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
      {(close) => <RoleForm companyId={companyId} role={role} onDone={close} />}
    </FormDialog>
  );
}

function RoleForm({ companyId, role, onDone }: { companyId: string; role: RoleRow | null; onDone: () => void }) {
  const { t } = useI18n();
  const r = t.roles;
  const [name, setName] = useState(role?.name ?? "");
  const [base, setBase] = useState<Role>(role?.base ?? "sales_agent");
  const [hidden, setHidden] = useState<string[]>(role?.hiddenNav ?? []);
  const [denied, setDenied] = useState<PermissionKey[]>(role?.denied ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const flip = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = () => start(async () => {
    setError(null);
    const res = await saveRole({ id: role?.id ?? null, companyId, name, base, hiddenNav: hidden as HideablePage[], denied });
    if (!res.ok) { setError(res.error); return; }
    toast.success(r.saved);
    onDone();
  });
  return (
    <div className="grid gap-4" data-testid="role-form">
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="grid gap-1.5">
        <Label htmlFor="role-name">{r.name}</Label>
        <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} dir="auto" placeholder={r.namePlaceholder} data-testid="role-name" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="role-base">{r.baseRole}</Label>
        <Select value={base} onValueChange={(v) => setBase(v as Role)}>
          <SelectTrigger id="role-base" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{BASES.map((b) => <SelectItem key={b} value={b}>{t.enums.role[b]}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{r.baseHint}</p>
      </div>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium">{r.pagesTitle}</legend>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {HIDEABLE_PAGES.map((p) => (
            <li key={p}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className={box} checked={!hidden.includes(p)} onChange={() => setHidden((h) => flip(h, p))} data-testid={`page-${p.slice(1)}`} />{r.pages[p]}
              </label>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{r.pagesHint}</p>
      </fieldset>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium">{r.actionsTitle}</legend>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {PERMISSION_KEYS.map((k) => (
            <li key={k}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className={box} checked={!denied.includes(k)} onChange={() => setDenied((d) => flip(d, k))} data-testid={`perm-${k}`} />{r.actions[k]}
              </label>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{r.actionsHint}</p>
      </fieldset>
      <DialogFooter>
        <Button type="button" onClick={save} disabled={pending || name.trim() === ""} data-testid="role-save">{t.common.save}</Button>
      </DialogFooter>
    </div>
  );
}

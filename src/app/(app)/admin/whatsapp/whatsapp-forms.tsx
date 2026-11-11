"use client";
import { useEffect, useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError, SelectField, SubmitButton, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { ConfirmDialog, FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { waAccountSchema } from "@/schemas/admin";
import { grantWhatsappAccess, revokeWhatsappAccess, saveWhatsappAccount, setWhatsappSending } from "@/actions/admin";
import { Constants, type Enums } from "@/types/database";
import { fmt } from "@/i18n";

type Account = {
  id?: string; defaultCompanyId: string; displayName: string; phone: string;
  phoneNumberId: string | null; wabaId: string | null; status: Enums<"wa_account_status">; provider?: "meta" | "kapso";
  environment?: "sandbox" | "production";
};

/** Real companies take Meta numbers; sandbox companies take Kapso sandbox numbers (the database enforces it). */
type CompanyChoices = { real: Option[]; sandbox: Option[] };

export function WaAccountDialog({ account, companies, trigger }: { account?: Account; companies: CompanyChoices; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={account ? t.admin.editNumber : t.admin.newNumber} description={t.admin.numberHint}>
      {(close) => <WaAccountForm account={account} companies={companies} onDone={close} />}
    </FormDialog>
  );
}

function WaAccountForm({ account, companies, onDone }: { account?: Account; companies: CompanyChoices; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: waAccountSchema,
    defaultValues: account ? { ...account, provider: account.provider ?? "meta", environment: account.environment ?? "sandbox", connectionMode: null, outboundEnabled: false } : {
      defaultCompanyId: companies.real[0]?.value ?? "", displayName: "", phone: "", phoneNumberId: null, wabaId: null,
      status: "pending_setup", provider: "meta", environment: "production", connectionMode: null, outboundEnabled: false,
    },
    action: saveWhatsappAccount,
    successMessage: t.common.saved,
    onSuccess: onDone,
  });
  const statuses = Constants.public.Enums.wa_account_status.map((s) => ({ value: s, label: t.enums.waStatus[s] }));
  const provider = form.watch("provider");
  const kapso = provider === "kapso";
  const providers = [{ value: "meta", label: t.admin.providerMeta }, { value: "kapso", label: t.admin.providerKapso }];
  const environment = form.watch("environment");
  const production = kapso && environment === "production";
  const outboundEnabled = form.watch("outboundEnabled");
  const status = form.watch("status");
  // Meta numbers and real Kapso numbers belong to real companies; Kapso sandbox numbers to sandbox companies (the database enforces it).
  const choices = kapso && !production ? companies.sandbox : companies.real;
  useEffect(() => {
    if (account?.id) return;
    if (kapso && companies.real.length === 0) form.setValue("environment", "sandbox");
    if (!choices.some((c) => c.value === form.getValues("defaultCompanyId"))) form.setValue("defaultCompanyId", choices[0]?.value ?? "");
    if (kapso && !production && form.getValues("wabaId") !== null) form.setValue("wabaId", null);
    if (!production) { form.setValue("connectionMode", null); form.setValue("outboundEnabled", false); }
  }, [kapso, production, choices, companies.real.length, account?.id, form]);
  const environments = [{ value: "production", label: t.admin.environmentProduction }, { value: "sandbox", label: t.admin.environmentSandbox }];
  const modes = [{ value: "coexistence", label: t.admin.modeCoexistence }, { value: "cloud_api", label: t.admin.modeCloudApi }];
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="displayName" label={t.common.name} />
        <TextField control={form.control} name="phone" type="tel" label={t.common.phone} placeholder="+974 5555 0001" />
        {/* The provider is fixed once the number exists. Switching it re-picks the matching kind of company. */}
        <SelectField control={form.control} name="provider" label={t.admin.provider} options={providers}
          disabled={Boolean(account?.id)} description={t.admin.providerHint} />
        {kapso && (
          <SelectField control={form.control} name="environment" label={t.admin.environment} options={environments}
            disabled={Boolean(account?.id) || companies.sandbox.length === 0 || companies.real.length === 0} />
        )}
        {production && !account?.id && (
          <SelectField control={form.control} name="connectionMode" label={t.admin.connectionMode} options={modes} description={t.admin.connectionModeHint} />
        )}
        <SelectField control={form.control} name="defaultCompanyId" label={t.admin.defaultCompany}
          options={choices} />
        <div className="grid grid-cols-2 gap-3">
          <TextField control={form.control} name="phoneNumberId" label={t.admin.phoneNumberId} dir="ltr"
            inputMode={kapso ? "text" : "numeric"} description={kapso ? t.admin.kapsoPhoneNumberIdHint : undefined} />
          {(!kapso || production) && <TextField control={form.control} name="wabaId" label={t.admin.wabaId} dir="ltr" inputMode="numeric" />}
        </div>
        <SelectField control={form.control} name="status" label={t.common.status} options={statuses}
          description={t.admin.statusHint} />
        {production && !account?.id && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={outboundEnabled} disabled={status !== "active"} onCheckedChange={(v) => form.setValue("outboundEnabled", v === true)} />
            {t.admin.allowSending}
          </label>
        )}
        <DialogFooter>
          <SubmitButton pending={pending}>{t.common.save}</SubmitButton>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** Switch sending from the CRM on or off for a real Kapso number (super admin). The database refuses "on" unless the number is active. */
export function SendingSwitch({ accountId, enabled }: { accountId: string; enabled: boolean }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const id = `sending-${accountId}`;
  return (
    <div className="flex items-center gap-2 text-sm">
      <Switch id={id} checked={enabled} disabled={pending}
        onCheckedChange={(v) => start(async () => {
          const res = await setWhatsappSending({ accountId, enabled: v });
          if (!res.ok) toast.error(res.error);
        })} />
      <Label htmlFor={id}>{t.admin.allowSending}</Label>
    </div>
  );
}

export function GrantRow({ accountId, userId, name, canReply }: { accountId: string; userId: string; name: string; canReply: boolean }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const id = `reply-${accountId}-${userId}`;
  return (
    <li className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span>{name}</span>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Switch
            id={id}
            checked={canReply}
            disabled={pending}
            onCheckedChange={(v) =>
              start(async () => {
                const res = await grantWhatsappAccess({ accountId, userId, canReply: v });
                if (!res.ok) toast.error(res.error);
              })
            }
          />
          <Label htmlFor={id} className="text-xs font-normal">{t.admin.canReply}</Label>
        </div>
        <ConfirmDialog
          trigger={<Button variant="ghost" size="icon-xs" aria-label={t.admin.revoke}><X /></Button>}
          title={t.admin.revoke}
          description={fmt(t.admin.revokeConfirm, { name })}
          destructive
          onConfirm={() => revokeWhatsappAccess({ accountId, userId })}
        />
      </div>
    </li>
  );
}

export function AddGrantForm({ accountId, options }: { accountId: string; options: Option[] }) {
  const { t } = useI18n();
  const [userId, setUserId] = useState("");
  const [canReply, setCanReply] = useState(true);
  const [pending, start] = useTransition();
  if (options.length === 0) return null;
  const id = `new-reply-${accountId}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={userId} onValueChange={setUserId}>
        <SelectTrigger size="sm" className="min-w-48 flex-1" aria-label={t.admin.grantAccess}>
          <SelectValue placeholder={t.admin.grantAccess} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1.5">
        <Checkbox id={id} checked={canReply} onCheckedChange={(v) => setCanReply(v === true)} />
        <Label htmlFor={id} className="text-xs font-normal">{t.admin.canReply}</Label>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={!userId || pending}
        onClick={() =>
          start(async () => {
            const res = await grantWhatsappAccess({ accountId, userId, canReply });
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

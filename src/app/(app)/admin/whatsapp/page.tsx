import { notFound } from "next/navigation";
import { Pencil, Phone, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { getViewer, isAdminOf, isAnyAdmin } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { listMembers, peopleOptions } from "@/server/data/members";
import { GrantRow, AddGrantForm, SendingSwitch, WaAccountDialog } from "./whatsapp-forms";
import { NumberTools } from "./number-tools";
import { formatDateTime } from "@/lib/format.ts";

export default async function WhatsappNumbersPage() {
  const viewer = await getViewer();
  if (!isAnyAdmin(viewer)) notFound();
  const { t, locale } = viewer;
  const tz = viewer.companies[0]?.timezone ?? "UTC";
  const supabase = await createClient();

  // RLS: super admin sees all numbers; company admins see numbers whose
  // default company they administer (and numbers they hold a grant on).
  const [{ data: accounts, error }, members] = await Promise.all([
    supabase.from("whatsapp_accounts")
      .select("id, display_name, phone_e164, phone_number_id, waba_id, status, is_simulated, provider, environment, outbound_enabled, default_company_id, access:whatsapp_account_access(user_id, can_reply, profile:profiles!whatsapp_account_access_user_id_fkey(full_name)), health:whatsapp_account_health(status, error_code, failing_since, checked_at), templates:whatsapp_templates(name, language, status, param_count, supported)")
      .order("display_name"),
    listMembers(supabase, viewer.companies.map((c) => c.id), { activeOnly: true }),
  ]);
  if (error) throw error;

  const companyName = new Map(viewer.companies.map((c) => [c.id, c.name]));
  const companyOptions = {
    real: viewer.companies.filter((c) => !c.isSandbox).map((c) => ({ value: c.id, label: c.name })),
    sandbox: viewer.companies.filter((c) => c.isSandbox).map((c) => ({ value: c.id, label: c.name })),
  };
  const people = peopleOptions(members);
  const visible = (accounts ?? []).filter((a) => viewer.isSuperAdmin || isAdminOf(viewer, a.default_company_id));

  return (
    <>
      <PageHeader
        title={t.admin.waTitle}
        description={t.admin.waHint}
        actions={viewer.isSuperAdmin && (
          <WaAccountDialog companies={companyOptions} trigger={<Button><Plus />{t.admin.newNumber}</Button>} />
        )}
      />
      {visible.length === 0 ? (
        <EmptyState icon={Phone} title={t.admin.noNumbers} description={t.admin.noNumbersHint} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map((a) => {
            const granted = new Set(a.access.map((g) => g.user_id));
            return (
              <section key={a.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="font-semibold">{a.display_name}</h2>
                    <p className="ltr-nums text-sm text-muted-foreground">{a.phone_e164}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.admin.defaultCompany}: {companyName.get(a.default_company_id) ?? "—"}
                      {a.phone_number_id && <> · ID <span className="ltr-nums">{a.phone_number_id}</span></>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {a.is_simulated && <StatusBadge tone="warning">{t.common.simulated}</StatusBadge>}
                    {a.provider === "kapso" && (a.environment === "sandbox"
                      ? <StatusBadge tone="warning">{t.common.sandbox} · Kapso</StatusBadge>
                      : <><StatusBadge>Kapso</StatusBadge><StatusBadge tone={a.outbound_enabled ? "success" : "warning"}>{a.outbound_enabled ? t.admin.sendingOn : t.admin.receiveOnly}</StatusBadge></>)}
                    <StatusBadge tone={toneFor(a.status)}>{t.enums.waStatus[a.status]}</StatusBadge>
                    {viewer.isSuperAdmin && (
                      <WaAccountDialog
                        companies={companyOptions}
                        account={{
                          id: a.id, defaultCompanyId: a.default_company_id, displayName: a.display_name, phone: a.phone_e164,
                          phoneNumberId: a.phone_number_id, wabaId: a.waba_id, status: a.status,
                          provider: a.provider === "kapso" ? "kapso" : "meta", environment: a.environment === "production" ? "production" : "sandbox",
                        }}
                        trigger={<Button variant="ghost" size="icon-sm" aria-label={t.common.edit}><Pencil /></Button>}
                      />
                    )}
                  </div>
                </div>
                {a.provider === "kapso" ? (
                  <div className="flex flex-col gap-2">
                    <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">{a.environment === "sandbox" ? t.admin.kapsoNumberNote : t.admin.kapsoProductionNote}</p>
                    {viewer.isSuperAdmin && a.environment === "production" && <SendingSwitch accountId={a.id} enabled={a.outbound_enabled} />}
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {a.health?.status === "error" ? (
                        <StatusBadge tone="danger">{t.admin.credentialsFailing} ({a.health.error_code}) · {a.health.failing_since ? formatDateTime(a.health.failing_since, tz, locale) : ""}</StatusBadge>
                      ) : a.health?.status === "ok" ? (
                        <StatusBadge tone="success">{t.admin.connectionOk}</StatusBadge>
                      ) : (
                        <StatusBadge>{t.admin.notChecked}</StatusBadge>
                      )}
                      <NumberTools accountId={a.id} />
                    </div>
                    <div>
                      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t.admin.templates}</h3>
                      {a.templates.length === 0 ? <p className="text-xs text-muted-foreground">{t.admin.noTemplates}</p> : (
                        <ul className="flex flex-wrap gap-1">
                          {a.templates.map((tp) => (
                            <li key={`${tp.name}-${tp.language}`}>
                              <StatusBadge tone={tp.status === "APPROVED" ? (tp.supported ? "success" : "neutral") : tp.status === "REJECTED" ? "danger" : "warning"}>
                                <span dir="ltr">{tp.name} · {tp.language}</span> · {tp.status}
                                {tp.status === "APPROVED" && !tp.supported && <> · {t.admin.templateUnsupported}</>}
                              </StatusBadge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
                <div>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t.admin.grants}</h3>
                  <ul className="flex flex-col divide-y rounded-md border text-sm">
                    {a.access.length === 0 && <li className="p-2 text-muted-foreground">{t.admin.noGrants}</li>}
                    {a.access.map((g) => (
                      <GrantRow key={g.user_id} accountId={a.id} userId={g.user_id}
                        name={g.profile?.full_name ?? people.find((p) => p.value === g.user_id)?.label ?? "—"}
                        canReply={g.can_reply} />
                    ))}
                  </ul>
                </div>
                <AddGrantForm accountId={a.id} options={people.filter((p) => !granted.has(p.value))} />
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Paperclip, Search, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FormError, SelectField, SubmitButton, TextareaField, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { useI18n } from "@/components/i18n-provider";
import { createBrowserSupabase } from "@/client/supabase";
import { finalizeAttachmentUpload, prepareAttachment } from "@/actions/attachments";
import { customerBalance, savePayment, searchCustomers, type Balance, type CustomerHit } from "@/actions/payments";
import { buildPaymentSchema } from "@/schemas/payments";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES } from "@/lib/attachments.ts";
import { egpPreview, FX_SOURCE_NAME, PAYMENT_CURRENCIES, rateFor, workshopBalance, type RateTable } from "@/lib/fx.ts";
import { formatCurrency, formatNumber } from "@/lib/format.ts";
import { fmt } from "@/i18n";
import { cn } from "@/lib/utils";

export type WorkshopOption = { id: string; companyId: string; name: string; label: string; priceEgp: number | null };

/** Payment form: workshop -> customer (search or add) -> amount/currency (EGP total preview) -> type -> date -> proof image. */
export function PaymentForm({ workshops, rates, today }: { workshops: WorkshopOption[]; rates: RateTable; today: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  // the picked customer belongs to the company of the workshop chosen at that moment; a different company invalidates it
  const [picked, setPicked] = useState<{ hit: CustomerHit; companyId: string } | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ key: string; hits: CustomerHit[] } | null>(null);
  const [bal, setBal] = useState<{ key: string; data: Balance } | null>(null);

  const schema = useMemo(() => buildPaymentSchema({ amount: t.payments.amountInvalid, customer: t.payments.customerRequired }), [t]);

  // The proof image is uploaded AFTER the payment exists (it is attached to the payment id), through the existing private upload flow.
  const action = async (values: ReturnType<typeof schema.parse>) => {
    if (!file) { setFileError(t.payments.proofRequired); return { ok: false as const, error: t.payments.proofRequired, errorKey: "payment.proof_required" }; }
    const res = await savePayment(values);
    if (!res.ok) return res;
    const paymentId = res.data.paymentId;
    try {
      const prep = await prepareAttachment({ entityType: "payment", entityId: paymentId, mimeType: file.type, size: file.size });
      if (!prep.ok) throw new Error(prep.error);
      const up = await createBrowserSupabase().storage.from("attachments").uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: file.type });
      if (up.error) throw up.error;
      const fin = await finalizeAttachmentUpload({ entityType: "payment", entityId: paymentId, path: prep.data.path, fileName: file.name, mimeType: file.type });
      if (!fin.ok) throw new Error(fin.error);
    } catch {
      toast.error(t.payments.savedNoProof);
    }
    return res;
  };

  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { offeringId: "", contactId: "", newName: "", newPhone: "", amount: "", currency: "EGP" as const, kind: "partial" as const, paidOn: today, note: "" },
    action,
    successMessage: t.payments.saved,
    onSuccess: () => { router.push("/payments"); router.refresh(); },
  });

  const offeringId = form.watch("offeringId") as string;
  const currency = (form.watch("currency") as string) || "EGP";
  const amountText = String(form.watch("amount") ?? "");
  const workshop = workshops.find((w) => w.id === offeringId) ?? null;
  const pickedHit = picked && workshop && picked.companyId === workshop.companyId ? picked.hit : null;
  const contactId = pickedHit?.id ?? "";

  // keep the form value in step with the (derived) customer
  useEffect(() => { form.setValue("contactId", contactId, { shouldValidate: contactId !== "" }); }, [contactId, form]);

  // customer search (debounced), scoped to the workshop's company. State is only set from the async callback.
  const searchKey = mode === "existing" && !pickedHit && workshop && query.trim().length >= 2 ? `${workshop.companyId}|${query.trim()}` : null;
  useEffect(() => {
    if (!searchKey || !workshop) return;
    const timer = setTimeout(async () => {
      const r = await searchCustomers({ companyId: workshop.companyId, q: query });
      setFound({ key: searchKey, hits: r.ok ? r.data : [] });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchKey, workshop, query]);
  const hits = found && found.key === searchKey ? found.hits : null;
  const searching = searchKey !== null && hits === null;

  // balance of the picked customer for the workshop
  const balKey = contactId && offeringId ? `${contactId}|${offeringId}` : null;
  useEffect(() => {
    if (!balKey) return;
    let live = true;
    void customerBalance({ contactId, offeringId }).then((r) => { if (live && r.ok) setBal({ key: balKey, data: r.data }); });
    return () => { live = false; };
  }, [balKey, contactId, offeringId]);
  const balance = bal && bal.key === balKey ? bal.data : null;

  const rate = rateFor(currency, rates);
  const amountNum = Number(amountText.replace(/[,\s]/g, ""));
  const total = rate != null && Number.isFinite(amountNum) ? egpPreview(amountNum, rate) : 0;
  const rateMissing = currency !== "EGP" && rate == null;
  const stored = balance ? workshopBalance(balance.priceEgp, balance.confirmedEgp) : null;

  const pickFile = (f: File | undefined) => {
    setFileError(null);
    if (!f) return;
    if (!ATTACHMENT_TYPES[f.type]) return void setFileError(t.attachments.unsupported);
    if (f.size > ATTACHMENT_MAX_BYTES) return void setFileError(t.attachments.tooLarge);
    setFile(f);
  };

  const workshopOptions = workshops.map((w) => ({ value: w.id, label: w.label }));
  const errors = form.formState.errors;

  return (
    <form onSubmit={submit} noValidate className="mx-auto flex w-full max-w-2xl flex-col gap-4 rounded-2xl bg-card p-5 shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5">
      <FieldGroup>
        <FormError message={errors.root?.message} />

        <SelectField control={form.control} name="offeringId" label={t.payments.workshop} options={workshopOptions}
          description={workshop ? (workshop.priceEgp == null ? t.payments.noPrice : fmt(t.payments.workshopPrice, { price: formatCurrency(workshop.priceEgp, "EGP", locale) })) : undefined} />

        {/* ---- customer */}
        <Field data-invalid={Boolean(errors.contactId)}>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor="customer-search">{t.payments.customer}</FieldLabel>
            <Button type="button" variant="ghost" size="xs" onClick={() => { setMode(mode === "existing" ? "new" : "existing"); setPicked(null); setQuery(""); }}>
              {mode === "existing" ? <><UserPlus />{t.payments.addNewCustomer}</> : <><Search />{t.payments.useExisting}</>}
            </Button>
          </div>
          {mode === "existing" ? (
            pickedHit ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-accent px-3 py-2 text-sm">
                <span className="min-w-0 truncate font-medium">{pickedHit.name}{pickedHit.phone && <> · <span className="ltr-nums text-muted-foreground">{pickedHit.phone}</span></>}</span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={t.payments.changeCustomer}
                  onClick={() => { setPicked(null); setQuery(""); }}><X /></Button>
              </div>
            ) : (
              <div className="relative">
                <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input id="customer-search" value={query} onChange={(e) => setQuery(e.target.value)} disabled={!workshop}
                  placeholder={workshop ? t.payments.searchPlaceholder : t.payments.workshopRequired} className="ps-9" autoComplete="off" dir="auto" />
                {(searching || hits) && (
                  <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border bg-popover p-1 text-sm shadow-md" role="listbox">
                    {searching && <li className="flex items-center gap-2 px-3 py-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t.payments.searching}</li>}
                    {!searching && hits?.length === 0 && <li className="px-3 py-2 text-muted-foreground">{t.payments.noResults}</li>}
                    {!searching && hits?.map((h) => (
                      <li key={h.id} role="option" aria-selected={false}>
                        <button type="button" className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-start hover:bg-accent"
                          onClick={() => { if (workshop) setPicked({ hit: h, companyId: workshop.companyId }); }}>
                          <span className="truncate">{h.name}</span>
                          {h.phone && <span className="ltr-nums text-xs text-muted-foreground">{h.phone}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField control={form.control} name="newName" label={t.payments.fullName} autoComplete="off" />
              <TextField control={form.control} name="newPhone" label={t.payments.phone} type="tel" description={t.payments.phoneHint} autoComplete="off" />
            </div>
          )}
          {errors.contactId && <FieldError errors={[errors.contactId]} />}
        </Field>

        {stored && workshop && (
          <div className="rounded-xl bg-[#f3f5f9] px-4 py-3 text-sm" aria-live="polite">
            <p className="mb-1 font-medium">{t.payments.balanceTitle}</p>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
              <span>{t.payments.balancePaid}: <b className="ltr-nums text-foreground">{formatCurrency(stored.paid, "EGP", locale)}</b></span>
              {stored.remaining != null && (stored.settled
                ? <b className="text-success">{t.payments.balanceSettled}</b>
                : <span>{t.payments.balanceRemaining}: <b className="ltr-nums text-foreground">{formatCurrency(stored.remaining, "EGP", locale)}</b></span>)}
              {balance && balance.pendingEgp > 0 && <span>{t.payments.status.pending}: <b className="ltr-nums text-foreground">{formatCurrency(balance.pendingEgp, "EGP", locale)}</b></span>}
            </div>
          </div>
        )}

        {/* ---- amount */}
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <TextField control={form.control} name="amount" label={t.payments.amount} inputMode="decimal" dir="ltr" autoComplete="off" />
          <SelectField control={form.control} name="currency" label={t.payments.currency} options={PAYMENT_CURRENCIES.map((c) => ({ value: c, label: c }))} />
        </div>
        <div className={cn("rounded-xl px-4 py-3 text-sm", rateMissing ? "bg-destructive/10 text-destructive" : "bg-accent")} aria-live="polite">
          {rateMissing ? t.payments.ratesUnavailable : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-muted-foreground">{t.payments.totalEgp}</span>
                <b className="ltr-nums text-lg">{formatCurrency(total, "EGP", locale)}</b>
              </div>
              {currency !== "EGP" && rate != null && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {fmt(t.payments.rateLine, { currency, rate: formatNumber(Math.round(rate * 10000) / 10000, locale) })}. {t.payments.ratesDisclaimer}
                </p>
              )}
            </>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField control={form.control} name="kind" label={t.payments.kind}
            options={[{ value: "partial", label: t.payments.kindPartial }, { value: "full", label: t.payments.kindFull }]} />
          <TextField control={form.control} name="paidOn" label={t.payments.paidOn} type="date" />
        </div>

        {/* ---- proof */}
        <Field data-invalid={Boolean(fileError)}>
          <FieldLabel htmlFor="payment-proof">{t.payments.proof}</FieldLabel>
          <input ref={fileInput} id="payment-proof" type="file" className="sr-only" accept={Object.keys(ATTACHMENT_TYPES).join(",")}
            onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}><Paperclip />{t.payments.chooseFile}</Button>
            {file && (
              <span className="flex min-w-0 items-center gap-1 rounded-lg bg-accent px-2 py-1 text-sm">
                <span className="truncate" dir="auto">{file.name}</span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={t.common.delete} onClick={() => setFile(null)}><X /></Button>
              </span>
            )}
          </div>
          <FieldDescription>{t.payments.proofHint}</FieldDescription>
          {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
        </Field>

        <TextareaField control={form.control} name="note" label={t.payments.note} rows={2} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {t.payments.ratesFooter}<a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer" className="underline">{FX_SOURCE_NAME}</a>
          </p>
          <SubmitButton pending={pending} className={rateMissing ? "pointer-events-none opacity-50" : undefined}>{t.payments.submit}</SubmitButton>
        </div>
      </FieldGroup>
    </form>
  );
}

"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FormError, SelectField, SubmitButton, TextareaField, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { useI18n } from "@/components/i18n-provider";
import { createBooking, workshopOptions, type GroupOption, type PriceOption } from "@/actions/bookings";
import { searchCustomers, type CustomerHit } from "@/actions/payments";
import { buildBookingSchema, parseMoney } from "@/schemas/bookings";
import { ProofField, uploadProof } from "@/components/bookings/proof-field";
import { previewBooking, type DiscountType } from "@/lib/discount-policy.ts";
import { WORKSHOP_COUNTRIES, countryName } from "@/lib/workshop-config.ts";
import { VoiceCapture } from "@/components/bookings/voice-capture";
import { matchGroup, parseBookingSpeech, type SpeechBooking } from "@/lib/voice/booking-parser.ts";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format.ts";
import { fmt } from "@/i18n";
import { cn } from "@/lib/utils";

export type WorkshopChoice = { id: string; companyId: string; name: string };
type VoiceItem = { key: string; label: string; value: string; ok: boolean };

/**
 * Booking form: customer -> workshop -> group -> country + attendance (the configured price and currency appear) -> optional discount with a mandatory
 * reason -> a live summary (original, discount, final, who must approve). The database re-checks everything; nothing here is trusted.
 */
export function BookingForm({ workshops }: { workshops: WorkshopChoice[] }) {
  const { t, locale } = useI18n();
  const b = t.bookings;
  const router = useRouter();
  const [offeringId, setOfferingId] = useState("");
  const [opts, setOpts] = useState<{ offeringId: string; groups: GroupOption[]; prices: PriceOption[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [picked, setPicked] = useState<{ hit: CustomerHit; companyId: string } | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ key: string; hits: CustomerHit[] } | null>(null);
  const [proof, setProof] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [voiceItems, setVoiceItems] = useState<VoiceItem[] | null>(null);
  // what was said about the group / paying in full waits here until the workshop's groups and prices are loaded
  const pendingVoice = useRef<SpeechBooking | null>(null);

  const schema = useMemo(() => buildBookingSchema({ discount: b.invalidDiscount, reason: b.reasonRequired, money: b.moneyInvalid }), [b]);
  const workshop = workshops.find((w) => w.id === offeringId) ?? null;

  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { contactId: "", groupId: "", country: "QA", attendance: "online", discountType: "none", discountValue: "", discountReason: "", note: "", paidNow: "" },
    // a payment needs its proof: the approver checks the amount the employee typed against the receipt
    action: async (values) => {
      if (values.paidNow != null && !proof) { setProofError(t.payments.proofRequired); return { ok: false as const, error: t.payments.proofRequired, errorKey: "payment.proof_required" }; }
      return createBooking(values);
    },
    onSuccess: async (data) => {
      if (data.paymentError) toast.warning(`${b.createdPaymentFailed} ${data.paymentError}`);
      else if (data.paymentId && proof && !(await uploadProof(data.paymentId, proof))) toast.warning(t.payments.savedNoProof);
      else toast.success(b.created);
      router.push(`/bookings/${data.bookingId}`);
    },
  });
  const discountType = form.watch("discountType") as DiscountType;
  const discountValue = form.watch("discountValue");
  const country = form.watch("country");
  const attendance = form.watch("attendance");
  const groupId = form.watch("groupId");

  // customer search (debounced; the company comes from the chosen workshop, or the first one)
  const searchCompany = workshop?.companyId ?? workshops[0]?.companyId ?? "";
  const q = query.trim();
  const key = `${searchCompany}:${q}`;
  useEffect(() => {
    if (!searchCompany || q.length < 2) return;
    let live = true;
    const id = setTimeout(async () => {
      const r = await searchCustomers({ companyId: searchCompany, q });
      if (live) setFound({ key, hits: r.ok ? r.data : [] });
    }, 250);
    return () => { live = false; clearTimeout(id); };
  }, [q, searchCompany, key]);
  const hits = found && found.key === key && q.length >= 2 ? found.hits : null;

  const putVoiceItem = (item: VoiceItem) => setVoiceItems((v) => [...(v ?? []).filter((i) => i.key !== item.key), item]);

  /** With the workshop's groups and prices known: pick the spoken group and, if asked, the full price as the first payment. */
  const finishVoice = (options: { groups: GroupOption[]; prices: PriceOption[] }, said: SpeechBooking) => {
    const vb = t.voiceBooking;
    let chosen = options.groups.find((g) => g.id === form.getValues("groupId")) ?? null;
    if (said.group) {
      const r = matchGroup(said.group, options.groups);
      const g = r.id ? options.groups.find((x) => x.id === r.id) ?? null : null;
      if (g && !(g.capacity != null && g.booked >= g.capacity)) {
        form.setValue("groupId", g.id, { shouldValidate: true, shouldDirty: true });
        putVoiceItem({ key: "group", label: b.group, value: g.name, ok: true });
        chosen = g;
      } else putVoiceItem({ key: "group", label: b.group, value: `${said.group.text} — ${g ? vb.fullGroup : vb.noGroup}`, ok: false });
    }
    if (said.paidFull) {
      const att = chosen?.attendance ?? (form.getValues("attendance") as "online" | "offline");
      const pr = options.prices.find((x) => x.country === form.getValues("country") && x.attendance === att) ?? null;
      const pv = previewBooking(pr?.price ?? null, form.getValues("discountType") as DiscountType, parseMoney(form.getValues("discountValue")) ?? null);
      const pay = pv ? (pv.valid && pv.level !== "manager" && pv.level !== "admin" ? pv.final : pv.list) : null;
      if (pay != null && pr) {
        form.setValue("paidNow", String(pay), { shouldDirty: true, shouldValidate: true });
        putVoiceItem({ key: "paid", label: b.paidNow, value: `${formatCurrency(pay, pr.currency, locale)} (${vb.paidFullDone})`, ok: true });
      } else putVoiceItem({ key: "paid", label: b.paidNow, value: vb.paidFullWaiting, ok: false });
    }
  };

  const chooseWorkshop = (id: string) => {
    setOfferingId(id); setOpts(null); setLoadError(null);
    form.setValue("groupId", "");
    // the customer must belong to the workshop's company: a different company drops the pick
    const next = workshops.find((w) => w.id === id);
    if (picked && next && picked.companyId !== next.companyId) { setPicked(null); form.setValue("contactId", ""); }
    if (!id) return;
    startLoad(async () => {
      const r = await workshopOptions({ offeringId: id });
      if (r.ok) {
        setOpts({ offeringId: id, ...r.data });
        if (pendingVoice.current) { finishVoice(r.data, pendingVoice.current); pendingVoice.current = null; }
      } else setLoadError(r.error);
    });
  };

  const o = opts && opts.offeringId === offeringId ? opts : null;
  const group = o?.groups.find((g) => g.id === groupId) ?? null;
  // a group limited to one attendance type forces it
  useEffect(() => { if (group?.attendance && group.attendance !== attendance) form.setValue("attendance", group.attendance); }, [group, attendance, form]);
  const price = o?.prices.find((p) => p.country === country && p.attendance === attendance) ?? null;
  const preview = previewBooking(price?.price ?? null, discountType, parseMoney(discountValue) ?? null);
  // what the customer owes today: the discounted price if it applies at once, otherwise the full price (a pending discount does not apply yet)
  const payable = preview ? (preview.valid && preview.level !== "manager" && preview.level !== "admin" ? preview.final : preview.list) : null;
  const paid = parseMoney(form.watch("paidNow"));
  const paidInvalid = paid != null && (Number.isNaN(paid) || (payable != null && paid > payable));

  /** Fill the form from what was said. Only what was clearly understood is filled; everything is reported so it can be reviewed. */
  const applyVoice = async (spoken: string) => {
    const vb = t.voiceBooking;
    const p = parseBookingSpeech(spoken, { workshops: workshops.map((w) => ({ id: w.id, name: w.name })), countries: WORKSHOP_COUNTRIES });
    setVoiceItems(null); pendingVoice.current = null;
    const items: VoiceItem[] = [];
    const add = (key: string, label: string, value: string, ok = true) => { items.push({ key, label, value, ok }); };
    let companyId = searchCompany;
    if (p.workshopId) {
      const w = workshops.find((x) => x.id === p.workshopId);
      if (w) { if (w.id !== offeringId) chooseWorkshop(w.id); companyId = w.companyId; add("workshop", b.workshop, w.name); }
    } else if (p.workshopAmbiguous) add("workshop", b.workshop, vb.ambiguous, false);
    // group and "paid in full" need the workshop's groups and prices: now if they are loaded, otherwise when they arrive
    const needsOptions = Boolean(p.group || p.paidFull);
    const workshopNow = p.workshopId ?? offeringId;
    if (needsOptions && !workshopNow) {
      if (p.group) add("group", b.group, `${p.group.text} — ${vb.needWorkshop}`, false);
      if (p.paidFull) add("paid", b.paidNow, vb.needWorkshop, false);
      if (p.paidFull || p.group) pendingVoice.current = null;
    } else if (needsOptions) {
      if (!p.workshopId || p.workshopId === offeringId) {
        if (o) finishVoice(o, p); else pendingVoice.current = p;
      } else pendingVoice.current = p;
    }
    if (p.country) { form.setValue("country", p.country, { shouldDirty: true }); add("country", b.country, countryName(p.country, locale === "ar" ? "ar" : "en")); }
    if (p.attendance) { form.setValue("attendance", p.attendance, { shouldDirty: true }); add("attendance", b.attendance, p.attendance === "online" ? b.online : b.offline); }
    if (p.discount) {
      form.setValue("discountType", p.discount.type, { shouldDirty: true });
      form.setValue("discountValue", String(p.discount.value), { shouldDirty: true, shouldValidate: true });
      add("discount", b.discount, `${p.discount.type === "percent" ? `${p.discount.value}%` : p.discount.value}${p.discount.assumedPercent ? ` (${vb.assumedPercent})` : ""}`);
      if (p.discountReason) { form.setValue("discountReason", p.discountReason, { shouldDirty: true, shouldValidate: true }); add("reason", b.discountReason, p.discountReason); }
      else add("reason", b.discountReason, vb.reasonMissing, false);
    }
    if (p.paidNow != null) {
      form.setValue("paidNow", String(p.paidNow), { shouldDirty: true, shouldValidate: true });
      add("paid", b.paidNow, String(p.paidNow));
      add("proof", t.payments.proofRequired, vb.proofNeeded, false);
    } else if (p.paidFull) add("proof", t.payments.proofRequired, vb.proofNeeded, false);
    if (p.note) { form.setValue("note", p.note, { shouldDirty: true }); add("note", b.note, p.note); }
    // the customer: by phone first, then the spoken name (full, first two words, first word)
    const name = p.customerName;
    if (name || p.phone) {
      const words = (name ?? "").split(" ").filter(Boolean);
      const queries = [...new Set([p.phone, name, words.slice(0, 2).join(" "), words[0]].filter((x): x is string => Boolean(x && x.length >= 2)))];
      let found: CustomerHit[] = []; let used = "";
      for (const q0 of queries) {
        const r = await searchCustomers({ companyId, q: q0 });
        if (r.ok && r.data.length > 0) { found = r.data; used = q0; break; }
      }
      const label = name ?? p.phone ?? "";
      if (found.length === 1) {
        setPicked({ hit: found[0], companyId });
        form.setValue("contactId", found[0].id, { shouldValidate: true, shouldDirty: true });
        add("customer", b.customer, `${found[0].name}${found[0].phone ? ` · ⁦${found[0].phone}⁩` : ""}`);
      } else if (found.length > 1) {
        setPicked(null); form.setValue("contactId", ""); setQuery(used);
        add("customer", b.customer, `${label} — ${vb.manyCustomers}`, false);
      } else {
        setPicked(null); form.setValue("contactId", ""); setQuery(label);
        add("customer", b.customer, `${label} — ${vb.noCustomer}`, false);
      }
    }
    // merge with what the group / price step reported while the customer was being searched
    setVoiceItems((prev) => {
      const merged = [...items, ...(prev ?? []).filter((i) => !items.some((x) => x.key === i.key))];
      return merged.length > 0 ? merged : [{ key: "none", label: vb.title, value: vb.nothing, ok: false }];
    });
  };

  const seatsLabel = (g: GroupOption) => {
    const dates = g.sessions.map((d) => formatDate(d, "UTC", locale)).join(" · ");
    const seats = g.capacity == null ? b.unlimited : g.booked >= g.capacity ? b.full : fmt(b.seatsLeft, { n: formatNumber(g.capacity - g.booked, locale) });
    return `${g.name} — ${dates} (${seats})`;
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />

        <VoiceCapture onAnalyze={applyVoice} disabled={pending} />
        {voiceItems && (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm" role="status" data-testid="voice-report">
            <p className="mb-2 font-medium">{t.voiceBooking.understood}</p>
            <ul className="grid gap-1">
              {voiceItems.map((i) => (
                <li key={i.key} className="flex items-start gap-2" data-ok={i.ok}>
                  {i.ok ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />}
                  <span><b>{i.label}:</b> {i.value}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">{t.voiceBooking.reviewHint}</p>
          </div>
        )}

        <Field data-invalid={Boolean(form.formState.errors.contactId)}>
          <FieldLabel htmlFor="customer-search">{b.customer}</FieldLabel>
          {picked ? (
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <span><b>{picked.hit.name}</b>{picked.hit.phone && <span className="ltr-nums ms-2 text-muted-foreground" dir="ltr">{picked.hit.phone}</span>}</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => { setPicked(null); form.setValue("contactId", ""); }}><X />{b.changeCustomer}</Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input id="customer-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={b.searchCustomer} className="ps-8" autoComplete="off" />
              </div>
              {hits && (
                <ul className="mt-1 max-h-48 overflow-auto rounded-md border bg-card text-sm" role="listbox">
                  {hits.length === 0 ? <li className="px-3 py-2 text-muted-foreground">{b.noResults}</li> : hits.map((h) => (
                    <li key={h.id}>
                      <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start hover:bg-muted"
                        onClick={() => { setPicked({ hit: h, companyId: searchCompany }); form.setValue("contactId", h.id, { shouldValidate: true }); setQuery(""); }}>
                        <span>{h.name}</span><span className="ltr-nums text-xs text-muted-foreground" dir="ltr">{h.phone}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <FieldDescription>{b.searchHint}</FieldDescription>
            </>
          )}
          {form.formState.errors.contactId && <FieldError errors={[{ message: b.customerRequired }]} />}
        </Field>

        <Field>
          <FieldLabel htmlFor="workshop-select">{b.workshop}</FieldLabel>
          <select id="workshop-select" value={offeringId} onChange={(e) => chooseWorkshop(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm">
            <option value="">{b.pickWorkshop}</option>
            {workshops.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {loadError && <FieldError errors={[{ message: loadError }]} />}
        </Field>

        {o && (
          o.groups.length === 0 ? <p className="text-sm text-destructive">{b.noGroups}</p> : (
            <Field data-invalid={Boolean(form.formState.errors.groupId)}>
              <FieldLabel htmlFor="group-select">{b.group}</FieldLabel>
              <select id="group-select" value={groupId} onChange={(e) => form.setValue("groupId", e.target.value, { shouldValidate: true })}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm" aria-invalid={Boolean(form.formState.errors.groupId)}>
                <option value="">{b.pickGroup}</option>
                {o.groups.map((g) => <option key={g.id} value={g.id} disabled={g.capacity != null && g.booked >= g.capacity}>{seatsLabel(g)}</option>)}
              </select>
              {form.formState.errors.groupId && <FieldError errors={[{ message: b.pickGroup }]} />}
            </Field>
          )
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField control={form.control} name="country" label={b.country} options={WORKSHOP_COUNTRIES.map((c) => ({ value: c.code, label: `${c[locale]} (${c.code})` }))} />
          <SelectField control={form.control} name="attendance" label={b.attendance} disabled={Boolean(group?.attendance)}
            options={[{ value: "online", label: b.online }, { value: "offline", label: b.offline }]} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField control={form.control} name="discountType" label={b.discount}
            options={[{ value: "none", label: b.discountNone }, { value: "fixed", label: b.discountFixed }, { value: "percent", label: b.discountPercent }]} />
          {discountType !== "none" && <TextField control={form.control} name="discountValue" label={b.discountValue} inputMode="decimal" dir="ltr" />}
        </div>
        {discountType !== "none" && (
          <TextareaField control={form.control} name="discountReason" label={b.discountReason} description={b.discountReasonHint} rows={2} />
        )}
        <TextField control={form.control} name="paidNow" label={`${b.paidNow}${price ? ` (${price.currency})` : ""}`} description={b.paidNowHint} inputMode="decimal" dir="ltr" />
        {paidInvalid && <p className="text-sm text-destructive" role="alert">{b.paidTooMuch}</p>}
        {paid != null && !Number.isNaN(paid) && <ProofField file={proof} onFile={setProof} error={proofError} onError={setProofError} required />}
        <TextareaField control={form.control} name="note" label={b.note} rows={2} />
        <div className="flex justify-end">
          <SubmitButton pending={pending} disabled={!o || !price || !groupId || (preview !== null && !preview.valid) || paidInvalid}>{b.create}</SubmitButton>
        </div>
      </FieldGroup>

      <aside className="h-fit rounded-xl border bg-card p-4 text-sm shadow-sm" aria-live="polite">
        <h2 className="mb-3 font-semibold">{b.price}</h2>
        {!o ? <p className="text-muted-foreground">{b.pickWorkshop}</p>
          : !price ? <p className="text-destructive" data-testid="price-missing">{b.priceNotConfigured}</p>
          : preview && (
            <dl className="space-y-2" data-testid="price-summary">
              <Row label={b.original} value={formatCurrency(preview.list, price.currency, locale)} />
              {discountType !== "none" && (
                <>
                  <Row label={b.discountAmount} value={preview.valid ? `− ${formatCurrency(preview.discount, price.currency, locale)}` : "—"} />
                  <Row label={b.effectivePercent} value={preview.valid ? `${formatNumber(Math.round(preview.percent * 100) / 100, locale)}%` : "—"} />
                </>
              )}
              <Row label={b.finalPrice} value={formatCurrency(preview.valid && preview.level !== "manager" && preview.level !== "admin" ? preview.final : preview.list, price.currency, locale)} strong />
              {paid != null && !Number.isNaN(paid) && payable != null && (
                <div data-testid="payment-summary" className="space-y-1 border-t pt-2">
                  <Row label={b.paidNow} value={formatCurrency(paid, price.currency, locale)} />
                  <Row label={b.remainingAfter} value={formatCurrency(Math.max(0, Math.round((payable - paid) * 100) / 100), price.currency, locale)} strong />
                  <p className={cn("text-xs font-medium", paid >= payable ? "text-success" : "text-amber-800")}>{paid >= payable ? b.fullPayment : b.partialPayment}</p>
                </div>
              )}
              <div className="mt-3 rounded-md bg-muted/60 p-2 text-xs" data-testid="approval-note">
                <p className="font-medium">{b.approvalNeeded}</p>
                <p className={cn(preview.level === "manager" || preview.level === "admin" ? "text-amber-800" : "text-muted-foreground")}>
                  {!preview.valid ? b.invalidDiscount : preview.level === "none" ? b.approvalNone : preview.level === "employee" ? b.approvalImmediate : preview.level === "manager" ? b.approvalManager : b.approvalAdmin}
                </p>
                {preview.valid && (preview.level === "manager" || preview.level === "admin") && (
                  <p className="mt-1 text-muted-foreground">{b.pendingExplain} <b className="ltr-nums">{formatCurrency(preview.final, price.currency, locale)}</b></p>
                )}
              </div>
            </dl>
          )}
        {o && !price && country && attendance && <p className="mt-2 text-xs text-muted-foreground">{b.pickCountryAttendance}</p>}
      </aside>
    </form>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("ltr-nums", strong && "text-base font-semibold")}>{value}</dd>
    </div>
  );
}

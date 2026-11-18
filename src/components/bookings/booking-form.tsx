"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FormError, SelectField, SubmitButton, TextareaField, TextField } from "@/components/form/fields";
import { SingleDateField } from "@/components/form/multi-date-field";
import { useActionForm } from "@/components/form/use-action-form";
import { useI18n } from "@/components/i18n-provider";
import { createBooking, existingBookings, workshopOptions, type ExistingBooking, type GroupOption } from "@/actions/bookings";
import { searchCustomers, type CustomerHit } from "@/actions/payments";
import { buildBookingSchema, parseMoney } from "@/schemas/bookings";
import { ProofField, uploadProof } from "@/components/bookings/proof-field";
import { WORKSHOP_COUNTRIES, WORKSHOP_CURRENCIES, countryName } from "@/lib/workshop-config.ts";
import { VoiceCapture } from "@/components/bookings/voice-capture";
import { matchGroup, parseBookingSpeech, type SpeechBooking } from "@/lib/voice/booking-parser.ts";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format.ts";
import { fmt } from "@/i18n";
import { cn } from "@/lib/utils";

export type WorkshopChoice = { id: string; companyId: string; name: string };
type VoiceItem = { key: string; label: string; value: string; ok: boolean };

/**
 * Booking form: customer -> workshop -> group -> country + attendance -> the whole workshop or one session -> the price the customer agreed to (typed here)
 * -> paid in full, or a deposit with the day the rest is reminded. The database re-checks everything; nothing here is trusted.
 */
export function BookingForm({ workshops, owners = {}, selfId = "" }: { workshops: WorkshopChoice[]; owners?: Record<string, { value: string; label: string }[]>; selfId?: string }) {
  const { t, locale } = useI18n();
  const b = t.bookings;
  const router = useRouter();
  const [offeringId, setOfferingId] = useState("");
  const [opts, setOpts] = useState<{ offeringId: string; groups: GroupOption[] } | null>(null);
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
  // the employee's "yes, this customer may be booked again in this group" (read by the submit action, so it lives in a ref as well)
  const [confirmed, setConfirmed] = useState("");
  const confirmRef = useRef(false);
  const [existing, setExisting] = useState<{ key: string; rows: ExistingBooking[] } | null>(null);

  // the booking date: today at the latest, 90 days back at the earliest (the database applies the same limits in the company's time zone)
  const [bookedMin, bookedMax] = useMemo(() => {
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    return [iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90)), iso(now)];
  }, []);
  // the reminder day: tomorrow at the earliest, a year ahead at the latest
  const [remindMin, remindMax] = useMemo(() => {
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    return [iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)), iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 365))];
  }, []);
  const schema = useMemo(() => buildBookingSchema({ discount: b.invalidDiscount, reason: b.reasonRequired, money: b.priceInvalid, paidRequired: b.depositRequired, reminder: b.reminderRequired, depositLess: b.depositInvalid }), [b]);
  const workshop = workshops.find((w) => w.id === offeringId) ?? null;

  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { contactId: "", groupId: "", country: "QA", attendance: "online", kind: "full", sessionDate: "", price: "", currency: WORKSHOP_COUNTRIES.find((c) => c.code === "QA")?.currency ?? "QAR", paymentMode: "full", remindOn: "", note: "", bookedOn: "", bookedBy: "", paidNow: "" },
    // a payment needs its proof: the approver checks the amount the employee typed against the receipt
    action: async (values) => {
      const owed = values.paymentMode === "full" ? values.price : values.paidNow;
      if (owed != null && !Number.isNaN(owed) && owed > 0 && !proof) { setProofError(t.payments.proofRequired); return { ok: false as const, error: t.payments.proofRequired, errorKey: "payment.proof_required" }; }
      return createBooking({ ...values, sessionDate: values.kind === "session" ? values.sessionDate : null, confirmRepeat: confirmRef.current });
    },
    onSuccess: async (data) => {
      if (data.paymentError) toast.warning(`${b.createdPaymentFailed} ${data.paymentError}`, { duration: Infinity, closeButton: true });   // stays until closed: a missed payment is money
      else if (data.paymentId && proof && !(await uploadProof(data.paymentId, proof))) toast.warning(t.payments.savedNoProof, { duration: Infinity, closeButton: true });
      else if (data.awaitingApproval) toast.info(data.paymentId ? b.createdAwaitingWithPayment : b.createdAwaiting);
      else toast.success(b.created);
      router.push(`/bookings/${data.bookingId}`);
    },
  });
  const country = form.watch("country");
  const attendance = form.watch("attendance");
  const groupId = form.watch("groupId");
  const kind = form.watch("kind");
  const paymentMode = form.watch("paymentMode");
  const currency = String(form.watch("currency") ?? "");
  const remindOn = form.watch("remindOn");
  const sessionDate = form.watch("sessionDate");
  const contactId = form.watch("contactId");
  // what this customer already has in this group (the same customer may pay more than once; the employee confirms it)
  const existKey = contactId && groupId ? `${contactId}:${groupId}` : "";
  useEffect(() => {
    if (!existKey) return;
    let live = true;
    void existingBookings({ contactId, groupId }).then((r) => { if (live) setExisting({ key: existKey, rows: r.ok ? r.data : [] }); });
    return () => { live = false; };
  }, [existKey, contactId, groupId]);
  const existingRows = existing && existing.key === existKey ? existing.rows : [];
  // a repeat = the whole workshop again, a booking over a whole-workshop one, or the same session again
  const conflicts = existingRows.filter((x) => kind === "full" || x.kind === "full" || x.sessionDate === sessionDate);
  // the currency follows the country until the employee picks another one
  useEffect(() => { const c = WORKSHOP_COUNTRIES.find((x) => x.code === country); if (c && !form.getFieldState("currency").isDirty) form.setValue("currency", c.currency); }, [country, form]);
  const confirmKey = `${existKey}:${kind}:${kind === "session" ? sessionDate : ""}`;
  const confirmRepeat = conflicts.length > 0 && confirmed === confirmKey;
  useEffect(() => { confirmRef.current = confirmRepeat; }, [confirmRepeat]);

  // customer search (debounced; the company comes from the chosen workshop, or the first one)
  const searchCompany = workshop?.companyId ?? workshops[0]?.companyId ?? "";
  const ownerChoices = owners[searchCompany] ?? [];   // who I may book for in this company (empty = no choice shown)
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

  /** With the workshop's groups known: pick the spoken group. */
  const finishVoice = (options: { groups: GroupOption[] }, said: SpeechBooking) => {
    const vb = t.voiceBooking;
    let chosen: GroupOption | null = options.groups.find((g) => g.id === form.getValues("groupId")) ?? null;
    if (said.group) {
      const r = matchGroup(said.group, options.groups);
      const g = r.id ? options.groups.find((x) => x.id === r.id) ?? null : null;
      if (g && !(g.capacity != null && g.booked >= g.capacity)) {
        form.setValue("groupId", g.id, { shouldValidate: true, shouldDirty: true });
        putVoiceItem({ key: "group", label: b.group, value: g.name, ok: true });
        chosen = g;
      } else putVoiceItem({ key: "group", label: b.group, value: `${said.group.text} — ${g ? vb.fullGroup : vb.noGroup}`, ok: false });
    }
    void chosen;
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
  const priceNum = parseMoney(form.watch("price"));   // null = empty, NaN = invalid
  const priceOk = priceNum != null && !Number.isNaN(priceNum);
  const paid = parseMoney(form.watch("paidNow"));
  const depositBad = paymentMode === "deposit" && paid != null && (Number.isNaN(paid) || (priceOk && paid >= priceNum));
  // what is paid today: the whole price, or the deposit
  const toPay = paymentMode === "full" ? (priceOk ? priceNum : null) : (paid != null && !Number.isNaN(paid) ? paid : null);
  const remaining = priceOk && toPay != null ? Math.max(0, Math.round((priceNum - toPay) * 100) / 100) : null;

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
    const needsOptions = Boolean(p.group);
    const workshopNow = p.workshopId ?? offeringId;
    if (needsOptions && !workshopNow) {
      if (p.group) add("group", b.group, `${p.group.text} — ${vb.needWorkshop}`, false);
      if (p.group) pendingVoice.current = null;
    } else if (needsOptions) {
      if (!p.workshopId || p.workshopId === offeringId) {
        if (o) finishVoice(o, p); else pendingVoice.current = p;
      } else pendingVoice.current = p;
    }
    if (p.country) { form.setValue("country", p.country, { shouldDirty: true }); add("country", b.country, countryName(p.country, locale === "ar" ? "ar" : "en")); }
    if (p.attendance) { form.setValue("attendance", p.attendance, { shouldDirty: true }); add("attendance", b.attendance, p.attendance === "online" ? b.online : b.offline); }
    if (p.discount) add("discount", b.discount, vb.discountRemoved, false);
    if (p.paidFull) { form.setValue("paymentMode", "full", { shouldDirty: true }); add("paid", b.paymentMode, b.payFull); }
    if (p.paidNow != null) {
      form.setValue(form.getValues("paymentMode") === "deposit" ? "paidNow" : "price", String(p.paidNow), { shouldDirty: true, shouldValidate: true });
      add("paid", form.getValues("paymentMode") === "deposit" ? b.depositPaid : b.priceFull, String(p.paidNow));
    }
    if (p.paidFull || p.paidNow != null) add("proof", t.payments.proofRequired, vb.proofNeeded, false);
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
              <select id="group-select" value={groupId} onChange={(e) => { form.setValue("groupId", e.target.value, { shouldValidate: true }); form.setValue("sessionDate", ""); }}
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
          <SelectField control={form.control} name="kind" label={b.kind} options={[{ value: "full", label: b.kindFull }, { value: "session", label: b.kindSession }]} />
          {kind === "session" && (
            <SelectField control={form.control} name="sessionDate" label={b.sessionPick} emptyLabel={group ? b.pickSession : b.pickGroup} disabled={!group}
              options={(group?.sessions ?? []).map((d) => ({ value: d, label: formatDate(d, "UTC", locale) }))} />
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField control={form.control} name="paymentMode" label={b.paymentMode} options={[{ value: "full", label: b.payFull }, { value: "deposit", label: b.payDeposit }]} />
          <SelectField control={form.control} name="currency" label={b.currency} options={WORKSHOP_CURRENCIES.map((c) => ({ value: c, label: c }))} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField control={form.control} name="price" label={paymentMode === "full" ? (kind === "session" ? b.pricePaidSession : b.pricePaidFull) : (kind === "session" ? b.priceTotalSession : b.priceTotalFull)} description={b.priceHint} inputMode="decimal" dir="ltr" />
          {paymentMode === "deposit" && <TextField control={form.control} name="paidNow" label={b.depositPaid} inputMode="decimal" dir="ltr" />}
        </div>
        {paymentMode === "deposit" && <SingleDateField control={form.control} name="remindOn" label={b.remindOn} description={b.remindHint} min={remindMin} max={remindMax} />}
        {depositBad && <p className="text-sm text-destructive" role="alert">{b.depositInvalid}</p>}
        {toPay != null && toPay > 0 && <ProofField file={proof} onFile={setProof} error={proofError} onError={setProofError} required />}
        {ownerChoices.length > 0 && (
          <SelectField control={form.control} name="bookedBy" label={b.bookedFor} description={b.bookedForHint}
            emptyLabel={b.bookedForMe} options={ownerChoices.filter((o) => o.value !== selfId)} />
        )}
        <SingleDateField control={form.control} name="bookedOn" label={b.bookedOn} description={b.bookedOnHint} min={bookedMin} max={bookedMax} />
        <TextareaField control={form.control} name="note" label={b.note} rows={2} />
        {existingRows.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="repeat-note" role="status">
            <p className="font-medium">{b.repeatTitle}</p>
            <ul className="mt-1.5 grid gap-1">
              {existingRows.map((x) => (
                <li key={x.id}>
                  <b>{x.kind === "session" ? `${b.kindSession}${x.sessionDate ? ` · ${formatDate(x.sessionDate, "UTC", locale)}` : ""}` : b.kindFull}</b>
                  {" — "}<span className="ltr-nums">{formatCurrency(x.finalPrice, x.currency, locale)}</span>
                  {" — "}{b.bookingStatus[x.status as keyof typeof b.bookingStatus] ?? x.status}
                  {x.owner ? ` — ${x.owner}` : ""}{" — "}{formatDate(x.createdAt, "UTC", locale)}
                </li>
              ))}
            </ul>
            {conflicts.length > 0 && (
              <label className="mt-2.5 flex cursor-pointer items-start gap-2 font-medium">
                <input type="checkbox" className="mt-1 size-4" checked={confirmRepeat} data-testid="repeat-confirm"
                  onChange={(e) => setConfirmed(e.target.checked ? confirmKey : "")} />
                <span>{b.repeatConfirm}</span>
              </label>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <SubmitButton pending={pending} disabled={!o || !priceOk || !currency || !groupId || (kind === "session" && !sessionDate) || (conflicts.length > 0 && !confirmRepeat) || depositBad || (paymentMode === "deposit" && (paid == null || !remindOn))}>{b.create}</SubmitButton>
        </div>
      </FieldGroup>

      <aside className="h-fit rounded-xl border bg-card p-4 text-sm shadow-sm" aria-live="polite">
        <h2 className="mb-3 font-semibold">{b.price}</h2>
        {!o ? <p className="text-muted-foreground">{b.pickWorkshop}</p>
          : !priceOk ? <p className="text-muted-foreground" data-testid="price-missing">{b.priceType}</p>
          : (
            <dl className="space-y-2" data-testid="price-summary">
              <Row label={kind === "session" ? b.priceSession : b.priceFull} value={formatCurrency(priceNum, currency, locale)} strong />
              {toPay != null && (
                <div data-testid="payment-summary" className="space-y-1 border-t pt-2">
                  <Row label={paymentMode === "full" ? b.paidNow : b.depositPaid} value={formatCurrency(toPay, currency, locale)} />
                  <Row label={b.remainingAfter} value={formatCurrency(remaining ?? 0, currency, locale)} strong />
                  <p className={cn("text-xs font-medium", (remaining ?? 0) <= 0 ? "text-success" : "text-amber-800")}>{(remaining ?? 0) <= 0 ? b.fullPayment : b.partialPayment}</p>
                  {paymentMode === "deposit" && remindOn && <p className="text-xs text-muted-foreground">{fmt(b.remindSummary, { date: formatDate(remindOn, "UTC", locale) })}</p>}
                </div>
              )}
            </dl>
          )}
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

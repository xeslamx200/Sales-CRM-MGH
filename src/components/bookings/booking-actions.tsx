"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Pencil, UserCog, Percent, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FieldGroup } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FormError, SelectField, SubmitButton, TextareaField, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { ConfirmDialog, FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { approveBooking, approveDiscount, cancelBooking, editBooking, editPayment, reassignBooking, recordBookingPayment, rejectDiscount, requestDiscount } from "@/actions/bookings";
import { buildBookingPaymentSchema, buildDiscountRequestSchema, buildEditBookingSchema, buildEditPaymentSchema, buildReassignBookingSchema } from "@/schemas/bookings";
import { SingleDateField } from "@/components/form/multi-date-field";
import { formatDate } from "@/lib/format.ts";
import { WORKSHOP_CURRENCIES } from "@/lib/workshop-config.ts";
import { ProofField, uploadProof } from "@/components/bookings/proof-field";

/** Record a payment on the booking (booking currency; the database refuses more than what remains, pending included). */
export function RecordPaymentDialog({ bookingId, currency, today }: { bookingId: string; currency: string; today: string }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={<Button size="sm"><Plus />{t.bookings.recordPayment}</Button>} title={t.bookings.recordPayment} description={t.bookings.paymentHint}>
      {(close) => <PaymentForm bookingId={bookingId} currency={currency} today={today} onDone={close} />}
    </FormDialog>
  );
}

function PaymentForm({ bookingId, currency, today, onDone }: { bookingId: string; currency: string; today: string; onDone: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const schema = useMemo(() => buildBookingPaymentSchema({ amount: t.bookings.moneyInvalid }), [t]);
  const [proof, setProof] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { bookingId, amount: "", paidOn: today, note: "" },
    action: async (values) => {
      if (!proof) { setProofError(t.payments.proofRequired); return { ok: false as const, error: t.payments.proofRequired, errorKey: "payment.proof_required" }; }
      return recordBookingPayment(values);
    },
    onSuccess: async (data) => {
      if (proof && !(await uploadProof(data.paymentId, proof))) toast.warning(t.payments.savedNoProof, { duration: Infinity, closeButton: true });
      else toast.success(t.bookings.paymentSaved);
      onDone(); router.refresh();
    },
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <p className="text-xs text-muted-foreground">{t.bookings.currencyOfBooking}: <b>{currency}</b></p>
        <TextField control={form.control} name="amount" label={`${t.bookings.amount} (${currency})`} inputMode="decimal" dir="ltr" />
        <TextField control={form.control} name="paidOn" label={t.bookings.paidOn} type="date" />
        <ProofField file={proof} onFile={setProof} error={proofError} onError={setProofError} required />
        <TextareaField control={form.control} name="note" label={t.bookings.note} rows={2} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** Ask for a discount on an existing booking (policy: up to 10 % at once, above that it waits for a manager / admin). */
export function RequestDiscountDialog({ bookingId }: { bookingId: string }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={<Button size="sm" variant="outline"><Percent />{t.bookings.requestDiscount}</Button>} title={t.bookings.requestDiscount} description={t.bookings.requestDiscountHint}>
      {(close) => <DiscountForm bookingId={bookingId} onDone={close} />}
    </FormDialog>
  );
}

function DiscountForm({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const schema = useMemo(() => buildDiscountRequestSchema({ discount: t.bookings.invalidDiscount, reason: t.bookings.reasonRequired, money: t.bookings.moneyInvalid }), [t]);
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { bookingId, type: "percent", value: "", reason: "" },
    action: requestDiscount,
    successMessage: t.bookings.requestSent,
    onSuccess: () => { onDone(); router.refresh(); },
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <SelectField control={form.control} name="type" label={t.bookings.discount} options={[{ value: "percent", label: t.bookings.discountPercent }, { value: "fixed", label: t.bookings.discountFixed }]} />
        <TextField control={form.control} name="value" label={t.bookings.discountValue} inputMode="decimal" dir="ltr" />
        <TextareaField control={form.control} name="reason" label={t.bookings.discountReason} description={t.bookings.discountReasonHint} rows={2} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** A dialog that asks for a reason (>= 3 characters) before running a sensitive action. */
function ReasonDialog({ trigger, title, hint, label, confirmLabel, destructive, onSubmit, success }: {
  trigger: React.ReactNode; title: string; hint?: string; label: string; confirmLabel: string; destructive?: boolean;
  onSubmit: (reason: string) => Promise<{ ok: boolean; error?: string }>; success: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const short = reason.trim().length < 3;
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setReason(""); setError(null); } }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {hint && <DialogDescription>{hint}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="reason-input">{label}</Label>
          <Textarea id="reason-input" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} />
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t.common.cancel}</Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending || short}
            onClick={() => start(async () => {
              const r = await onSubmit(reason.trim());
              if (r.ok) { toast.success(success); setOpen(false); router.refresh(); } else setError(r.error ?? t.common.errorBody);
            })}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RejectDiscountDialog({ requestId, compact }: { requestId: string; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <ReasonDialog trigger={<Button size={compact ? "xs" : "sm"} variant="outline"><X />{t.bookings.reject}</Button>}
      title={t.bookings.rejectTitle} hint={t.bookings.rejectHint} label={t.bookings.reasonLabel} confirmLabel={t.bookings.reject} destructive success={t.bookings.rejected}
      onSubmit={(reason) => rejectDiscount({ requestId, reason })} />
  );
}

export function CancelBookingDialog({ bookingId }: { bookingId: string }) {
  const { t } = useI18n();
  return (
    <ReasonDialog trigger={<Button size="sm" variant="outline"><Ban />{t.bookings.cancelBooking}</Button>}
      title={t.bookings.cancelTitle} hint={`${t.bookings.cancelHint} ${t.bookings.cancelNote}`} label={t.bookings.reasonLabel} confirmLabel={t.bookings.cancelBooking} destructive success={t.bookings.cancelledMsg}
      onSubmit={(reason) => cancelBooking({ bookingId, reason })} />
  );
}

/** Approve a booking that waits for approval (company admins; the database function decides). */
export function ApproveBookingDialog({ bookingId }: { bookingId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={<Button size="sm" data-testid="approve-booking"><Check />{t.bookings.approveBooking}</Button>}
      title={t.bookings.approveBookingTitle} description={t.bookings.approveBookingHint} confirmLabel={t.bookings.approveBooking}
      successMessage={t.bookings.bookingApproved}
      onConfirm={async () => { const r = await approveBooking({ bookingId }); if (r.ok) router.refresh(); return r; }}
    />
  );
}

/** Reject a booking that waits for approval (company admin) or withdraw it (the person who made it): it is cancelled with a reason. */
export function RejectBookingDialog({ bookingId }: { bookingId: string }) {
  const { t } = useI18n();
  return (
    <ReasonDialog trigger={<Button size="sm" variant="outline" data-testid="reject-booking"><X />{t.bookings.rejectBooking}</Button>}
      title={t.bookings.rejectBookingTitle} hint={t.bookings.rejectBookingHint} label={t.bookings.reasonLabel} confirmLabel={t.bookings.rejectBooking} destructive success={t.bookings.cancelledMsg}
      onSubmit={(reason) => cancelBooking({ bookingId, reason })} />
  );
}

/** Approve a pending discount (confirmation first; the database refuses self-approval and the wrong level). */
export function ApproveDiscountDialog({ requestId, compact }: { requestId: string; compact?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setNote(""); setError(null); } }}>
      <DialogTrigger asChild><Button size={compact ? "xs" : "sm"}><Check />{t.bookings.approve}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.bookings.approveTitle}</DialogTitle>
          <DialogDescription>{t.bookings.approveHint}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="approve-note">{t.bookings.approveNote}</Label>
          <Textarea id="approve-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} />
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t.common.cancel}</Button>
          <Button disabled={pending} onClick={() => start(async () => {
            const r = await approveDiscount({ requestId, note: note.trim() || null });
            if (r.ok) { toast.success(t.bookings.approved); setOpen(false); router.refresh(); } else setError(r.error);
          })}>{t.bookings.approve}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type EditablePayment = { id: string; amount: number; status: string; paidOn: string };

/** Super admin: correct the price, currency, payment mode, reminder day AND the amounts paid of an open booking (one reason; the history keeps before / after). */
export function EditBookingDialog({ bookingId, price, currency, paymentMode, remindOn, currencyLocked, payments }: {
  bookingId: string; price: number; currency: string; paymentMode: "full" | "deposit"; remindOn: string; currencyLocked: boolean; payments: EditablePayment[];
}) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={<Button size="sm" variant="outline" data-testid="edit-booking"><Pencil />{t.bookings.editBooking}</Button>} title={t.bookings.editBooking} description={t.bookings.editBookingHint}>
      {(close) => <EditBookingForm bookingId={bookingId} price={price} currency={currency} paymentMode={paymentMode} remindOn={remindOn} currencyLocked={currencyLocked} payments={payments} onDone={close} />}
    </FormDialog>
  );
}

function EditBookingForm({ bookingId, price, currency, paymentMode, remindOn, currencyLocked, payments, onDone }: {
  bookingId: string; price: number; currency: string; paymentMode: "full" | "deposit"; remindOn: string; currencyLocked: boolean; payments: EditablePayment[]; onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const schema = useMemo(() => buildEditBookingSchema({ money: t.bookings.priceInvalid, reminder: t.bookings.reminderRequired, reason: t.bookings.editReasonRequired }), [t]);
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { bookingId, price: String(price), currency, paymentMode, remindOn, payments: payments.map((p) => ({ paymentId: p.id, amount: String(p.amount) })), reason: "" },
    action: editBooking,
    successMessage: t.bookings.editSaved,
    onSuccess: () => { onDone(); router.refresh(); },
  });
  const mode = form.watch("paymentMode");
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="price" label={t.bookings.priceTotalFull} inputMode="decimal" dir="ltr" />
        <SelectField control={form.control} name="currency" label={t.bookings.currency} disabled={currencyLocked} options={WORKSHOP_CURRENCIES.map((c) => ({ value: c, label: c }))} />
        {currencyLocked && <p className="text-xs text-muted-foreground">{t.bookings.currencyLockedNote}</p>}
        <SelectField control={form.control} name="paymentMode" label={t.bookings.paymentMode} options={[{ value: "full", label: t.bookings.payFull }, { value: "deposit", label: t.bookings.payDeposit }]} />
        {mode === "deposit" && <SingleDateField control={form.control} name="remindOn" label={t.bookings.remindOn} description={t.bookings.remindHint} />}
        {payments.length === 0 && <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-testid="edit-booking-no-payments">{t.bookings.editNoPayments}</p>}
        {payments.length > 0 && (
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-3" data-testid="edit-booking-payments">
            <p className="text-sm font-medium">{t.bookings.editPaymentsTitle}</p>
            {payments.map((p, i) => (
              <TextField key={p.id} control={form.control} name={`payments.${i}.amount`} inputMode="decimal" dir="ltr"
                label={`${formatDate(p.paidOn, "UTC", locale)} · ${t.payments.status[p.status as "pending" | "confirmed" | "rejected"] ?? p.status} (${currency})`} />
            ))}
          </div>
        )}
        <TextareaField control={form.control} name="reason" label={t.bookings.editReason} description={t.bookings.editReasonHint} rows={2} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** Super admin: correct the amount of a payment (a reason is mandatory). */
export function EditPaymentDialog({ bookingId, paymentId, amount, currency }: { bookingId: string; paymentId: string; amount: number; currency: string }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={<Button size="icon-sm" variant="ghost" aria-label={t.bookings.editPayment} title={t.bookings.editPayment} data-testid="edit-payment"><Pencil /></Button>}
      title={t.bookings.editPayment} description={t.bookings.editPaymentHint}>
      {(close) => <EditPaymentForm bookingId={bookingId} paymentId={paymentId} amount={amount} currency={currency} onDone={close} />}
    </FormDialog>
  );
}

function EditPaymentForm({ bookingId, paymentId, amount, currency, onDone }: { bookingId: string; paymentId: string; amount: number; currency: string; onDone: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const schema = useMemo(() => buildEditPaymentSchema({ amount: t.bookings.moneyInvalid, reason: t.bookings.editReasonRequired }), [t]);
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { bookingId, paymentId, amount: String(amount), reason: "" },
    action: editPayment,
    successMessage: t.bookings.editSaved,
    onSuccess: () => { onDone(); router.refresh(); },
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <p className="text-xs text-muted-foreground">{t.bookings.currencyOfBooking}: <b>{currency}</b></p>
        <TextField control={form.control} name="amount" label={`${t.bookings.amount} (${currency})`} inputMode="decimal" dir="ltr" />
        <TextareaField control={form.control} name="reason" label={t.bookings.editReason} description={t.bookings.editReasonHint} rows={2} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** Admin: move the booking (and its payments) to another employee of the company, so the sale is credited to her (a reason is mandatory). */
export function ReassignBookingDialog({ bookingId, currentOwnerId, options }: { bookingId: string; currentOwnerId: string; options: { id: string; name: string }[] }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={<Button size="sm" variant="outline" data-testid="reassign-booking"><UserCog />{t.bookings.reassign}</Button>} title={t.bookings.reassign} description={t.bookings.reassignHint}>
      {(close) => <ReassignBookingForm bookingId={bookingId} currentOwnerId={currentOwnerId} options={options} onDone={close} />}
    </FormDialog>
  );
}

function ReassignBookingForm({ bookingId, currentOwnerId, options, onDone }: { bookingId: string; currentOwnerId: string; options: { id: string; name: string }[]; onDone: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const schema = useMemo(() => buildReassignBookingSchema({ owner: t.bookings.reassignPick, reason: t.bookings.editReasonRequired }), [t]);
  const choices = options.filter((o) => o.id !== currentOwnerId);
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { bookingId, newOwner: "", reason: "" },
    action: reassignBooking,
    successMessage: t.bookings.reassignSaved,
    onSuccess: () => { onDone(); router.refresh(); },
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <SelectField control={form.control} name="newOwner" label={t.bookings.reassignTo} placeholder={t.bookings.reassignPick} options={choices.map((o) => ({ value: o.id, label: o.name }))} />
        <TextareaField control={form.control} name="reason" label={t.bookings.editReason} description={t.bookings.editReasonHint} rows={2} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

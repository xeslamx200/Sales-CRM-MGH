"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { reviewPayment } from "@/actions/payments";

/** Confirm / reject (pending) or reverse a confirmation (admins). The database decides who may do what; the page only shows what applies. */
export function ReviewButtons({ id, status, canReview, canReverse }: { id: string; status: string; canReview: boolean; canReverse: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  if (status === "pending" && canReview) {
    return (
      <div className="flex items-center gap-1">
        <ConfirmDialog
          trigger={<Button size="xs"><Check />{t.payments.confirm}</Button>}
          title={t.payments.confirmTitle} description={t.payments.confirmHint} confirmLabel={t.payments.confirm}
          successMessage={t.payments.confirmed}
          onConfirm={async () => { const r = await reviewPayment({ id, decision: "confirmed" }); if (r.ok) router.refresh(); return r; }}
        />
        <RejectDialog id={id} title={t.payments.rejectTitle} trigger={<Button size="xs" variant="outline"><X />{t.payments.reject}</Button>} />
      </div>
    );
  }
  if (status === "confirmed" && canReverse) {
    return <RejectDialog id={id} title={t.payments.reverseTitle} hint={t.payments.reverseHint} trigger={<Button size="xs" variant="ghost"><Undo2 />{t.payments.reverse}</Button>} />;
  }
  return null;
}

function RejectDialog({ id, title, hint, trigger }: { id: string; title: string; hint?: string; trigger: React.ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setReason(""); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {hint && <DialogDescription>{hint}</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`reason-${id}`}>{t.payments.reasonLabel}</Label>
          <Textarea id={`reason-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} placeholder={t.payments.reasonPlaceholder} />
        </div>
        <DialogFooter>
          <Button variant="destructive" disabled={pending || !reason.trim()} onClick={() => start(async () => {
            const r = await reviewPayment({ id, decision: "rejected", note: reason });
            if (r.ok) { toast.success(t.payments.rejected); setOpen(false); router.refresh(); } else toast.error(r.error);
          })}>
            {pending && <Loader2 className="animate-spin" />}{t.payments.reject}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

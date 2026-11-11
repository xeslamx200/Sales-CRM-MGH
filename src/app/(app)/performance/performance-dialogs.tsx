"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Settings2, Target, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useI18n } from "@/components/i18n-provider";
import { fmt } from "@/i18n";
import { saveCommissionTiers, setMonthlyTarget } from "@/actions/performance";
import { checkTierDrafts, MAX_TIERS, type Tier, type TierDraft } from "@/lib/commission.ts";

const toDraft = (t: Tier): TierDraft => ({ minPercent: String(Math.round(t.min * 10000) / 100), ratePercent: String(Math.round(t.rate * 10000) / 100) });

/** Company admins: replace the commission tiers. Percentages in the form, fractions on the wire (same rules as the database). */
export function TiersDialog({ companyId, tiers }: { companyId: string; tiers: Tier[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TierDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const errText: Record<string, string> = {
    empty_row: t.performance.errEmptyRow, invalid_number: t.performance.errNumber, order: t.performance.errOrder,
    rate_order: t.performance.errRateOrder, too_many: t.performance.errTooMany,
  };
  const set = (i: number, k: keyof TierDraft, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) { setRows(tiers.map(toDraft)); setError(null); } }}>
      <DialogTrigger asChild><Button variant="outline" size="sm"><Settings2 />{t.performance.editRules}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.performance.rules}</DialogTitle>
          <DialogDescription>{t.performance.rulesHint}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {rows.length > 0 && (
            <div className="grid grid-cols-[1fr_1fr_2rem] gap-2 text-xs text-muted-foreground">
              <span>{t.performance.minPercent}</span><span>{t.performance.ratePercent}</span><span />
            </div>
          )}
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_2rem] items-center gap-2">
              <Input value={r.minPercent} onChange={(e) => set(i, "minPercent", e.target.value)} inputMode="decimal" dir="ltr" aria-label={t.performance.minPercent} />
              <Input value={r.ratePercent} onChange={(e) => set(i, "ratePercent", e.target.value)} inputMode="decimal" dir="ltr" aria-label={t.performance.ratePercent} />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t.performance.removeTier} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={rows.length >= MAX_TIERS}
            onClick={() => setRows((x) => [...x, { minPercent: "", ratePercent: "" }])}><Plus />{t.performance.addTier}</Button>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button disabled={pending} onClick={() => {
            const c = checkTierDrafts(rows);
            if (!c.ok) return void setError(errText[c.reason]);
            setError(null);
            start(async () => {
              const res = await saveCommissionTiers({ companyId, tiers: c.tiers });
              if (res.ok) { toast.success(t.performance.saved); setOpen(false); router.refresh(); } else setError(res.error);
            });
          }}>{pending && <Loader2 className="animate-spin" />}{t.performance.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Managers: the two targets of one employee for the month shown. */
export function TargetDialog({ currency, companyId, userId, name, month, amount, customers }:
  { currency: string; companyId: string; userId: string; name: string; month: string; amount: number | null; customers: number | null }) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState("");
  const [cus, setCus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) { setAmt(amount == null ? "" : String(amount)); setCus(customers == null ? "" : String(customers)); setError(null); } }}>
      <DialogTrigger asChild><Button variant="ghost" size="xs"><Target />{t.performance.setTarget}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.performance.targetTitle} · {name}</DialogTitle>
          <DialogDescription>{fmt(t.performance.targetHint, { currency })} <bdi className="ltr-nums">{month.slice(0, 7)}</bdi></DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`t-amt-${userId}`}>{fmt(t.performance.targetAmount, { currency })}</Label>
            <Input id={`t-amt-${userId}`} value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" dir="ltr" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`t-cus-${userId}`}>{t.performance.targetCustomers}</Label>
            <Input id={`t-cus-${userId}`} value={cus} onChange={(e) => setCus(e.target.value)} inputMode="numeric" dir="ltr" />
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button disabled={pending} onClick={() => start(async () => {
            const res = await setMonthlyTarget({ companyId, userId, month, amountEgp: amt, customers: cus });
            if (res.ok) { toast.success(t.performance.saved); setOpen(false); router.refresh(); } else setError(res.error);
          })}>{pending && <Loader2 className="animate-spin" />}{t.performance.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

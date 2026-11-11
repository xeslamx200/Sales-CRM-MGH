"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useI18n } from "@/components/i18n-provider";
import { endShift, saveShift } from "@/actions/shifts";
import { cn } from "@/lib/utils";

export type ShiftPerson = { userId: string; name: string; shift: { starts: string; ends: string; weekdays: number[] } | null };

/** Set or end the shift of one employee (admins). The company time zone applies; an end earlier than the start crosses midnight. */
export function ShiftDialog({ companyId, people, tz }: { companyId: string; people: ShiftPerson[]; tz: string }) {
  const { t } = useI18n();
  const s = t.shifts;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState(people[0]?.userId ?? "");
  const current = people.find((p) => p.userId === userId)?.shift ?? null;
  const [starts, setStarts] = useState(current?.starts ?? "10:00");
  const [ends, setEnds] = useState(current?.ends ?? "19:00");
  const [days, setDays] = useState<number[]>(current?.weekdays ?? [7, 1, 2, 3, 4]);
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pick = (id: string) => {
    setUserId(id);
    const sh = people.find((p) => p.userId === id)?.shift;
    setStarts(sh?.starts ?? "10:00"); setEnds(sh?.ends ?? "19:00"); setDays(sh?.weekdays ?? [7, 1, 2, 3, 4]);
  };
  const toggle = (d: number) => setDays((v) => (v.includes(d) ? v.filter((x) => x !== d) : [...v, d].sort((a, b) => a - b)));
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => start(async () => {
    setError(null);
    const r = await fn();
    if (r.ok) { toast.success(done); setOpen(false); router.refresh(); } else setError(r.error ?? t.common.errorBody);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Clock />{s.setShift}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{s.setShift}</DialogTitle>
          <DialogDescription>{s.setHint} ({tz})</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="shift-user">{s.employee}</Label>
            <select id="shift-user" value={userId} onChange={(e) => pick(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
              {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label htmlFor="shift-start">{s.starts}</Label><Input id="shift-start" type="time" value={starts} onChange={(e) => setStarts(e.target.value)} dir="ltr" /></div>
            <div className="grid gap-1.5"><Label htmlFor="shift-end">{s.ends}</Label><Input id="shift-end" type="time" value={ends} onChange={(e) => setEnds(e.target.value)} dir="ltr" /></div>
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-sm font-medium">{s.days}</legend>
            <div className="flex flex-wrap gap-1.5">
              {[7, 1, 2, 3, 4, 5, 6].map((d) => (
                <button key={d} type="button" aria-pressed={days.includes(d)} onClick={() => toggle(d)}
                  className={cn("rounded-md border px-2.5 py-1 text-sm", days.includes(d) ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted")}>
                  {s.weekdays[d - 1]}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor="shift-from">{s.from}</Label>
            <Input id="shift-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" />
            <p className="text-xs text-muted-foreground">{s.fromHint}</p>
          </div>
          {starts === ends && <p className="text-sm text-destructive" role="alert">{s.sameTimes}</p>}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          {current && <Button variant="outline" disabled={pending} onClick={() => run(() => endShift({ companyId, userId }), s.ended)}>{s.endShift}</Button>}
          <Button disabled={pending || days.length === 0 || !userId || starts === ends} onClick={() => run(() => saveShift({ companyId, userId, starts, ends, weekdays: days, from: from || null }), s.saved)}>{t.common.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

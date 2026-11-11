"use client";
import { useState, useTransition } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { addHoliday, removeHoliday, saveBusinessHours } from "@/actions/business-hours";

export type Interval = { weekday: number; opens: string; closes: string };

// Sunday first (weekday 0 = Sunday, as extract(dow) in the database).
const DAYS = [0, 1, 2, 3, 4, 5, 6];

export function HoursEditor({ companyId, initial }: { companyId: string; initial: Interval[] }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Interval[]>(initial);
  const [pending, start] = useTransition();
  // 2026-10-18 is a Sunday, so 18 + d gives weekday d.
  const dayName = (d: number) =>
    new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 18 + d)));
  const update = (i: number, patch: Partial<Interval>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const invalid = rows.some((r) => !r.opens || !r.closes || r.opens >= r.closes);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y">
        {DAYS.map((d) => {
          const items = rows.map((r, i) => ({ r, i })).filter((x) => x.r.weekday === d);
          return (
            <li key={d} className="flex flex-wrap items-start gap-3 py-2" data-weekday={d}>
              <span className="w-24 pt-1.5 text-sm font-medium">{dayName(d)}</span>
              <div className="flex flex-1 flex-col gap-2">
                {items.length === 0 && <span className="pt-1.5 text-sm text-muted-foreground">{t.hours.closed}</span>}
                {items.map(({ r, i }) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input type="time" dir="ltr" className="w-32" value={r.opens} aria-label={`${dayName(d)} ${t.hours.opens}`}
                      aria-invalid={r.opens >= r.closes || undefined} onChange={(e) => update(i, { opens: e.target.value })} />
                    <span className="text-muted-foreground">–</span>
                    <Input type="time" dir="ltr" className="w-32" value={r.closes} aria-label={`${dayName(d)} ${t.hours.closes}`}
                      aria-invalid={r.opens >= r.closes || undefined} onChange={(e) => update(i, { closes: e.target.value })} />
                    <Button variant="ghost" size="icon-sm" aria-label={`${t.hours.removeInterval} (${dayName(d)})`}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><X /></Button>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" aria-label={`${t.hours.addInterval} (${dayName(d)})`}
                onClick={() => setRows((rs) => [...rs, { weekday: d, opens: items.length ? "16:00" : "08:00", closes: items.length ? "20:00" : "16:00" }])}>
                <Plus />{t.hours.addInterval}
              </Button>
            </li>
          );
        })}
      </ul>
      {invalid && <p className="text-sm text-destructive" role="alert">{t.hours.invalidInterval}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{rows.length === 0 ? t.hours.notConfigured : t.hours.saveHint}</p>
        <Button disabled={pending || invalid} onClick={() => start(async () => {
          const res = await saveBusinessHours({ companyId, hours: rows });
          if (res.ok) toast.success(t.common.saved);
          else toast.error(res.error);
        })}>
          {pending && <Loader2 className="animate-spin" />}{t.common.save}
        </Button>
      </div>
    </div>
  );
}

export function HolidayForm({ companyId }: { companyId: string }) {
  const { t } = useI18n();
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => {
      e.preventDefault();
      start(async () => {
        const res = await addHoliday({ companyId, day, name });
        if (res.ok) {
          toast.success(t.common.saved);
          setDay("");
          setName("");
        } else toast.error(res.error);
      });
    }}>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="holiday-day">{t.common.date}</Label>
          <Input id="holiday-day" type="date" dir="ltr" required value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="holiday-name">{t.common.name}</Label>
          <Input id="holiday-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={pending || !day || !name.trim()}>
        {pending ? <Loader2 className="animate-spin" /> : <Plus />}{t.hours.addHoliday}
      </Button>
    </form>
  );
}

export function HolidayRemoveButton({ companyId, day, name }: { companyId: string; day: string; name: string }) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      trigger={<Button variant="ghost" size="icon-sm" aria-label={`${t.common.delete}: ${name}`}><Trash2 /></Button>}
      title={t.hours.removeHoliday}
      description={name}
      confirmLabel={t.common.delete}
      destructive
      successMessage={t.common.saved}
      onConfirm={() => removeHoliday({ companyId, day })}
    />
  );
}

"use client";
import { useMemo, useState } from "react";
import { Controller, type Control, type FieldValues, type Path } from "react-hook-form";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;   // m is 0-based

/** The value is stored as lines ("2026-12-06\n2026-12-13") or as an array: both are read, an array is written. */
function toList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : [];
  return [...new Set(raw.map((x) => String(x).trim()).filter((x) => ISO.test(x)))].sort();
}

const MAX_DAYS = 60;   // the database accepts at most 60 session days per group

/** Pick the days of a group on a calendar instead of typing dates. Tap a day to add it, tap it again (or the x on its chip) to remove it. */
export function MultiDateField<T extends FieldValues>({ control, name, label, description }: { control: Control<T>; name: Path<T>; label: string; description?: string }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel>{label}</FieldLabel>
          <DaysCalendar value={toList(field.value)} onChange={(v) => field.onChange(v)} />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

function DaysCalendar({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t, locale } = useI18n();
  const w = t.workshopConfig;
  const today = useMemo(() => new Date(), []);
  const first = value[0];
  const [view, setView] = useState(() => (first ? { y: Number(first.slice(0, 4)), m: Number(first.slice(5, 7)) - 1 } : { y: today.getFullYear(), m: today.getMonth() }));
  const tag = locale === "ar" ? "ar-u-nu-latn" : "en-GB";
  const weekStart = locale === "ar" ? 6 : 0;   // Saturday in Arabic, Sunday in English
  const selected = new Set(value);
  const todayIso = iso(today.getFullYear(), today.getMonth(), today.getDate());

  const monthLabel = new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(view.y, view.m, 1)));
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(tag, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + ((weekStart + i) % 7)))));   // 4 Jan 2026 is a Sunday
  const offset = (new Date(Date.UTC(view.y, view.m, 1)).getUTCDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(offset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  const step = (delta: number) => setView((v) => { const d = new Date(Date.UTC(v.y, v.m + delta, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; });
  const toggle = (day: string) => {
    if (selected.has(day)) onChange(value.filter((x) => x !== day));
    else if (value.length < MAX_DAYS) onChange([...value, day].sort());
  };
  const Prev = locale === "ar" ? ChevronRight : ChevronLeft;   // "previous" points toward the start of the reading direction
  const Next = locale === "ar" ? ChevronLeft : ChevronRight;

  return (
    <div className="grid gap-2" data-testid="days-calendar">
      <div className="rounded-xl border bg-card p-2">
        <div className="mb-1 flex items-center justify-between">
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => step(-1)} aria-label={w.prevMonth}><Prev /></Button>
          <span className="text-sm font-medium" aria-live="polite">{monthLabel}</span>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => step(1)} aria-label={w.nextMonth}><Next /></Button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground">
          {weekdays.map((d, i) => <span key={i} className="py-1">{d}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d, i) => {
            if (d === null) return <span key={`e${i}`} />;
            const day = iso(view.y, view.m, d);
            const on = selected.has(day);
            return (
              <button
                key={day} type="button" onClick={() => toggle(day)} aria-pressed={on} data-day={day}
                aria-label={new Intl.DateTimeFormat(tag, { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`))}
                className={cn("ltr-nums flex h-9 items-center justify-center rounded-lg text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "bg-primary font-semibold text-primary-foreground" : "hover:bg-muted", day === todayIso && !on && "ring-1 ring-primary/60")}
              >{d}</button>
            );
          })}
        </div>
      </div>
      {value.length === 0 ? <p className="text-xs text-muted-foreground">{w.noDaysChosen}</p> : (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="chosen-days">
          {value.map((d) => (
            <span key={d} className="ltr-nums inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs" dir="ltr">
              {d.replaceAll("-", "/")}
              <button type="button" onClick={() => toggle(d)} aria-label={`${w.removeDay} ${d}`} className="rounded-full p-0.5 hover:bg-background"><X className="size-3" /></button>
            </span>
          ))}
          <button type="button" onClick={() => onChange([])} className="text-xs text-primary hover:underline">{w.clearDays}</button>
        </div>
      )}
      {value.length >= MAX_DAYS && <p className="text-xs text-muted-foreground">{w.maxDays}</p>}
    </div>
  );
}

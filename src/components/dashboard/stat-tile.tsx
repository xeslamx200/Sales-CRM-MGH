import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatNumber } from "@/lib/format.ts";
import type { Locale } from "@/i18n";
import { cn } from "@/lib/utils";

/** The change against the previous period. Direction is shown by the arrow and the sign, never by colour alone. */
export function Delta({ pct, locale, label }: { pct: number | null; locale: Locale; label?: string }) {
  if (pct === null) return null;
  const rounded = Math.round(pct * 10) / 10;
  const up = rounded > 0, down = rounded < 0;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  return (
    <span title={label} className={cn("inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium ltr-nums",
      up && "bg-emerald-50 text-emerald-800", down && "bg-red-50 text-red-800", !up && !down && "bg-muted text-muted-foreground")}>
      <Icon className="size-3.5" aria-hidden />{up ? "+" : down ? "−" : ""}{formatNumber(Math.abs(rounded), locale)}%
    </span>
  );
}

/** A thin 2px line with a soft wash under it and a ringed end dot; decorative, the numbers beside it carry the meaning. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const w = 120, h = 36, pad = 4;
  if (values.length < 2) return <div className={cn("h-9", className)} aria-hidden />;
  const max = Math.max(...values), min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (w - pad * 2), h - pad - ((v - min) / span) * (h - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("h-9 w-full", className)} aria-hidden>
      <path d={area} fill="#2f6fcf" fillOpacity="0.1" />
      <path d={line} fill="none" stroke="#2f6fcf" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="4" fill="#2f6fcf" stroke="#ffffff" strokeWidth="2" />
    </svg>
  );
}

type Icon = React.ComponentType<{ className?: string }>;

/** Label, big value, change vs the previous period and a small trend line. */
export function StatTile({ label, value, hint, delta, locale, icon: IconC, values, testId }:
  { label: string; value: string; hint?: React.ReactNode; delta: number | null; locale: Locale; icon: Icon; values: number[]; testId?: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-card p-4 shadow-[0_1px_2px_rgba(11,31,68,0.06),0_8px_24px_rgba(11,31,68,0.05)] ring-1 ring-foreground/5" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-[color:var(--brand-gold-ink)]"><IconC className="size-[18px]" /></span>
          <span className="truncate text-sm text-muted-foreground">{label}</span>
        </div>
        <Delta pct={delta} locale={locale} />
      </div>
      <div className="ltr-nums self-start text-3xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      <Sparkline values={values} className="mt-auto" />
    </div>
  );
}

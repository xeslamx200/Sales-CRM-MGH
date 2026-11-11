"use client";
import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

const PRESETS = ["today", "yesterday", "this_week", "last_7_days", "this_month", "last_month", "last_30_days", "custom"] as const;

/** Period presets (company time zone) + custom range, kept in the URL. */
export function PeriodPicker({ preset, from, to }: { preset: string; from: string; to: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [custom, setCustom] = useState({ from, to });
  const [mode, setMode] = useState(preset);

  const go = (changes: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    start(() => router.replace(`${pathname}?${sp.toString()}`, { scroll: false }));
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-2", pending && "opacity-70")}>
      <Select
        value={mode}
        onValueChange={(v) => {
          setMode(v);
          if (v !== "custom") go({ period: v, from: null, to: null });
        }}
      >
        <SelectTrigger size="sm" className="w-44" aria-label={t.reports.period}>
          <CalendarRange className="size-4 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => <SelectItem key={p} value={p}>{t.reports.presets[p]}</SelectItem>)}
        </SelectContent>
      </Select>
      {mode === "custom" ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            go({ period: "custom", from: custom.from, to: custom.to });
          }}
        >
          <Input type="date" dir="ltr" className="h-8 w-38" value={custom.from} aria-label={t.common.from}
            onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
          <span className="text-muted-foreground">–</span>
          <Input type="date" dir="ltr" className="h-8 w-38" value={custom.to} aria-label={t.common.to}
            onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          <Button size="sm" type="submit" variant="outline">{t.reports.apply}</Button>
        </form>
      ) : (
        <span className="ltr-nums text-xs text-muted-foreground">{from} – {to}</span>
      )}
    </div>
  );
}

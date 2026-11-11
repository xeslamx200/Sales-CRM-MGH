"use client";
import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

export type FilterDef =
  | { type: "search"; name: string; placeholder?: string }
  | { type: "select"; name: string; label: string; options: { value: string; label: string }[]; allLabel?: string }
  | { type: "date"; name: string; label: string };

const ALL = "__all__";

/** Filters live in the URL so lists are shareable and server-rendered. */
export function FilterBar({ filters, className }: { filters: FilterDef[]; className?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const update = (changes: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "") sp.delete(k);
      else sp.set(k, v);
    }
    sp.delete("page");
    const q = sp.toString();
    start(() => router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false }));
  };

  const active = filters.some((f) => params.get(f.name));

  return (
    <div className={cn("flex flex-wrap items-end gap-2", pending && "opacity-70", className)}>
      {filters.map((f) => {
        if (f.type === "search") {
          return (
            <form
              key={f.name}
              className="relative w-full sm:w-64"
              onSubmit={(e) => {
                e.preventDefault();
                update({ [f.name]: String(new FormData(e.currentTarget).get(f.name) ?? "").trim() || null });
              }}
            >
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input key={params.get(f.name) ?? ""} name={f.name} type="search" defaultValue={params.get(f.name) ?? ""}
                placeholder={f.placeholder ?? t.common.search} className="h-8 ps-8" maxLength={100} />
            </form>
          );
        }
        if (f.type === "select") {
          return (
            <Select key={f.name} value={params.get(f.name) ?? ALL} onValueChange={(v) => update({ [f.name]: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="min-w-36" aria-label={f.label}>
                <span className="text-muted-foreground">{f.label}:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{f.allLabel ?? t.common.all}</SelectItem>
                {f.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        }
        return (
          <label key={f.name} className="flex items-center gap-1 text-sm text-muted-foreground">
            {f.label}
            <Input type="date" className="h-8 w-40" dir="ltr" value={params.get(f.name) ?? ""}
              onChange={(e) => update({ [f.name]: e.target.value || null })} />
          </label>
        );
      })}
      {active && (
        <Button variant="ghost" size="sm" onClick={() => update(Object.fromEntries(filters.map((f) => [f.name, null])))}>
          <X />
          {t.common.clearFilters}
        </Button>
      )}
    </div>
  );
}

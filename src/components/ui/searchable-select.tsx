"use client";
import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type SearchableOption = { value: string; label: string };

/** Search that ignores case, Arabic diacritics and the usual spelling variants (أ إ آ = ا, ى = ي, ة = ه), so "ورشه" finds "ورشة". */
export function normalizeSearch(s: string): string {
  return s.normalize("NFKD").replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase().trim();
}
const matches = (value: string, search: string) => {
  const q = normalizeSearch(search);
  return q.split(/\s+/).every((w) => normalizeSearch(value).includes(w));   // every typed word must appear, in any order
};

/** A select you can type into: opens a list with a search box that filters as you type. For long lists (workshops, courses). */
export function SearchableSelect({
  id, value, onChange, options, placeholder, searchPlaceholder, emptyText, disabled, className,
}: {
  id?: string; value: string; onChange: (v: string) => void; options: SearchableOption[];
  placeholder?: string; searchPlaceholder: string; emptyText: string; disabled?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" size="sm" role="combobox" aria-expanded={open} disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}>
          <span className="min-w-0 truncate" dir="auto">{current?.label ?? placeholder ?? ""}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <Command filter={(v, search) => (matches(v, search) ? 1 : 0)}>
          <CommandInput placeholder={searchPlaceholder} autoFocus />
          <CommandList className="max-h-64">
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={o.label} onSelect={() => { setOpen(false); if (o.value !== value) onChange(o.value); }}>
                  <Check className={cn("size-4 shrink-0", o.value === value ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 truncate" dir="auto">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

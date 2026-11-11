"use client";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/i18n-provider";

/** Submits to /search, which calls the RLS-safe search RPC. */
export function GlobalSearch() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = pathname === "/search" ? params.get("q") ?? "" : "";
  return (
    <form
      role="search"
      className="relative w-full max-w-md"
      onSubmit={(e) => {
        e.preventDefault();
        const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
        if (q.length >= 2) router.push(`/search?q=${encodeURIComponent(q)}`);
      }}
    >
      <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        key={current}
        name="q"
        type="search"
        defaultValue={current}
        placeholder={t.common.searchPlaceholder}
        aria-label={t.common.search}
        className="h-8 ps-8"
        minLength={2}
        maxLength={100}
      />
    </form>
  );
}

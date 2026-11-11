"use client";
import { Direction } from "radix-ui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { I18nProvider } from "@/components/i18n-provider";
import type { Dictionary, Locale } from "@/i18n";

export function Providers({
  locale, dir, t, children,
}: { locale: Locale; dir: "rtl" | "ltr"; t: Dictionary; children: React.ReactNode }) {
  return (
    <I18nProvider value={{ locale, dir, t }}>
      <Direction.DirectionProvider dir={dir}>
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster position={dir === "rtl" ? "bottom-left" : "bottom-right"} richColors closeButton dir={dir} />
        </TooltipProvider>
      </Direction.DirectionProvider>
    </I18nProvider>
  );
}

"use client";
import { createContext, useContext } from "react";
import type { Dictionary, Locale } from "@/i18n";

type I18n = { locale: Locale; dir: "rtl" | "ltr"; t: Dictionary };

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ value, children }: { value: I18n; children: React.ReactNode }) {
  // (zod's language is set by the forms themselves, see useZodLocale: importing zod here put it - with every locale - into every page)
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  return ctx;
}

/** Label for the generic close button of shared UI primitives (works outside the provider too). */
export function useCloseLabel(): string {
  return useContext(I18nContext)?.t.common.close ?? "Close";
}

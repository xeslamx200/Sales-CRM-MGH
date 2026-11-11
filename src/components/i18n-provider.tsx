"use client";
import { createContext, useContext, useEffect } from "react";
import { z } from "zod";
import type { Dictionary, Locale } from "@/i18n";

type I18n = { locale: Locale; dir: "rtl" | "ltr"; t: Dictionary };

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ value, children }: { value: I18n; children: React.ReactNode }) {
  // Client-side validation messages follow the UI language.
  useEffect(() => {
    z.config(value.locale === "ar" ? z.locales.ar() : z.locales.en());
  }, [value.locale]);
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

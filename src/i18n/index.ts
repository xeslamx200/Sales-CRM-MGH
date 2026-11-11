/**
 * i18n: Arabic is the default and the source of truth for keys; English must
 * provide the same shape (enforced by the `Dictionary` type).
 */
import type { Locale } from "@/lib/errors.ts";
import { ar } from "./ar.ts";
import { en } from "./en.ts";

export type { Locale };
export type Dictionary = typeof ar;

const dictionaries: Record<Locale, Dictionary> = { ar, en };

export const DEFAULT_LOCALE: Locale = "ar";
export const LOCALE_COOKIE = "crm_locale";

export function isLocale(v: unknown): v is Locale {
  return v === "ar" || v === "en";
}

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];
}

export function dirFor(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** Replace {name} placeholders. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in values ? String(values[k]) : `{${k}}`));
}

/**
 * Consistent number, currency and date formatting.
 * Decision: Arabic UI with Latin (0–9) digits everywhere, so numbers read the
 * same in tables, exports and phone numbers. Change NUMBERING to "arab" to use
 * Arabic-Indic digits instead.
 */
import type { Locale } from "./errors.ts";

const NUMBERING = "latn";
const tag = (locale: Locale) => (locale === "ar" ? `ar-u-nu-${NUMBERING}` : "en-u-nu-latn");

export function formatNumber(n: number | null | undefined, locale: Locale = "ar"): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat(tag(locale), { maximumFractionDigits: 2 }).format(n);
}

export function formatCurrency(n: number | null | undefined, currency: string, locale: Locale = "ar"): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat(tag(locale), { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

/** Ratios are stored as 0–1; null means "no data", which is not 0%. */
export function formatPercent(ratio: number | null | undefined, locale: Locale = "ar"): string {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  return new Intl.NumberFormat(tag(locale), { style: "percent", maximumFractionDigits: 1 }).format(ratio);
}

export function formatDateTime(value: string | Date | null | undefined, timeZone: string, locale: Locale = "ar"): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(tag(locale), { timeZone, dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function formatDate(value: string | Date | null | undefined, timeZone: string, locale: Locale = "ar"): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value.length === 10 ? value + "T12:00:00Z" : value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(tag(locale), { timeZone, dateStyle: "medium" }).format(d);
}

export function formatDuration(seconds: number | null | undefined, locale: Locale = "ar"): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const units = locale === "ar" ? { h: "س", m: "د", s: "ث" } : { h: "h", m: "m", s: "s" };
  if (h > 0) return `${formatNumber(h, locale)}${units.h} ${formatNumber(m, locale)}${units.m}`;
  if (m > 0) return `${formatNumber(m, locale)}${units.m}`;
  return `${formatNumber(s, locale)}${units.s}`;
}

/** File size with one decimal above 1 KB (1 KB = 1024 bytes). */
export function formatBytes(bytes: number | null | undefined, locale: Locale = "ar"): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  const units = locale === "ar" ? ["بايت", "ك.ب", "م.ب", "ج.ب"] : ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const n = new Intl.NumberFormat(tag(locale), { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v);
  return `${n} ${units[i]}`;
}

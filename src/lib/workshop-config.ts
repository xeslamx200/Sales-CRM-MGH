/** Countries and currencies offered in the workshop price / group screens. The database accepts any ISO-2 country and ISO-3 currency; this is only the pick list. */
export const WORKSHOP_COUNTRIES = [
  { code: "QA", currency: "QAR", ar: "قطر", en: "Qatar" },
  { code: "SA", currency: "SAR", ar: "السعودية", en: "Saudi Arabia" },
  { code: "BH", currency: "BHD", ar: "البحرين", en: "Bahrain" },
  { code: "KW", currency: "KWD", ar: "الكويت", en: "Kuwait" },
  { code: "AE", currency: "AED", ar: "الإمارات", en: "UAE" },
  { code: "OM", currency: "OMR", ar: "عُمان", en: "Oman" },
  { code: "EG", currency: "EGP", ar: "مصر", en: "Egypt" },
] as const;
export const WORKSHOP_CURRENCIES = [...new Set(WORKSHOP_COUNTRIES.map((c) => c.currency)), "USD"] as string[];

export function countryName(code: string, locale: "ar" | "en"): string {
  const c = WORKSHOP_COUNTRIES.find((x) => x.code === code);
  return c ? c[locale] : code;
}

/** "2026-12-06" per line (or separated by commas, spaces or Arabic digits) -> sorted unique ISO dates; null if any token is not a real date. */
export function parseSessionDates(text: string): string[] | null {
  const tokens = text.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).split(/[\s,،;]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 60) return null;
  const out = new Set<string>();
  for (const tk of tokens) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tk);
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
    out.add(tk);
  }
  return [...out].sort();
}

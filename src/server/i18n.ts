import "server-only";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, dirFor, getDictionary, isLocale, type Locale } from "@/i18n";

/** Locale for pages rendered before/without a profile (sign-in, errors). */
export async function requestLocale(): Promise<Locale> {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

export async function requestI18n() {
  const locale = await requestLocale();
  return { locale, dir: dirFor(locale), t: getDictionary(locale) };
}

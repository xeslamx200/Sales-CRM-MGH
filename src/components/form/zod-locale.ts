"use client";
import { useEffect } from "react";
import { useI18n } from "@/components/i18n-provider";

/** Client-side validation messages follow the UI language. Loads zod's ONE locale on demand, only for pages that have a form. */
export function useZodLocale(): void {
  const { locale } = useI18n();
  useEffect(() => {
    let current = true;
    void (async () => {
      const [{ z }, mod] = await Promise.all([import("zod"), locale === "ar" ? import("zod/v4/locales/ar.js") : import("zod/v4/locales/en.js")]);
      if (current) z.config(mod.default());
    })();
    return () => { current = false; };
  }, [locale]);
}

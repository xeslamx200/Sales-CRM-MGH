"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { setGuestLocale, setLocale } from "@/actions/shell";

/**
 * Visible Arabic / English switch. Signed in: saved on the account (profiles.locale) and in the cookie. Signed out (login pages): cookie only.
 * The label names the language you will switch TO, in that language, so it is readable whichever language is active.
 */
export function LanguageToggle({ current, signedIn }: { current: "ar" | "en"; signedIn: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const next = current === "ar" ? "en" : "ar";
  return (
    <Button
      type="button" variant="outline" size="sm" className="rounded-full bg-card" disabled={pending}
      lang={next} aria-label={next === "en" ? "Switch to English" : "التبديل إلى العربية"}
      onClick={() => start(async () => {
        const res = signedIn ? await setLocale({ locale: next }) : await setGuestLocale({ locale: next });
        if (!res.ok) toast.error(res.error); else router.refresh();
      })}
    >
      <Languages />{next === "en" ? "English" : "العربية"}
    </Button>
  );
}

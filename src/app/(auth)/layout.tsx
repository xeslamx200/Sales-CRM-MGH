import { requestI18n } from "@/server/i18n";
import { LanguageToggle } from "@/components/shell/language-toggle";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { t, locale } = await requestI18n();
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <div className="absolute end-4 top-4"><LanguageToggle current={locale} signedIn={false} /></div>
      <div className="flex flex-col items-center gap-2">
        <span className="flex h-20 items-center justify-center rounded-2xl bg-sidebar px-6 shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, transparent PNG */}
          <img src="/mgh-logo.png" alt="MGH Marketing Consultancy" className="h-14 w-auto object-contain" />
        </span>
        <span className="text-lg font-semibold text-sidebar">{t.app.name}</span>
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

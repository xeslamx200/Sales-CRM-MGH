import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import { Providers } from "@/components/providers";
import { requestI18n } from "@/server/i18n";
import "./globals.css";

const font = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-arabic",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestI18n();
  return {
    title: { default: t.app.name, template: `%s · ${t.app.name}` },
    description: t.app.tagline,
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir, t } = await requestI18n();
  return (
    <html lang={locale} dir={dir} className={font.variable} suppressHydrationWarning>
      <body className="min-h-svh">
        <Providers locale={locale} dir={dir} t={t}>
          {children}
        </Providers>
      </body>
    </html>
  );
}

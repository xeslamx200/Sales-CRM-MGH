import type { Metadata } from "next";
import { requestI18n } from "@/server/i18n";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await requestI18n();
  return { title: t.auth.signInTitle };
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { t } = await requestI18n();
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  const notice =
    sp.error === "inactive" ? t.auth.accountInactive
    : sp.error === "link" ? t.auth.linkInvalid
    : undefined;
  return <LoginForm next={next} notice={notice} />;
}

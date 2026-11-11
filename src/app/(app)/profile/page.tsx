import { PageHeader, Section } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { PasswordForm, ProfileForm } from "./profile-forms";

export default async function ProfilePage() {
  const viewer = await getViewer();
  const { t } = viewer;
  const supabase = await createClient();
  const { data: profile } = await supabase.from("profiles").select("full_name, phone, locale").eq("id", viewer.id).single();

  return (
    <>
      <PageHeader title={t.profile.title} description={<span dir="ltr">{viewer.email}</span>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t.profile.details}>
          <ProfileForm defaults={{
            fullName: profile?.full_name ?? "", phone: profile?.phone ?? null, locale: profile?.locale === "en" ? "en" : "ar",
          }} />
        </Section>
        <div className="flex flex-col gap-4">
          <Section title={t.profile.memberships}>
            <ul className="flex flex-col gap-2 text-sm">
              {viewer.isSuperAdmin && <li><StatusBadge tone="primary">{t.profile.superAdmin}</StatusBadge></li>}
              {viewer.companies.filter((c) => c.role).map((c) => (
                <li key={c.id} className="flex items-center justify-between">
                  <span>{c.name}</span>
                  <StatusBadge>{c.role ? t.enums.role[c.role] : ""}</StatusBadge>
                </li>
              ))}
            </ul>
          </Section>
          <Section title={t.profile.changePassword}>
            <PasswordForm />
          </Section>
        </div>
      </div>
    </>
  );
}

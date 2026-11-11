import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { AcceptInviteForm } from "./accept-invite-form";

/** Reached from the invitation e-mail via /auth/confirm (which created the session). */
export default async function AcceptInvitePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login?error=link");
  const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", data.user.id).maybeSingle();
  return <AcceptInviteForm email={data.user.email ?? ""} fullName={profile?.full_name ?? ""} />;
}

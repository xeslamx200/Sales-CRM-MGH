import "server-only";
import { createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";
import { serverEnv } from "@/server/env";
import { AppError, check } from "@/server/action";
import type { Role } from "@/server/auth/viewer";

/**
 * Invite a person to a company with a role.
 *
 * 1. Permission is checked with the CALLER's session (same rules the
 *    database enforces: company admin of that company, and only a super admin
 *    may grant company_admin).
 * 2. The service-role client is used only for what requires it: looking up
 *    whether an account already exists for the e-mail, and the Auth Admin
 *    invite call (which sends the e-mail).
 * 3. The membership row is inserted with the CALLER's session, so RLS, the
 *    membership guard and the audit trigger all apply.
 */
export async function inviteToCompany(input: {
  email: string; fullName: string; companyId: string; role: Role;
}): Promise<{ invited: boolean }> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new AppError("auth.session_expired");

  const [{ data: me }, { data: myMembership }] = await Promise.all([
    supabase.from("profiles").select("is_super_admin").eq("id", auth.user.id).maybeSingle(),
    supabase.from("company_memberships").select("role")
      .eq("company_id", input.companyId).eq("user_id", auth.user.id).eq("is_active", true).maybeSingle(),
  ]);
  const superAdmin = Boolean(me?.is_super_admin);
  if (!superAdmin && myMembership?.role !== "company_admin") throw new AppError("auth.forbidden");
  if (input.role === "company_admin" && !superAdmin) throw new AppError("membership.cannot_manage_company_admin");

  const admin = createAdminClient();
  const { data: existing } = await admin.from("profiles").select("id").eq("email", input.email).maybeSingle();

  let userId = existing?.id;
  let invited = false;
  if (!userId) {
    const { APP_URL } = serverEnv("core");
    const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
      data: { full_name: input.fullName },
      redirectTo: `${APP_URL}/auth/accept-invite`,
    });
    if (error || !data.user) throw new AppError("invite.failed");
    userId = data.user.id;
    invited = true;
  }

  const { data: already } = await supabase.from("company_memberships").select("id")
    .eq("company_id", input.companyId).eq("user_id", userId).maybeSingle();
  if (already) throw new AppError("membership.already_member");

  check(await supabase.from("company_memberships").insert({ company_id: input.companyId, user_id: userId, role: input.role }));
  return { invited };
}

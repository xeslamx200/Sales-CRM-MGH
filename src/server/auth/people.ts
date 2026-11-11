import "server-only";
import { createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";
import { AppError, check } from "@/server/action";
import type { Role } from "@/server/auth/viewer";

/**
 * Account management for a company admin: create a person with e-mail and password, edit their details, reset their password,
 * remove them from the company.
 *
 * Same rules as the invitation (src/server/auth/invite.ts):
 *  - permission is decided with the CALLER's session (company admin of that company, or super admin); only a super admin
 *    may create or change a company admin or a super admin;
 *  - the service-role client is used only for what needs it (the Auth Admin API, reading / writing the profile of a member), never
 *    before that check, and only for a person who belongs to the caller's company;
 *  - memberships and teams are written with the CALLER's session, so RLS, the membership guard and the audit trigger apply.
 * Passwords are never logged, never returned and never written to the audit trail.
 */

type Ctx = { supabase: Awaited<ReturnType<typeof createClient>>; callerId: string; superAdmin: boolean };

async function authorize(companyId: string): Promise<Ctx> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new AppError("auth.session_expired");
  const [{ data: me }, { data: mine }] = await Promise.all([
    supabase.from("profiles").select("is_super_admin").eq("id", auth.user.id).maybeSingle(),
    supabase.from("company_memberships").select("role").eq("company_id", companyId).eq("user_id", auth.user.id).eq("is_active", true).maybeSingle(),
  ]);
  const superAdmin = Boolean(me?.is_super_admin);
  if (!superAdmin && mine?.role !== "company_admin") throw new AppError("auth.forbidden");
  return { supabase, callerId: auth.user.id, superAdmin };
}

async function loadTarget(ctx: Ctx, companyId: string, userId: string) {
  const { data: m } = await ctx.supabase.from("company_memberships").select("id, role").eq("company_id", companyId).eq("user_id", userId).maybeSingle();
  if (!m) throw new AppError("people.not_member");
  const admin = createAdminClient();
  const { data: p } = await admin.from("profiles").select("id, is_super_admin, email").eq("id", userId).maybeSingle();
  if (!p) throw new AppError("people.not_member");
  if ((p.is_super_admin || m.role === "company_admin") && !ctx.superAdmin) throw new AppError("membership.cannot_manage_company_admin");
  return { membershipId: m.id, role: m.role as Role, email: p.email ?? "", admin };
}

async function audit(ctx: Ctx, companyId: string, action: string, userId: string, metadata: Record<string, unknown> = {}) {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_logs").insert({ company_id: companyId, actor_id: ctx.callerId, action, entity_type: "user", entity_id: userId, metadata: metadata as never });
  if (error) console.error("[people] could not write the audit row", { code: error.code });
}

const emailTaken = (m: string | undefined) => /already|registered|exists|duplicate/i.test(m ?? "");

export async function createPerson(input: {
  companyId: string; fullName: string; email: string; phone: string | null; role: Role; password: string; teamId: string | null;
}): Promise<{ createdAccount: boolean }> {
  const ctx = await authorize(input.companyId);
  if (input.role === "company_admin" && !ctx.superAdmin) throw new AppError("membership.cannot_manage_company_admin");
  const admin = createAdminClient();
  const { data: existing } = await admin.from("profiles").select("id, is_super_admin").eq("email", input.email).maybeSingle();

  let userId = existing?.id;
  let created = false;
  if (existing) {
    // The person already has an account (another company): only attach them; their password is never touched here.
    if (existing.is_super_admin && !ctx.superAdmin) throw new AppError("membership.cannot_manage_company_admin");
    const { data: already } = await ctx.supabase.from("company_memberships").select("id").eq("company_id", input.companyId).eq("user_id", existing.id).maybeSingle();
    if (already) throw new AppError("membership.already_member");
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email: input.email, password: input.password, email_confirm: true, user_metadata: { full_name: input.fullName } });
    if (error || !data.user) throw new AppError(emailTaken(error?.message) ? "people.email_in_use" : "people.create_failed");
    userId = data.user.id;
    created = true;
    const { error: pe } = await admin.from("profiles").update({ full_name: input.fullName, phone: input.phone }).eq("id", userId);
    if (pe) console.error("[people] profile update failed", { code: pe.code });
  }
  if (!userId) throw new AppError("people.create_failed");

  const ins = await ctx.supabase.from("company_memberships").insert({ company_id: input.companyId, user_id: userId, role: input.role });
  if (ins.error) {
    if (created) await admin.auth.admin.deleteUser(userId).catch(() => undefined);   // no orphan account when the membership is refused
    check(ins);
  }
  if (input.teamId) check(await ctx.supabase.from("team_memberships").insert({ team_id: input.teamId, company_id: input.companyId, user_id: userId }));
  await audit(ctx, input.companyId, created ? "user.created_by_admin" : "user.attached_by_admin", userId, { role: input.role });
  return { createdAccount: created };
}

export async function updatePerson(input: {
  companyId: string; userId: string; fullName: string; email: string; phone: string | null; role: Role; isActive: boolean;
}): Promise<void> {
  const ctx = await authorize(input.companyId);
  const target = await loadTarget(ctx, input.companyId, input.userId);
  const self = input.userId === ctx.callerId;
  if (self && (input.role !== target.role || !input.isActive)) throw new AppError("people.cannot_change_self");
  if (input.role === "company_admin" && target.role !== "company_admin" && !ctx.superAdmin) throw new AppError("membership.cannot_manage_company_admin");

  if (input.email !== target.email.toLowerCase()) {
    const { error } = await target.admin.auth.admin.updateUserById(input.userId, { email: input.email, email_confirm: true });
    if (error) throw new AppError(emailTaken(error.message) ? "people.email_in_use" : "people.update_failed");
  }
  const { error: pe } = await target.admin.from("profiles").update({ full_name: input.fullName, phone: input.phone }).eq("id", input.userId);
  if (pe) throw new AppError("people.update_failed");
  check(await ctx.supabase.from("company_memberships").update({ role: input.role, is_active: input.isActive }).eq("id", target.membershipId).select("id").single());
  await audit(ctx, input.companyId, "user.updated_by_admin", input.userId, { role: input.role, active: input.isActive });
}

export async function resetPassword(input: { companyId: string; userId: string; password: string }): Promise<void> {
  const ctx = await authorize(input.companyId);
  const target = await loadTarget(ctx, input.companyId, input.userId);
  const { error } = await target.admin.auth.admin.updateUserById(input.userId, { password: input.password });
  if (error) throw new AppError("people.password_failed");
  await audit(ctx, input.companyId, "user.password_reset_by_admin", input.userId);
}

export async function removePerson(input: { companyId: string; userId: string }): Promise<void> {
  const ctx = await authorize(input.companyId);
  if (input.userId === ctx.callerId) throw new AppError("people.cannot_change_self");
  const target = await loadTarget(ctx, input.companyId, input.userId);
  // the person leaves this company (their history stays with their name); the account itself is kept
  await ctx.supabase.from("team_memberships").delete().eq("company_id", input.companyId).eq("user_id", input.userId);
  check(await ctx.supabase.from("company_memberships").delete().eq("id", target.membershipId).select("id").single());
  await audit(ctx, input.companyId, "user.removed_from_company", input.userId);
}

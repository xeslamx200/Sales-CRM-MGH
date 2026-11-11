"use server";
import { z } from "zod";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { runAction, AppError, check, type ActionResult } from "@/server/action";
import { serverEnv } from "@/server/env";
import { LOCALE_COOKIE, isLocale } from "@/i18n";
import { acceptInviteSchema, emailSchema, newPasswordSchema, profileSchema, signInSchema } from "@/schemas/auth";
import { revalidatePath } from "next/cache";
import { clientIp, hashKey, limitAnonymous } from "@/server/rate-limit";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Only same-origin relative paths are accepted as post-login destinations. */
function safeNext(next: unknown): string {
  return typeof next === "string" && /^\/(?![/\\])[^\s]*$/.test(next) ? next : "/";
}

export async function signIn(input: z.input<typeof signInSchema>): Promise<ActionResult<null>> {
  const result = await runAction(signInSchema, input, async ({ email, password }) => {
    const ip = await clientIp();
    await limitAnonymous("sign_in_ip", hashKey(ip));
    await limitAnonymous("sign_in", hashKey(ip, email));
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    // One generic message for every credential failure (no account enumeration).
    if (error || !data.user) throw new AppError("auth.invalid_credentials");

    const { data: profile } = await supabase
      .from("profiles").select("is_active, locale").eq("id", data.user.id).maybeSingle();
    if (!profile?.is_active) {
      await supabase.auth.signOut();
      throw new AppError("auth.account_inactive");
    }
    // The sign-in itself is recorded by the database (trigger on auth.sessions),
    // so users can't inflate their own login counts through the API.
    if (isLocale(profile.locale)) {
      (await cookies()).set(LOCALE_COOKIE, profile.locale, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
    }
    return null;
  });
  if (result.ok) redirect(safeNext(input.next));
  return result;
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) {
    await supabase.from("auth_events").insert({ user_id: data.user.id, event: "sign_out" });
  }
  await supabase.auth.signOut();
  redirect("/login");
}

export async function requestPasswordReset(input: z.input<typeof emailSchema>): Promise<ActionResult<null>> {
  return runAction(emailSchema, input, async ({ email }) => {
    const ip = await clientIp();
    await limitAnonymous("password_reset_ip", hashKey(ip));
    await limitAnonymous("password_reset", hashKey(ip, email));
    const supabase = await createClient();
    const { APP_URL } = serverEnv("core");
    // The e-mail template links to /auth/confirm with a token hash (see
    // supabase/templates/recovery.html). The response is identical whether or
    // not the address exists.
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${APP_URL}/auth/reset-password` });
    return null;
  });
}

/** Set a new password for the signed-in user (reset link, profile page). */
export async function updatePassword(input: z.input<typeof newPasswordSchema>): Promise<ActionResult<null>> {
  return runAction(newPasswordSchema, input, async ({ password }) => {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw new AppError("auth.session_expired");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new AppError(error.code === "same_password" ? "auth.same_password" : "auth.weak_password");
    // password_changed is recorded by the database (trigger on auth.users).
    return null;
  });
}

/** Invited user completes their account: name + password. */
export async function acceptInvite(input: z.input<typeof acceptInviteSchema>): Promise<ActionResult<null>> {
  const result = await runAction(acceptInviteSchema, input, async ({ fullName, password }) => {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw new AppError("auth.session_expired");
    const { error } = await supabase.auth.updateUser({ password, data: { full_name: fullName } });
    if (error) throw new AppError(error.code === "same_password" ? "auth.same_password" : "auth.weak_password");
    check(await supabase.from("profiles").update({ full_name: fullName }).eq("id", data.user.id));
    return null;
  });
  if (result.ok) redirect("/");
  return result;
}

/** Own profile: name, phone, interface language. */
export async function updateProfile(input: z.input<typeof profileSchema>): Promise<ActionResult<null>> {
  return runAction(profileSchema, input, async ({ fullName, phone, locale }) => {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw new AppError("auth.session_expired");
    check(await supabase.from("profiles").update({ full_name: fullName, phone: phone || null, locale })
      .eq("id", data.user.id).select("id").single());
    (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
    revalidatePath("/", "layout");
    return null;
  });
}

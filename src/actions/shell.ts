"use server";
import { z } from "zod";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check } from "@/server/action";
import { getViewer, ALL_COMPANIES, COMPANY_COOKIE } from "@/server/auth/viewer";
import { LOCALE_COOKIE } from "@/i18n";
import type { ActionResult } from "@/types/action";

const ONE_YEAR = 60 * 60 * 24 * 365;

const companySchema = z.object({ companyId: z.union([z.uuid(), z.literal(ALL_COMPANIES)]) });

/** Remember the selected company. Only a UI preference: RLS decides access. */
export async function setActiveCompany(input: z.input<typeof companySchema>): Promise<ActionResult<null>> {
  return runAction(companySchema, input, async ({ companyId }) => {
    const viewer = await getViewer();
    const allowed = companyId === ALL_COMPANIES ? viewer.isSuperAdmin : viewer.companies.some((c) => c.id === companyId);
    if (!allowed) return null;
    (await cookies()).set(COMPANY_COOKIE, companyId, { path: "/", maxAge: ONE_YEAR, sameSite: "lax", httpOnly: true });
    revalidatePath("/", "layout");
    return null;
  });
}

const markReadSchema = z.object({ ids: z.array(z.uuid()).max(200).nullable() });

export async function markNotificationsRead(input: z.input<typeof markReadSchema>): Promise<ActionResult<number>> {
  return runAction(markReadSchema, input, async ({ ids }) => {
    const supabase = await createClient();
    const count = check(await supabase.rpc("mark_notifications_read", ids ? { p_ids: ids } : {}));
    revalidatePath("/", "layout");
    return count ?? 0;
  });
}

const localeSchema = z.object({ locale: z.enum(["ar", "en"]) });

/** Language choice for signed-out pages (login, password reset): only the browser cookie, no account involved. */
export async function setGuestLocale(input: z.input<typeof localeSchema>): Promise<ActionResult<null>> {
  return runAction(localeSchema, input, async ({ locale }) => {
    (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
    revalidatePath("/", "layout");
    return null;
  });
}

export async function setLocale(input: z.input<typeof localeSchema>): Promise<ActionResult<null>> {
  return runAction(localeSchema, input, async ({ locale }) => {
    const viewer = await getViewer();
    const supabase = await createClient();
    check(await supabase.from("profiles").update({ locale }).eq("id", viewer.id));
    (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
    revalidatePath("/", "layout");
    return null;
  });
}

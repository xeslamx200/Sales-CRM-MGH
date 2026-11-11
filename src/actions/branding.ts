"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { AppError, check, runAction, type ActionResult } from "@/server/action";
import { brandIssues, normalizeHex } from "@/lib/brand";

// Company admins only; the database enforces it, validates every value and audits each change. Here: the shape of the input and the readability rule.

const hex = z.string().transform((v, ctx) => { const h = normalizeHex(v); if (!h) ctx.addIssue({ code: "custom", message: "branding.invalid_color" }); return h ?? "#000000"; });
const brandingSchema = z.object({ companyId: z.uuid(), navy: hex, gold: hex, blue: hex, logoPlate: z.boolean() });
export type BrandingInput = z.input<typeof brandingSchema>;

const MAX_LOGO = 512 * 1024;
const logoSchema = z.object({ companyId: z.uuid(), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), base64: z.string().min(8).max(Math.ceil(MAX_LOGO * 1.4)) });
export type LogoInput = z.input<typeof logoSchema>;
const companySchema = z.object({ companyId: z.uuid() });

function refresh() {
  revalidatePath("/admin/settings");
  revalidatePath("/", "layout");
}

export async function saveBranding(input: BrandingInput): Promise<ActionResult<null>> {
  return runAction(brandingSchema, input, async (d) => {
    if (brandIssues({ navy: d.navy, gold: d.gold, blue: d.blue }).length > 0) throw new AppError("branding.low_contrast");
    const supabase = await createClient();
    check(await supabase.rpc("set_company_branding", { p_company_id: d.companyId, p_navy: d.navy, p_gold: d.gold, p_blue: d.blue, p_logo_plate: d.logoPlate }));
    refresh();
    return null;
  });
}

export async function saveLogo(input: LogoInput): Promise<ActionResult<null>> {
  return runAction(logoSchema, input, async (d) => {
    const bytes = Buffer.from(d.base64, "base64");
    if (bytes.length > MAX_LOGO) throw new AppError("branding.logo_too_large");
    const supabase = await createClient();
    // bytea is sent as "\x<hex>"; the database re-checks the size, the type and the file's first bytes
    check(await supabase.rpc("set_company_logo", { p_company_id: d.companyId, p_logo: `\\x${bytes.toString("hex")}`, p_type: d.mimeType }));
    refresh();
    return null;
  });
}

export async function removeLogo(input: z.input<typeof companySchema>): Promise<ActionResult<null>> {
  return runAction(companySchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_company_logo", { p_company_id: d.companyId, p_logo: null as unknown as string, p_type: null as unknown as string }));
    refresh();
    return null;
  });
}

export async function resetBranding(input: z.input<typeof companySchema>): Promise<ActionResult<null>> {
  return runAction(companySchema, input, async (d) => {
    const supabase = await createClient();
    check(await supabase.rpc("reset_company_branding", { p_company_id: d.companyId }));
    refresh();
    return null;
  });
}

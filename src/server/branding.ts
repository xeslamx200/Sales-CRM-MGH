import "server-only";
import type { ServerClient } from "@/server/supabase/server";
import { DEFAULT_BRAND, HEX, type BrandColors } from "@/lib/brand";

export type Branding = {
  colors: BrandColors;
  /** an admin has saved colours or a logo for this company */
  custom: boolean;
  hasLogo: boolean;
  logoPlate: boolean;
  /** changes whenever the branding changes: part of the logo URL so the browser never shows a stale logo */
  version: string;
};

/** The company's colours and logo flags (never the logo bytes). A company without a row has the built-in MGH look. */
export async function getBranding(supabase: ServerClient, companyId: string | null | undefined): Promise<Branding> {
  const none: Branding = { colors: DEFAULT_BRAND, custom: false, hasLogo: false, logoPlate: false, version: "0" };
  if (!companyId) return none;
  const { data, error } = await supabase.from("company_branding")
    .select("brand_navy, brand_gold, brand_blue, logo_type, logo_plate, updated_at").eq("company_id", companyId).maybeSingle();
  if (error || !data) return none;
  const ok = HEX.test(data.brand_navy) && HEX.test(data.brand_gold) && HEX.test(data.brand_blue);
  return {
    colors: ok ? { navy: data.brand_navy, gold: data.brand_gold, blue: data.brand_blue } : DEFAULT_BRAND,
    custom: true, hasLogo: Boolean(data.logo_type), logoPlate: data.logo_plate, version: String(new Date(data.updated_at).getTime()),
  };
}

export const logoUrl = (companyId: string, version: string) => `/api/brand/logo?c=${companyId}&v=${version}`;

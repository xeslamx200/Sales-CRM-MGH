"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { check, runAction, type ActionResult } from "@/server/action";
import { HIDEABLE_PAGES, PERMISSION_KEYS } from "@/lib/permissions";
import { Constants } from "@/types/database";

// Company admins only: the database functions save_company_role / delete_company_role check it (and audit it); these actions only validate the shape.

const roleSchema = z.object({
  id: z.uuid().nullable(),
  companyId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  base: z.enum(Constants.public.Enums.app_role).refine((r) => r !== "company_admin"),
  hiddenNav: z.array(z.enum(HIDEABLE_PAGES)).max(20),
  /** the switches turned OFF */
  denied: z.array(z.enum(PERMISSION_KEYS)).max(20),
});

function refresh() {
  revalidatePath("/admin/settings");
  revalidatePath("/", "layout");
}

export async function saveRole(input: z.input<typeof roleSchema>): Promise<ActionResult<{ id: string }>> {
  return runAction(roleSchema, input, async (d) => {
    const supabase = await createClient();
    const permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, !d.denied.includes(k)]));
    const id = check(await supabase.rpc("save_company_role", {
      p_id: d.id as string, p_company_id: d.companyId, p_name: d.name, p_base_role: d.base, p_hidden_nav: d.hiddenNav, p_permissions: permissions,
    }));
    refresh();
    return { id: id as string };
  });
}

export async function deleteRole(input: { id: string }): Promise<ActionResult<null>> {
  return runAction(z.object({ id: z.uuid() }), input, async ({ id }) => {
    const supabase = await createClient();
    check(await supabase.rpc("delete_company_role", { p_id: id }));
    refresh();
    return null;
  });
}

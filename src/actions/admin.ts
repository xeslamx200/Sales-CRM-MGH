"use server";
import { updateWhatsappAccount } from "@/lib/whatsapp/account-update.ts";
import type { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, AppError, type ActionResult } from "@/server/action";
import { inviteToCompany } from "@/server/auth/invite";
import { normalizePhone } from "@/lib/phone.ts";
import type { TablesUpdate } from "@/types/database";
import {
  companySchema, inviteSchema, membershipUpdateSchema, profileActiveSchema, teamMemberSchema, teamSchema,
  waAccountSchema, waGrantSchema, waRevokeSchema, waSendingSchema,
} from "@/schemas/admin";

// Every action runs with the user's session: RLS policies and database
// guards decide what is allowed. Failures come back as localized messages.

export async function saveCompany(input: z.input<typeof companySchema>): Promise<ActionResult<null>> {
  return runAction(companySchema, input, async ({ id, name, slug, timezone, currency, isActive, isSandbox }) => {
    const supabase = await createClient();
    if (id) {
      // Slug and active flag are super-admin-only fields (company guard).
      const { data: current } = await supabase.from("companies").select("slug, is_active").eq("id", id).maybeSingle();
      if (!current) throw new AppError("auth.forbidden");
      const patch: TablesUpdate<"companies"> = { name, timezone, currency };
      if (current.slug !== slug) patch.slug = slug;
      if (current.is_active !== isActive) patch.is_active = isActive;
      check(await supabase.from("companies").update(patch).eq("id", id));
    } else {
      check(await supabase.from("companies").insert({ name, slug, timezone, currency, is_active: isActive, is_sandbox: isSandbox }));
    }
    revalidatePath("/", "layout");
    return null;
  });
}

export async function inviteUser(input: z.input<typeof inviteSchema>): Promise<ActionResult<{ invited: boolean }>> {
  return runAction(inviteSchema, input, async (data) => {
    const res = await inviteToCompany(data);
    revalidatePath("/admin/users");
    return res;
  });
}

export async function updateMembership(input: z.input<typeof membershipUpdateSchema>): Promise<ActionResult<null>> {
  return runAction(membershipUpdateSchema, input, async ({ id, role, isActive }) => {
    const supabase = await createClient();
    check(await supabase.from("company_memberships").update({ role, is_active: isActive }).eq("id", id).select("id").single());
    revalidatePath("/admin/users");
    return null;
  });
}

export async function setProfileActive(input: z.input<typeof profileActiveSchema>): Promise<ActionResult<null>> {
  return runAction(profileActiveSchema, input, async ({ userId, isActive }) => {
    const supabase = await createClient();
    check(await supabase.from("profiles").update({ is_active: isActive }).eq("id", userId).select("id").single());
    revalidatePath("/admin/users");
    return null;
  });
}

export async function saveTeam(input: z.input<typeof teamSchema>): Promise<ActionResult<null>> {
  return runAction(teamSchema, input, async ({ id, companyId, name, managerId, isActive }) => {
    const supabase = await createClient();
    if (id) {
      check(await supabase.from("teams").update({ name, manager_id: managerId, is_active: isActive })
        .eq("id", id).select("id").single());
    } else {
      check(await supabase.from("teams").insert({ company_id: companyId, name, manager_id: managerId, is_active: isActive }));
    }
    revalidatePath("/admin/teams");
    return null;
  });
}

export async function addTeamMember(input: z.input<typeof teamMemberSchema>): Promise<ActionResult<null>> {
  return runAction(teamMemberSchema, input, async ({ teamId, companyId, userId }) => {
    const supabase = await createClient();
    check(await supabase.from("team_memberships").insert({ team_id: teamId, company_id: companyId, user_id: userId }));
    revalidatePath("/admin/teams");
    return null;
  });
}

export async function removeTeamMember(input: z.input<typeof teamMemberSchema>): Promise<ActionResult<null>> {
  return runAction(teamMemberSchema, input, async ({ teamId, userId }) => {
    const supabase = await createClient();
    check(await supabase.from("team_memberships").delete().eq("team_id", teamId).eq("user_id", userId).select("user_id").single());
    revalidatePath("/admin/teams");
    return null;
  });
}

export async function saveWhatsappAccount(input: z.input<typeof waAccountSchema>): Promise<ActionResult<null>> {
  return runAction(waAccountSchema, input, async ({ id, defaultCompanyId, displayName, phone, phoneNumberId, wabaId, status, provider, environment, connectionMode, outboundEnabled }) => {
    const normalized = normalizePhone(phone);
    if (!normalized.ok) throw new AppError("phone.invalid");
    const supabase = await createClient();
    const row = {
      default_company_id: defaultCompanyId, display_name: displayName, phone_e164: normalized.e164,
      phone_number_id: phoneNumberId, waba_id: wabaId, status,
    };
    if (id) {
      // Bounded wait (5 s, function-local) with a retryable "busy" answer; see src/lib/whatsapp/account-update.ts.
      const rpc = supabase as unknown as { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
      check(await updateWhatsappAccount({
        rpc: (name, args) => rpc.rpc(name, args),
        legacyUpdate: (accountId, r) => supabase.from("whatsapp_accounts").update(r as TablesUpdate<"whatsapp_accounts">).eq("id", accountId).select("id").single(),
      }, id, row));
    }
    // The provider is chosen at creation only; the database also refuses a change once there are conversations.
    else if (provider === "kapso" && environment === "production") {
      // A real Kapso number of a real company: the database derives and checks everything else (company must be real, ids, sending needs an active number).
      check(await supabase.from("whatsapp_accounts").insert({ ...row, provider, environment, connection_mode: connectionMode, outbound_enabled: outboundEnabled, is_sandbox: false }));
    } else check(await supabase.from("whatsapp_accounts").insert({ ...row, provider, is_sandbox: provider === "kapso" }));
    revalidatePath("/admin/whatsapp");
    return null;
  });
}

/** Switch sending from the CRM on or off for a real Kapso number (super admin; the database requires an active number to switch it on). */
export async function setWhatsappSending(input: z.input<typeof waSendingSchema>): Promise<ActionResult<null>> {
  return runAction(waSendingSchema, input, async ({ accountId, enabled }) => {
    const supabase = await createClient();
    check(await supabase.from("whatsapp_accounts").update({ outbound_enabled: enabled }).eq("id", accountId).eq("provider", "kapso").eq("environment", "production").select("id").single());
    revalidatePath("/admin/whatsapp");
    return null;
  });
}

export async function grantWhatsappAccess(input: z.input<typeof waGrantSchema>): Promise<ActionResult<null>> {
  return runAction(waGrantSchema, input, async ({ accountId, userId, canReply }) => {
    const supabase = await createClient();
    check(await supabase.from("whatsapp_account_access").upsert(
      { whatsapp_account_id: accountId, user_id: userId, can_reply: canReply },
      { onConflict: "whatsapp_account_id,user_id" },
    ));
    revalidatePath("/admin/whatsapp");
    return null;
  });
}

export async function revokeWhatsappAccess(input: z.input<typeof waRevokeSchema>): Promise<ActionResult<null>> {
  return runAction(waRevokeSchema, input, async ({ accountId, userId }) => {
    const supabase = await createClient();
    check(await supabase.from("whatsapp_account_access").delete()
      .eq("whatsapp_account_id", accountId).eq("user_id", userId).select("user_id").single());
    revalidatePath("/admin/whatsapp");
    return null;
  });
}

import "server-only";
import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { serverEnv } from "@/server/env";
import { AppError } from "@/server/action";
import { getViewer, isAdminOf } from "@/server/auth/viewer";
import { checkPhoneNumber, fetchTemplates, type TemplateInfo } from "@/lib/whatsapp/graph.ts";
import { recordCredentialResult } from "@/server/whatsapp/health";
import type { Json } from "@/types/database";

/** Development-only templates for simulated numbers (never sent to Meta). */
const SIMULATED_TEMPLATES: TemplateInfo[] = [
  { name: "follow_up_demo", language: "ar", status: "APPROVED", category: "UTILITY", components: [],
    body_text: "مرحباً {{1}}، نتابع معك بخصوص {{2}}. هل ما زلت مهتماً؟", param_count: 2 },
  { name: "hello_world", language: "en_US", status: "APPROVED", category: "UTILITY", components: [],
    body_text: "Hello World", param_count: 0 },
];

/**
 * Only the super admin or a company admin of the number's default company
 * manages it. Checked with the caller's own session before any service-role
 * call.
 */
async function adminAccount(accountId: string) {
  const viewer = await getViewer();
  const supabase = await createClient();
  const { data: acc } = await supabase.from("whatsapp_accounts")
    .select("id, default_company_id, phone_number_id, waba_id, is_simulated").eq("id", accountId).maybeSingle();
  if (!acc || !(viewer.isSuperAdmin || isAdminOf(viewer, acc.default_company_id))) throw new AppError("auth.forbidden");
  return acc;
}

export async function syncTemplates(accountId: string): Promise<{ count: number; approved: number }> {
  const acc = await adminAccount(accountId);
  let templates: TemplateInfo[];
  if (acc.is_simulated) {
    templates = SIMULATED_TEMPLATES;
  } else {
    if (!acc.waba_id) throw new AppError("whatsapp.waba_required");
    const env = serverEnv("whatsapp");
    const r = await fetchTemplates({ wabaId: acc.waba_id, accessToken: env.WHATSAPP_ACCESS_TOKEN, apiVersion: env.WHATSAPP_GRAPH_API_VERSION });
    await recordCredentialResult(acc.id, r.ok ? { ok: true } : r);
    if (!r.ok) throw new AppError(r.httpStatus === 401 || r.code === "190" ? "whatsapp.credentials_invalid" : "whatsapp.meta_unreachable");
    templates = r.templates;
  }
  const { error } = await createAdminClient().rpc("sync_whatsapp_templates", {
    p_account_id: acc.id, p_templates: templates as unknown as Json,
  });
  if (error) throw error;
  return { count: templates.length, approved: templates.filter((t) => t.status === "APPROVED").length };
}

export async function testConnection(accountId: string): Promise<{ ok: boolean; code?: string }> {
  const acc = await adminAccount(accountId);
  if (acc.is_simulated) return { ok: true };
  if (!acc.phone_number_id) throw new AppError("whatsapp.phone_number_id_required");
  const env = serverEnv("whatsapp");
  const r = await checkPhoneNumber({ phoneNumberId: acc.phone_number_id, accessToken: env.WHATSAPP_ACCESS_TOKEN, apiVersion: env.WHATSAPP_GRAPH_API_VERSION });
  await recordCredentialResult(acc.id, r.ok ? { ok: true } : r);
  return r.ok ? { ok: true } : { ok: false, code: r.code };
}

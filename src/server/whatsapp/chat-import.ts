import "server-only";
import { createHash } from "node:crypto";
import { AppError } from "@/server/action";
import { createAdminClient } from "@/server/supabase/admin";
import { zonedLocalToUtc } from "@/lib/dates/zoned.ts";

export type ChatImportInput = {
  accountId: string; digits: string; customerName: string | null; businessSender: string; timeZone: string; offset: number;
  messages: { sender: string; local: string; text: string; media: boolean }[];
};

/** Service-role part of the chat import (the caller has already checked that the viewer is a super admin). */
export async function storeChatExport(d: ChatImportInput) {
  const digits = d.digits;
    const admin = createAdminClient();
    const { data: acc } = await admin.from("whatsapp_accounts").select("id, phone_number_id, provider, environment").eq("id", d.accountId).maybeSingle();
    if (!acc || acc.provider !== "kapso" || acc.environment !== "production" || !acc.phone_number_id) throw new AppError("auth.forbidden");

    const rows = d.messages.map((m, i) => {
      const iso = zonedLocalToUtc(m.local, d.timeZone);
      if (!iso) throw new AppError("validation");
      const ts = Math.floor(Date.parse(iso) / 1000);
      const out = m.sender === d.businessSender;
      const id = "export." + createHash("sha1").update(`${acc.phone_number_id}|${digits}|${d.offset + i}|${ts}|${out ? "o" : "i"}|${m.text}`).digest("hex").slice(0, 28);
      return { id, d: out ? "o" : "i", ts, ph: digits, nm: d.customerName ?? undefined, ty: m.media ? "media_placeholder" : "text", b: m.media ? "" : m.text, st: out ? "read" : "received" };
    });
    const { data, error } = await admin.rpc("kapso_import_history", { p_phone_number_id: acc.phone_number_id, p_rows: rows });
    if (error) throw error;
    const r = data as { inserted: number; duplicate: number; failed: number };
    const { data: conv } = await admin.from("conversations").select("id").eq("whatsapp_account_id", acc.id).eq("customer_wa_id", digits).maybeSingle();
  return { inserted: r.inserted, duplicate: r.duplicate, failed: r.failed, conversationId: conv?.id ?? null };
}

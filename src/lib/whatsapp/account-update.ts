/**
 * Admin edit of a WhatsApp account with a BOUNDED wait.
 *
 * Under the Rev6 lock protocol every Kapso webhook transaction holds FOR SHARE on its account row, and overlapping webhooks can keep a plain
 * UPDATE of that row waiting for as long as the load lasts (measured: 10 s). The edit therefore goes through ONE database function,
 * public.update_whatsapp_account (supabase/migrations/20261104000976_update_whatsapp_account.sql), which runs the same UPDATE with a
 * function-local `lock_timeout` of 5 s and answers with the stable key `whatsapp.account_busy` (SQLSTATE 55P03) when it gives up.
 *
 * Rules implemented here: the RPC is called exactly ONCE and a busy answer is returned to the caller (the admin screen shows a retryable
 * message) - there is no automatic retry, here or in the database. Only when the function does not exist yet (the proposed migration is not
 * applied; PostgREST PGRST202 / Postgres 42883) the previous plain table update is used, unchanged, so nothing breaks before the migration.
 * No session or global lock_timeout is ever set by the application.
 */
export const UPDATE_ACCOUNT_RPC = "update_whatsapp_account";

export type AccountUpdateRow = {
  default_company_id: string;
  display_name: string;
  phone_e164: string;
  phone_number_id: string | null;
  waba_id: string | null;
  status: string;
};
export type DbResponse = { data: unknown; error: unknown };
export type AccountDb = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<DbResponse>;
  /** The pre-existing `.from("whatsapp_accounts").update(row).eq("id", id).select("id").single()`. */
  legacyUpdate(id: string, row: AccountUpdateRow): PromiseLike<DbResponse>;
};

export function isMissingRpc(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  return e.code === "PGRST202" || e.code === "42883" || (typeof e.message === "string" && /could not find the function/i.test(e.message));
}

export async function updateWhatsappAccount(db: AccountDb, id: string, row: AccountUpdateRow): Promise<DbResponse> {
  const res = await db.rpc(UPDATE_ACCOUNT_RPC, {
    p_id: id,
    p_default_company_id: row.default_company_id,
    p_display_name: row.display_name,
    p_phone_e164: row.phone_e164,
    p_phone_number_id: row.phone_number_id,
    p_waba_id: row.waba_id,
    p_status: row.status,
  });
  if (res.error && isMissingRpc(res.error)) return db.legacyUpdate(id, row);
  return res;
}

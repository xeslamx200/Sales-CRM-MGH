import { test } from "node:test";
import assert from "node:assert/strict";
import { isMissingRpc, updateWhatsappAccount, UPDATE_ACCOUNT_RPC, type AccountDb, type AccountUpdateRow } from "../../src/lib/whatsapp/account-update.ts";
import { errorKey, userMessage } from "../../src/lib/errors.ts";
import { cronRetryBody, formatJobDetails } from "../../src/lib/job-status.ts";

const ROW: AccountUpdateRow = { default_company_id: "c1", display_name: "N", phone_e164: "+15550000001", phone_number_id: "P1", waba_id: null, status: "test" };
function fakeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = { rpc: [] as Array<{ name: string; args: Record<string, unknown> }>, legacy: 0 };
  const db: AccountDb = {
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return rpcResult; },
    legacyUpdate: async () => { calls.legacy++; return { data: { id: "x" }, error: null }; },
  };
  return { db, calls };
}

test("admin account update: one RPC call with every column; success is returned as is", async () => {
  const { db, calls } = fakeDb({ data: null, error: null });
  const r = await updateWhatsappAccount(db, "acc-1", ROW);
  assert.equal(r.error, null);
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.rpc[0].name, UPDATE_ACCOUNT_RPC);
  assert.deepEqual(Object.keys(calls.rpc[0].args).sort(), ["p_default_company_id", "p_display_name", "p_id", "p_phone_e164", "p_phone_number_id", "p_status", "p_waba_id"]);
  assert.equal(calls.legacy, 0);
});

test("admin account update: a busy account is reported ONCE as a retryable key - no automatic retry, no fallback to the unbounded update", async () => {
  const busy = { code: "55P03", message: "whatsapp.account_busy" };
  const { db, calls } = fakeDb({ data: null, error: busy });
  const r = await updateWhatsappAccount(db, "acc-1", ROW);
  assert.deepEqual(r.error, busy);
  assert.equal(calls.rpc.length, 1, "exactly one attempt");
  assert.equal(calls.legacy, 0, "the unbounded legacy update must not be used to get around the timeout");
  assert.equal(errorKey(r.error), "whatsapp.account_busy");
  assert.match(userMessage(r.error, "en"), /try again in a moment/i);
  assert.match(userMessage(r.error, "ar"), /حاول مرة أخرى/);
});

test("admin account update: other database errors (forbidden, guard rules) pass through untouched", async () => {
  for (const key of ["auth.forbidden", "whatsapp.default_company_immutable", "whatsapp.provider_immutable"]) {
    const { db, calls } = fakeDb({ data: null, error: { message: key } });
    const r = await updateWhatsappAccount(db, "a", ROW);
    assert.equal((r.error as { message: string }).message, key);
    assert.equal(calls.legacy, 0);
  }
});

test("admin account update: before the proposed migration is applied (function missing) the previous plain update is used, once", async () => {
  for (const err of [{ code: "PGRST202", message: "Could not find the function public.update_whatsapp_account" }, { code: "42883", message: "function does not exist" }]) {
    assert.equal(isMissingRpc(err), true);
    const { db, calls } = fakeDb({ data: null, error: err });
    const r = await updateWhatsappAccount(db, "a", ROW);
    assert.equal(r.error, null);
    assert.deepEqual([calls.rpc.length, calls.legacy], [1, 1]);
  }
  assert.equal(isMissingRpc({ code: "55P03", message: "whatsapp.account_busy" }), false);
  assert.equal(isMissingRpc(null), false);
});

test("the busy key is a real, localized message", () => {
  assert.notEqual(userMessage({ message: "whatsapp.account_busy" }, "en"), userMessage({ message: "nonsense" }, "en"));
});

test("cron retry route body: ok plus every counter the SQL job returns, including the new unconfirmed_expired key", () => {
  assert.deepEqual(cronRetryBody({ processed: 2, failed: 1, ignored: 0, unconfirmed_expired: 3 }), { ok: true, processed: 2, failed: 1, ignored: 0, unconfirmed_expired: 3 });
  assert.deepEqual(cronRetryBody({ processed: 0, failed: 0, ignored: 0, unconfirmed_expired: -1 }).ok, true, "a swallowed expiry error (-1) does not fail the job");
  assert.equal(cronRetryBody({ error: "processing_error" }).ok, false);
  assert.deepEqual(cronRetryBody(null), { ok: true });
  assert.deepEqual(cronRetryBody([1, 2]), { ok: true });
});

test("admin system page cell: error code first, else the stored details as JSON (new keys simply appear)", () => {
  assert.equal(formatJobDetails({ last_error: "processing_error", last_details: { processed: 1 } }), "processing_error");
  assert.equal(formatJobDetails({ last_error: null, last_details: { processed: 1, failed: 0, ignored: 0, unconfirmed_expired: 0 } }), '{"processed":1,"failed":0,"ignored":0,"unconfirmed_expired":0}');
  assert.equal(formatJobDetails({ last_error: null, last_details: null }), "{}");
});

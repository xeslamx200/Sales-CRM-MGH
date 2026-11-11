/**
 * END-TO-END against a DISPOSABLE PostgreSQL database that has the Rev6 schema: the real protocol-v2 handler and the real store mapping
 * (src/lib/kapso/v2.ts + store-v2.ts) call the real database functions. Nothing is mocked except the transport: RPC calls are executed
 * through psql inside a client container instead of PostgREST.
 *
 *   KAPSO_SCRATCH_DB=<client-container>:<server-host>:<database>   e.g.  kapso-rev6-scratch-client:172.17.0.2:kapso_p6_c_scratch
 *   (the database name must contain "scratch"; it needs supabase/migrations 970, 972, 975, 976, 977, 978, 979 and the test fixtures)
 *   npm run test:scratch
 *
 * SKIPPED (not passed) when KAPSO_SCRATCH_DB is not set. Never point this at a real database: it inserts accounts, contacts and messages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { handleKapsoPostV2, reprocessQuarantinedV2, type KapsoRequestV2 } from "../../src/lib/kapso/v2.ts";
import { createKapsoStoreV2, type RpcClient } from "../../src/lib/kapso/store-v2.ts";
import { handleKapsoPost, kapsoDbEventKind, type KapsoStore } from "../../src/lib/kapso/processor.ts";
import type { ClaimResult } from "../../src/lib/whatsapp/processor.ts";

const CFG = process.env.KAPSO_SCRATCH_DB ?? "";
const [CONTAINER, HOST, DB] = CFG.split(":");
const ENABLED = Boolean(CONTAINER && HOST && DB && /scratch/.test(DB));
const SECRET = "scratch-db-test-secret-0123456789"; // throwaway
const sign = (b: Uint8Array) => createHmac("sha256", SECRET).update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

function psql(sql: string): { out: string; err: string; ok: boolean } {
  const r = spawnSync("docker", ["exec", "-i", "-e", `PGHOST=${HOST}`, "-e", "PGUSER=postgres", CONTAINER, "psql", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-d", DB, "-f", "-"], { input: sql, encoding: "utf8" });
  return { out: (r.stdout ?? "").trim(), err: r.stderr ?? "", ok: r.status === 0 };
}
const q = (sql: string) => { const r = psql(sql); assert.ok(r.ok, r.err); return r.out; };
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const tag = `$q${randomBytes(4).toString("hex")}$`;
  return `${tag}${typeof v === "string" ? v : JSON.stringify(v)}${tag}` + (typeof v === "string" ? "" : "::jsonb");
};
const TABLE_FNS = new Set(["ingest_kapso_inbound", "list_kapso_quarantined", "ingest_kapso_message"]);
const VOID_FNS = new Set(["finish_webhook_event", "touch_kapso_account"]);
const rpcClient: RpcClient = {
  async rpc(name, args) {
    const argList = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(", ");
    const call = `public.${name}(${argList})`;
    const sql = TABLE_FNS.has(name) ? `select coalesce(jsonb_agg(to_jsonb(r)), 'null'::jsonb)::text from ${call} r;`
      : VOID_FNS.has(name) ? `select ${call};` : `select to_jsonb(${call})::text;`;
    const r = psql(sql);
    if (!r.ok) {
      const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(r.err);
      return { data: null, error: { code: m?.[1] ?? "XX000", message: m?.[2]?.trim() ?? r.err.slice(0, 200) } };
    }
    return { data: VOID_FNS.has(name) ? null : JSON.parse(r.out || "null"), error: null };   // SQL NULL prints nothing (PostgREST: null)
  },
};
const store = () => createKapsoStoreV2(rpcClient);

let n = Date.now() % 9_000_000;   // milliseconds: a re-run on the same scratch database never reuses phones/wamids of an earlier run
const uniq = () => ++n;
function account(company: "alpha" | "beta", status = "test") {
  const k = uniq();
  const pnid = `TSDB_${k}`;
  const id = q(`insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status)
    select id, 'ts ${k}', '+1555${String(7000000 + k).slice(-7)}', '${pnid}', 'kapso', 'production', 'coexistence', '${status}' from public.companies where slug = '${company}' returning id;`).split("\n")[0];
  return { id, pnid, company };
}
const phone = () => `20100${String(8000000 + uniq()).slice(-7)}`;
/** `user`: the customer's BSUID in the DOCUMENTED fields (inbound: message.from_user_id + conversation.business_scoped_user_id;
 *  outbound: conversation.business_scoped_user_id). `bsuid`: the test-only override location. ph null = BSUID-only shape (no from/to,
 *  conversation.phone_number null). */
function item(direction: "inbound" | "outbound", wamid: string, pnid: string, o: { origin?: string; ph?: string | null; bsuid?: string; user?: string; text?: string; extra?: Record<string, unknown> } = {}) {
  const ph = o.ph === undefined ? phone() : o.ph;
  return {
    message: {
      id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: o.text ?? "hello" },
      ...(ph ? (direction === "inbound" ? { from: ph } : { to: ph }) : {}),
      ...(o.user && direction === "inbound" ? { from_user_id: o.user } : {}),
      kapso: { direction, content: o.text ?? "hello", ...(o.origin ? { origin: o.origin } : {}) }, ...o.extra,
    },
    conversation: { id: "c", contact_name: "Scratch", phone_number_id: pnid, phone_number: ph ?? null,
      ...(o.bsuid ? { test_only_user_id: o.bsuid } : {}), ...(o.user ? { business_scoped_user_id: o.user } : {}) },
    phone_number_id: pnid,
  };
}
const bsuid = () => `US.${String(uniq()).padStart(20, "0")}`;
const snapshot = () => q(`select (select count(*) from public.contacts)||'/'||(select count(*) from public.conversations)||'/'||(select count(*) from public.contact_identities)||'/'||(select count(*) from public.contact_companies)||'/'||(select count(*) from public.leads)||'/'||(select count(*) from public.messages)`);
const post = (payload: unknown, event: string, opts: { sig?: string; bsuid?: boolean } = {}) => {
  const raw = enc(JSON.stringify(payload));
  const req: KapsoRequestV2 = { rawBody: raw, signature: opts.sig ?? sign(raw), eventName: event, payloadVersion: "v2" };
  return handleKapsoPostV2(req, SECRET, store(), opts.bsuid ? { bsuidPaths: [["conversation", "test_only_user_id"]] } : {});
};
const RECEIVED = "whatsapp.message.received", SENT = "whatsapp.message.sent", DELIVERED = "whatsapp.message.delivered";
const skip = ENABLED ? false : "KAPSO_SCRATCH_DB not set: SKIPPED (needs a disposable database with the Rev6 schema)";

test("db e2e: signed inbound message creates contact, conversation (account's company), message and automatic lead; telemetry is written", { skip }, async () => {
  const a = account("alpha"), ph = phone();
  const r = await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph }), RECEIVED);
  assert.deepEqual([r.httpStatus, r.processed, r.failed, r.quarantined], [200, 1, 0, 0]);
  assert.equal(q(`select count(*) from public.conversations c join public.companies k on k.id=c.company_id where c.whatsapp_account_id='${a.id}' and k.slug='alpha' and c.customer_wa_id='${ph}'`), "1");
  assert.equal(q(`select count(*) from public.leads l join public.conversations c on c.id=l.conversation_id where c.whatsapp_account_id='${a.id}'`), "1");
  assert.equal(q(`select (last_inbound_event_at is not null)::text from public.whatsapp_accounts where id='${a.id}'`), "true");
});

test("db e2e: duplicate delivery of a processed event creates nothing; invalid signature creates nothing", { skip }, async () => {
  const a = account("alpha"), w = `wamid.TS.${uniq()}`, p = item("inbound", w, a.pnid);
  assert.equal((await post(p, RECEIVED)).processed, 1);
  const before = q(`select (select count(*) from public.messages)||'/'||(select count(*) from public.conversations)||'/'||(select count(*) from public.whatsapp_webhook_events)`);
  const again = await post(p, RECEIVED);
  assert.deepEqual([again.processed, again.duplicates], [0, 1]);
  const bad = await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid), RECEIVED, { sig: "0".repeat(64) });
  assert.equal(bad.httpStatus, 401);
  assert.equal(q(`select (select count(*) from public.messages)||'/'||(select count(*) from public.conversations)||'/'||(select count(*) from public.whatsapp_webhook_events)`), before);
  assert.equal(q(`select status from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`), "processed");
  assert.equal(q(`select payload::text from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`), "{}", "processed events keep no payload");
});

test("db e2e: cross-account isolation - company/account ids in the body are ignored; the same wamid for another account creates nothing there", { skip }, async () => {
  const a = account("alpha"), b = account("beta"), w = `wamid.TS.${uniq()}`;
  const p = item("inbound", w, a.pnid, { extra: { company_id: "00000000-0000-0000-0000-000000000bad", whatsapp_account_id: b.id } });
  assert.equal((await post(p, RECEIVED)).processed, 1);
  assert.equal(q(`select count(*) from public.conversations c join public.companies k on k.id=c.company_id where c.whatsapp_account_id='${a.id}' and k.slug='alpha'`), "1");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${b.id}'`), "0");
  const foreign = await post(item("inbound", w, b.pnid), RECEIVED); // same wamid, other account's phone_number_id
  assert.equal(foreign.processed, 0, "the global event key already exists: it is a duplicate, never reaches account B");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${b.id}'`), "0");
  // the database refuses it too, should it ever get that far (defence in depth)
  const direct = await rpcClient.rpc("ingest_kapso_inbound", { p_phone_number_id: b.pnid, p_wa_message_id: w, p_from_wa_id: phone(), p_from_bsuid: null, p_origin: null, p_profile_name: "x", p_message_type: "text", p_body: "x", p_media: null, p_sent_at: new Date().toISOString() });
  assert.equal((direct.error as { message: string }).message, "kapso.message_account_mismatch");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${b.id}'`), "0");
});

test("db e2e: unknown phone_number_id is recorded as failed(kapso.unknown_account) and creates no data", { skip }, async () => {
  const w = `wamid.TS.${uniq()}`;
  const before = q("select (select count(*) from public.contacts)||'/'||(select count(*) from public.conversations)");
  const r = await post(item("inbound", w, `NOPE_${uniq()}`), RECEIVED);
  assert.deepEqual([r.httpStatus, r.failed], [200, 1]);
  assert.equal(q(`select status||'|'||last_error from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`), "failed|kapso.unknown_account");
  assert.equal(q("select (select count(*) from public.contacts)||'/'||(select count(*) from public.conversations)"), before);
});

test("db e2e: status reconciliation - unknown wamid waits for the retry job, then is recorded as an unattributed external send", { skip }, async () => {
  const a = account("alpha"), ph = phone(), w = `wamid.TS.${uniq()}`;
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph }), RECEIVED)).processed, 1);
  const r = await post(item("outbound", w, a.pnid, { ph, text: "sent elsewhere" }), SENT);
  assert.deepEqual([r.processed, r.failed], [0, 1], "first delivery: the API response of a CRM send may still be in flight");
  assert.equal(q(`select last_error from public.whatsapp_webhook_events where event_key='kapso:status:${w}:sent'`), "status.message_not_found");
  assert.equal(q(`select count(*) from public.messages where wa_message_id='${w}'`), "0");
  q("select public.process_webhook_retries(100, 8)");
  assert.equal(q(`select provider_origin||'/'||coalesce(sent_by::text,'null')||'/'||status from public.messages where wa_message_id='${w}'`), "cloud_api/null/sent");
  assert.equal((await post(item("outbound", w, a.pnid, { ph }), DELIVERED)).processed, 1);
  assert.equal(q(`select status from public.messages where wa_message_id='${w}'`), "delivered");
});

test("db e2e: business_app / other_app / meta_business_agent echoes to a KNOWN customer are recorded without an employee and with their origin; no lead, contact or conversation is added", { skip }, async () => {
  const a = account("alpha"), ph = phone();
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph }), RECEIVED)).processed, 1);
  const before = snapshot();
  for (const o of ["business_app", "other_app", "meta_business_agent"]) {
    const w = `wamid.TS.${o}.${uniq()}`;
    const r = await post(item("outbound", w, a.pnid, { ph, origin: o }), SENT);
    assert.equal(r.processed, 1, o);
    assert.equal(q(`select provider_origin||'/'||direction||'/'||coalesce(sent_by::text,'null') from public.messages where wa_message_id='${w}'`), `${o}/outbound/null`);
  }
  const [k, c, i, l, ld, m] = before.split("/").map(Number);
  assert.equal(snapshot(), [k, c, i, l, ld, m + 3].join("/"));
});

test("db e2e (979): echoes to an UNKNOWN customer create nothing - each origin, by phone, by BSUID and both; the event stays failed with a stable code", { skip }, async () => {
  const a = account("alpha");
  for (const o of ["business_app", "other_app", "meta_business_agent"]) {
    for (const shape of [{ ph: phone() }, { ph: null, user: bsuid() }, { ph: phone(), user: bsuid() }]) {
      const w = `wamid.TS.u.${o}.${uniq()}`, before = snapshot();
      const r = await post(item("outbound", w, a.pnid, { ...shape, origin: o }), SENT);
      assert.deepEqual([r.httpStatus, r.processed, r.failed], [200, 0, 1], `${o} ${JSON.stringify(shape)}`);
      assert.equal(q(`select status||'|'||last_error from public.whatsapp_webhook_events where event_key='kapso:status:${w}:sent'`), "failed|kapso.echo_unattributed");
      assert.equal(snapshot(), before, `${o}: no contact, conversation, identity, link, lead or message`);
    }
  }
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${a.id}'`), "0");
});

test("db e2e (979): an echo that arrives BEFORE the customer's first message is attached by the retry job once that message exists", { skip }, async () => {
  const a = account("alpha"), ph = phone(), w = `wamid.TS.${uniq()}`;
  assert.equal((await post(item("outbound", w, a.pnid, { ph, origin: "business_app" }), SENT)).failed, 1);
  q("select public.process_webhook_retries(500, 8)");
  assert.equal(q(`select status||'|'||last_error from public.whatsapp_webhook_events where event_key='kapso:status:${w}:sent'`), "failed|kapso.echo_unattributed");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${a.id}'`), "0");
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph }), RECEIVED)).processed, 1);
  q("select public.process_webhook_retries(500, 8)");
  assert.equal(q(`select e.status||'|'||m.provider_origin||'|'||(m.conversation_id = c.id)::text from public.whatsapp_webhook_events e, public.messages m, public.conversations c
    where e.event_key='kapso:status:${w}:sent' and m.wa_message_id='${w}' and c.whatsapp_account_id='${a.id}' and c.customer_wa_id='${ph}'`), "processed|business_app|true");
});

test("db e2e BSUID (documented fields, no override): BSUID-only customer -> conversation and contact without phone, lead, account-scoped identity; repeat and duplicate are idempotent", { skip }, async () => {
  const a = account("alpha"), b = account("beta"), u = bsuid(), w = `wamid.TS.${uniq()}`;
  assert.deepEqual((({ processed, failed, quarantined }) => [processed, failed, quarantined])(await post(item("inbound", w, a.pnid, { ph: null, user: u }), RECEIVED)), [1, 0, 0]);
  assert.equal(q(`select coalesce(c.customer_wa_id,'null')||'/'||c.customer_bsuid||'/'||coalesce(k.phone_e164,'null')||'/'||(select count(*) from public.leads l where l.conversation_id=c.id)
    from public.conversations c join public.contacts k on k.id=c.contact_id where c.whatsapp_account_id='${a.id}'`), `null/${u}/null/1`);
  assert.equal((await post(item("inbound", w, a.pnid, { ph: null, user: u }), RECEIVED)).duplicates, 1, "duplicate delivery");
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph: null, user: u }), RECEIVED)).processed, 1);
  assert.equal(q(`select count(*)||'/'||sum((select count(*) from public.messages m where m.conversation_id=c.id)) from public.conversations c where c.whatsapp_account_id='${a.id}'`), "1/2", "same BSUID, same account: one conversation");
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, b.pnid, { ph: null, user: u }), RECEIVED)).processed, 1);
  assert.equal(q(`select count(distinct c.contact_id)||'/'||count(*) from public.conversations c where c.customer_bsuid='${u}'`), "2/2", "same BSUID on another account: never merged");
  // an echo to that BSUID-only customer attaches; nothing is invented
  const e = `wamid.TS.${uniq()}`;
  assert.equal((await post(item("outbound", e, a.pnid, { ph: null, user: u, origin: "business_app" }), SENT)).processed, 1);
  assert.equal(q(`select coalesce(c.customer_wa_id,'null') from public.messages m join public.conversations c on c.id=m.conversation_id where m.wa_message_id='${e}'`), "null");
});

test("db e2e BSUID: BSUID + E.164 together; conflicting identity fields are quarantined and create nothing; missing identity is quarantined (recoverable)", { skip }, async () => {
  const a = account("alpha"), u = bsuid(), ph = phone();
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph, user: u }), RECEIVED)).processed, 1);
  assert.equal(q(`select c.customer_wa_id||'/'||c.customer_bsuid||'/'||k.phone_e164 from public.conversations c join public.contacts k on k.id=c.contact_id where c.whatsapp_account_id='${a.id}'`), `${ph}/${u}/+${ph}`);
  const before = snapshot();
  const bad = item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph: null, user: bsuid() });
  (bad.message as Record<string, unknown>).from_user_id = bsuid();   // the two documented fields disagree
  const r = await post(bad, RECEIVED);
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed], [200, 1, 0]);
  const none = await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph: null }), RECEIVED);
  assert.deepEqual([none.quarantined, none.processed], [1, 0]);
  assert.equal(snapshot(), before);
  assert.notEqual(q(`select count(*) from public.whatsapp_webhook_events where last_error='invalid.conflicting_customer_identity' and jsonb_typeof(payload->'rawItem') = 'null' and event_key like 'kapso:invalid:%'`), "0",
    "conflict record: fingerprint key, no content kept");
});

test("db e2e BSUID: an employee send to a BSUID-only conversation is refused before anything is queued", { skip }, async () => {
  const a = account("alpha"), u = bsuid();
  await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph: null, user: u }), RECEIVED);
  const conv = q(`select id from public.conversations where whatsapp_account_id='${a.id}'`);
  const r = psql(`insert into public.messages (conversation_id, direction, message_type, body, status, sent_by) select '${conv}', 'outbound', 'text', 'x', 'queued', id from tests.users where key = 'super';`);
  assert.equal(r.ok, false);
  assert.match(r.err, /whatsapp\.recipient_phone_unknown/);
  assert.equal(q(`select count(*) from public.messages where conversation_id='${conv}' and direction='outbound'`), "0");
});

test("db e2e: history_sync creates NO contact, conversation, lead or message and keeps no payload", { skip }, async () => {
  const a = account("alpha"), w1 = `wamid.TS.${uniq()}`, w2 = `wamid.TS.${uniq()}`, ph = phone();
  const snap = () => q(`select (select count(*) from public.contacts)||'/'||(select count(*) from public.conversations)||'/'||(select count(*) from public.messages)||'/'||(select count(*) from public.leads)||'/'||(select count(*) from public.contact_identities)`);
  const before = snap();
  const r1 = await post(item("inbound", w1, a.pnid, { ph, origin: "history_sync" }), RECEIVED);
  const r2 = await post(item("outbound", w2, a.pnid, { ph, origin: "history_sync" }), SENT);
  assert.deepEqual([r1.historySyncIgnored, r2.historySyncIgnored], [1, 1]);
  assert.equal(snap(), before);
  assert.equal(q(`select status||'|'||payload::text from public.whatsapp_webhook_events where event_key='kapso:msg:${w1}'`), "ignored|{}");
  // the database refuses it as well if a caller ever tried
  const direct = await rpcClient.rpc("ingest_kapso_inbound", { p_phone_number_id: a.pnid, p_wa_message_id: `wamid.TS.${uniq()}`, p_from_wa_id: ph, p_from_bsuid: null, p_origin: "history_sync", p_profile_name: "x", p_message_type: "text", p_body: "x", p_media: null, p_sent_at: new Date().toISOString() });
  assert.equal((direct.error as { message: string }).message, "kapso.origin_not_ingestable");
});

test("db e2e: an unknown origin is quarantined - kept without content, untouched by repeated retry-job runs, never a customer message", { skip }, async () => {
  const a = account("alpha"), w = `wamid.TS.${uniq()}`, ph = phone();
  const r = await post(item("inbound", w, a.pnid, { ph, origin: "brand_new_origin", text: "CONFIDENTIAL WORDS" }), RECEIVED);
  assert.deepEqual([r.quarantined, r.processed], [1, 0]);
  const row = () => q(`select status||'|'||attempts||'|'||last_error||'|'||md5(payload::text) from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`);
  const first = row();
  assert.match(first, /^failed\|1\|origin\.unknown\|/);
  assert.equal(q(`select (payload::text ilike '%CONFIDENTIAL%' or payload::text like '%${ph}%')::text from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`), "false");
  for (let i = 0; i < 3; i++) q("select public.process_webhook_retries(100, 8)");
  assert.equal(row(), first, "attempts, status and payload unchanged after 3 retry-job runs");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${a.id}'`), "0");
});

test("db e2e: BSUID-only customer - own identity, no invented phone, same conversation on repeat, separate per account, promotion when a phone appears", { skip }, async () => {
  const a = account("alpha"), b = account("beta"), bs = `BS-TS-${uniq()}`;
  const r = await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph: null, bsuid: bs }), RECEIVED, { bsuid: true });
  assert.deepEqual([r.httpStatus, r.processed], [200, 1]);
  assert.equal(q(`select (customer_wa_id is null and customer_bsuid='${bs}')::text from public.conversations where whatsapp_account_id='${a.id}'`), "true");
  assert.equal(q(`select (k.phone_e164 is null)::text from public.contacts k join public.conversations c on c.contact_id=k.id where c.whatsapp_account_id='${a.id}'`), "true");
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph: null, bsuid: bs }), RECEIVED, { bsuid: true })).processed, 1);
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${a.id}'`), "1");
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, b.pnid, { ph: null, bsuid: bs }), RECEIVED, { bsuid: true })).processed, 1);
  assert.equal(q(`select count(distinct contact_id) from public.conversations where customer_bsuid='${bs}'`), "2", "the same BSUID on another account is another contact");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${b.id}' and company_id=(select id from public.companies where slug='beta')`), "1");
  const ph = phone();
  assert.equal((await post(item("inbound", `wamid.TS.${uniq()}`, a.pnid, { ph, bsuid: bs }), RECEIVED, { bsuid: true })).processed, 1);
  assert.equal(q(`select count(*)||'/'||max(customer_wa_id) from public.conversations where whatsapp_account_id='${a.id}'`), `1/${ph}`);
});

test("db e2e: no phone and no BSUID is QUARANTINED (never dropped, no identity guessed), then reprocessed once the BSUID field is known", { skip }, async () => {
  const a = account("alpha"), w = `wamid.TS.${uniq()}`, bs = `BS-RQ-${uniq()}`;
  const snap = () => q(`select (select count(*) from public.conversations where whatsapp_account_id='${a.id}')||'/'||(select count(*) from public.contact_identities where value='${bs}')`);
  const r = await post(item("inbound", w, a.pnid, { ph: null, bsuid: bs }), RECEIVED);   // BSUID present, but KAPSO_BSUID_PATHS is empty
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed, r.parseErrors], [200, 1, 0, ["item[0].missing_customer_identity"]]);
  assert.equal(q(`select status||'|'||last_error||'|'||(payload->>'kind')||'|'||(payload->'rawItem'->'message'->>'id') from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`),
    `failed|invalid.missing_customer_identity|kapso_quarantined|${w}`);
  assert.equal(snap(), "0/0", "no contact, conversation or identity was created");
  q("select public.process_webhook_retries(100, 8)");
  assert.equal(q(`select status||'|'||attempts from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`), "failed|1", "the retry job never touches it");
  // redelivery of the same event (still unreadable) is the same row, not a second one
  await post(item("inbound", w, a.pnid, { ph: null, bsuid: bs }), RECEIVED);
  assert.equal(q(`select count(*)||'|'||max(attempts) from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`), "1|2");
  // operator reprocess with the (here test-only) field location: the stored item now parses and completes the SAME row
  const st = store();
  const none = await reprocessQuarantinedV2(st, "invalid.missing_customer_identity", { limit: 500 });
  assert.equal(none.reprocessed, 0, "without a BSUID location nothing can be resolved: the rows stay quarantined");
  const res = await reprocessQuarantinedV2(st, "invalid.missing_customer_identity", { bsuidPaths: [["conversation", "test_only_user_id"]], limit: 500 });
  assert.ok(res.reprocessed >= 1, JSON.stringify(res));
  assert.equal(q(`select status||'|'||payload::text from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`), "processed|{}");
  assert.equal(snap(), "1/1", "one conversation and one BSUID identity, scoped to this account");
  assert.equal(q(`select (customer_wa_id is null)::text from public.conversations where whatsapp_account_id='${a.id}'`), "true", "no phone was invented");
  const again = await reprocessQuarantinedV2(st, "invalid.missing_customer_identity", { bsuidPaths: [["conversation", "test_only_user_id"]], limit: 500 });
  assert.equal(q(`select count(*) from public.messages where wa_message_id='${w}'`), "1", `reprocessing twice creates nothing twice ${JSON.stringify(again)}`);
});

test("db e2e: every invalid item of a batch is recorded once; valid items of the same batch are processed; no lead/conversation from invalid items", { skip }, async () => {
  const a = account("alpha"), w = `wamid.TS.${uniq()}`, w2 = `wamid.TS.${uniq()}`;
  const before = q(`select count(*) from public.conversations where whatsapp_account_id='${a.id}'`);
  const bad1 = { phone_number_id: a.pnid, conversation: { phone_number_id: a.pnid } };                       // missing_message
  const bad2 = item("inbound", `wamid.TS.${uniq()}`, "bad pnid with spaces");                                 // invalid_phone_number_id
  const bad3 = item("outbound", `wamid.TS.${uniq()}`, a.pnid);                                                  // direction_mismatch
  const ok4 = item("inbound", w2, a.pnid);   // built once: two calls would give message.from and conversation.phone_number different phones
  const bad4 = { ...ok4, message: { ...ok4.message, timestamp: "yesterday" } };                                 // invalid_timestamp
  const batch = { batch: true, data: [item("inbound", w, a.pnid), bad1, bad2, bad3, bad4] };
  const r = await post(batch, RECEIVED);
  assert.deepEqual([r.httpStatus, r.processed, r.quarantined], [200, 1, 4]);
  assert.equal(q(`select string_agg(distinct last_error, ',' order by last_error) from public.whatsapp_webhook_events where status='failed' and payload->>'kind'='kapso_quarantined' and (event_key='kapso:msg:${w2}' or payload->'shape' is not null) and received_at > now() - interval '1 minute' and last_error in ('invalid.missing_message','invalid.invalid_phone_number_id','invalid.direction_mismatch','invalid.invalid_timestamp')`),
    "invalid.direction_mismatch,invalid.invalid_phone_number_id,invalid.invalid_timestamp,invalid.missing_message");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${a.id}'`), String(Number(before) + 1), "only the valid item created a conversation");
  const again = await post(batch, RECEIVED);   // the provider retries the whole batch
  assert.deepEqual([again.processed, again.duplicates + again.quarantined], [0, 5]);
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${a.id}'`), String(Number(before) + 1));
});

test("db e2e: mixed batch + storage outage mid-batch -> 503; the provider's retry of the whole batch completes it without duplicates", { skip }, async () => {
  const a = account("alpha"), ph = phone(), ws = [1, 2, 3, 4].map(() => `wamid.TS.${uniq()}`);
  let calls = 0;
  const flaky: RpcClient = { rpc: (name, args) => (++calls > 6 ? Promise.resolve({ data: null, error: { message: "fetch failed" } }) : rpcClient.rpc(name, args)) };
  const batch = { batch: true, data: ws.map((w) => item("inbound", w, a.pnid, { ph })) };   // one customer, four messages
  const raw = enc(JSON.stringify(batch));
  const r1 = await handleKapsoPostV2({ rawBody: raw, signature: sign(raw), eventName: RECEIVED, payloadVersion: "v2" }, SECRET, createKapsoStoreV2(flaky));
  assert.equal(r1.httpStatus, 503, "something could not be recorded: the provider must redeliver");
  assert.ok(r1.processed >= 1 && r1.processed < 4, JSON.stringify(r1));
  const r2 = await post(batch, RECEIVED);
  assert.equal(r2.httpStatus, 200);
  assert.equal(r2.processed + r2.duplicates, 4);
  assert.equal(q(`select count(*)||'/'||count(distinct wa_message_id) from public.messages where wa_message_id in (${ws.map((w) => `'${w}'`).join(",")})`), "4/4");
  assert.equal(q(`select count(*) from public.leads l join public.conversations c on c.id=l.conversation_id where c.whatsapp_account_id='${a.id}'`), "1", "one customer, one lead");
  assert.equal(q(`select string_agg(distinct status, ',') from public.whatsapp_webhook_events where event_key in (${ws.map((w) => `'kapso:msg:${w}'`).join(",")})`), "processed");
});

// ---------------------------------------------------------------------------------------------- protocol / account compatibility
function sandboxAccount() {
  const k = uniq();
  const co = q(`insert into public.companies (name, slug, is_sandbox) values ('Sandbox ${k}', 'sbx-${k}', true) returning id;`).split("\n")[0];
  const pnid = `TSSB_${k}`;
  const id = q(`insert into public.whatsapp_accounts (default_company_id, display_name, phone_e164, phone_number_id, provider, environment, connection_mode, status)
    values ('${co}', 'sb ${k}', '+1556${String(7000000 + k).slice(-7)}', '${pnid}', 'kapso', 'sandbox', 'sandbox', 'test') returning id;`).split("\n")[0];
  return { id, pnid, company: co };
}
/** Same RPC mapping as src/server/whatsapp/kapso-store.ts createKapsoStore (which is server-only), over the psql transport. */
function v1Store(): KapsoStore {
  const call = async (n: string, args: Record<string, unknown>) => { const { data, error } = await rpcClient.rpc(n, args); if (error) throw error; return data; };
  return {
    claimEvent: async (e) => (await call("claim_webhook_event", { p_event_key: e.eventKey, p_event_kind: kapsoDbEventKind(e.kind), p_phone_number_id: e.phoneNumberId, p_payload: e.payload })) as ClaimResult,
    finishEvent: async (k, s, err) => { await call("finish_webhook_event", { p_event_key: k, p_status: s, p_error: err ?? null }); },
    ingestMessage: async (e) => {
      const d = (await call("ingest_kapso_message", { p_phone_number_id: e.phoneNumberId, p_wa_message_id: e.waMessageId, p_from_wa_id: e.fromWaId, p_profile_name: e.profileName ?? "", p_message_type: e.messageType, p_body: e.body ?? "", p_media: null, p_sent_at: e.sentAt.toISOString() })) as Array<{ duplicate?: boolean }> | null;
      return { duplicate: Boolean(d?.[0]?.duplicate) };
    },
    applyStatus: async () => false,
    accountClass: async (pn) => { const d = await call("kapso_account_protocol", { p_phone_number_id: pn }); return d === "sandbox" || d === "production" || d === "misconfigured" ? d : null; },
  };
}
const postV1 = (payload: unknown, event: string) => {
  const raw = enc(JSON.stringify(payload));
  return handleKapsoPost({ rawBody: raw, signature: sign(raw), eventName: event, payloadVersion: "v2" }, SECRET, v1Store());
};

test("db e2e protocol: v1 + PRODUCTION account fails closed - quarantined as protocol.v2_required with its item, nothing ingested", { skip }, async () => {
  const a = account("alpha"), w = `wamid.TS.${uniq()}`;
  const r = await postV1(item("inbound", w, a.pnid), RECEIVED);
  assert.deepEqual([r.httpStatus, r.quarantined, r.processed], [200, 1, 0]);
  assert.equal(q(`select status||'|'||last_error||'|'||(payload->>'kind')||'|'||(payload->'rawItem' is not null)::text from public.whatsapp_webhook_events where event_key='kapso:msg:${w}'`), "failed|protocol.v2_required|kapso_quarantined|true");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${a.id}'`), "0");
});

test("db e2e protocol: v1 + SANDBOX account is processed exactly as before; v2 + SANDBOX account is processed too (Rev6 delegation)", { skip }, async () => {
  const s = sandboxAccount();
  const r1 = await postV1(item("inbound", `wamid.TS.${uniq()}`, s.pnid), RECEIVED);
  assert.deepEqual([r1.httpStatus, r1.processed, r1.quarantined], [200, 1, 0]);
  const r2 = await post(item("inbound", `wamid.TS.${uniq()}`, s.pnid), RECEIVED);
  assert.deepEqual([r2.httpStatus, r2.processed, r2.quarantined], [200, 1, 0]);
  assert.equal(q(`select count(*)||'/'||bool_and(c.company_id='${s.company}')::text||'/'||bool_and(c.is_sandbox)::text from public.conversations c where c.whatsapp_account_id='${s.id}'`), "2/true/true",
    "both land in the sandbox company, marked sandbox");
});

test("db e2e protocol: one v2 delivery with two accounts of different kinds keeps each in its own account and company", { skip }, async () => {
  const p = account("beta"), s = sandboxAccount();
  const r = await post({ batch: true, data: [item("inbound", `wamid.TS.${uniq()}`, p.pnid), item("inbound", `wamid.TS.${uniq()}`, s.pnid)] }, RECEIVED);
  assert.deepEqual([r.httpStatus, r.processed], [200, 2]);
  assert.equal(q(`select count(*) from public.conversations c join public.companies k on k.id=c.company_id where c.whatsapp_account_id='${p.id}' and k.slug='beta' and not c.is_sandbox`), "1");
  assert.equal(q(`select count(*) from public.conversations where whatsapp_account_id='${s.id}' and company_id='${s.company}' and is_sandbox`), "1");
});

test("db e2e media: an inbound image / voice note keeps its file reference in messages.media; the text is the caption only; an echo with a file too", { skip }, async () => {
  const a = account("alpha"), ph = phone();
  const mk = (type: string, wamid: string, dir: "inbound" | "outbound", origin: string | null, part: Record<string, unknown>, caption?: string) => ({
    message: {
      id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type, ...(dir === "inbound" ? { from: ph } : { to: ph }),
      [type]: { id: `MEDIA_${wamid.replace(/\W/g, "")}`, mime_type: type === "audio" ? "audio/ogg" : "image/jpeg", ...(caption ? { caption } : {}), ...part },
      kapso: { direction: dir, ...(origin ? { origin } : {}), has_media: true, content: `${type} attached (f.bin) URL: https://api.kapso.ai/media/SECRET`,
        media_data: { url: "https://app.kapso.ai/rails/blob/SIGNED/f.bin", filename: type === "audio" ? "voice.ogg" : "photo.jpg", content_type: type === "audio" ? "audio/ogg" : "image/jpeg", byte_size: 1234 },
        ...(type === "audio" ? { transcript: { text: "hello transcript" } } : {}) },
    },
    conversation: { id: "c", contact_name: "Media Customer", phone_number_id: a.pnid, phone_number: ph }, phone_number_id: a.pnid,
  });
  const img = `wamid.TS.img.${uniq()}`, voice = `wamid.TS.voice.${uniq()}`, echo = `wamid.TS.echo.${uniq()}`;
  assert.equal((await post(mk("image", img, "inbound", null, {}, "صورة المنتج"), RECEIVED)).processed, 1);
  assert.equal((await post(mk("audio", voice, "inbound", null, { voice: true }), RECEIVED)).processed, 1);
  const row = (w: string) => q(`select coalesce(body,'<null>')||'|'||(media->>'provider')||'|'||(media->>'kind')||'|'||(media->>'id')||'|'||coalesce(media->>'transcript','-')||'|'||coalesce(media->>'voice','') from public.messages where wa_message_id='${w}'`);
  assert.equal(row(img), `صورة المنتج|kapso|image|MEDIA_${img.replace(/\W/g, "")}|-|`);
  assert.equal(row(voice).split("|").slice(0, 3).join("|"), "|kapso|audio", "a voice note has an empty text");
  assert.match(row(voice), /hello transcript\|true$/);
  assert.equal(q(`select count(*) from public.messages where wa_message_id in ('${img}','${voice}') and (body like '%SECRET%' or body like '%attached%' or media::text like '%SECRET%')`), "0", "Kapso's generated text / link is never stored");
  const e = await post(mk("image", echo, "outbound", "business_app", {}), SENT);
  assert.equal(e.processed, 1, "the echo of a photo sent from the Business App");
  assert.equal(q(`select (media->>'kind')||'/'||direction||'/'||coalesce(sent_by::text,'null') from public.messages where wa_message_id='${echo}'`), "image/outbound/null");
});

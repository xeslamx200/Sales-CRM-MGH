import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractKapsoMessageId, isRecipientAllowed, KAPSO_SEND_BASE, parseSendAllowlist, sendKapsoText } from "../../src/lib/kapso/send.ts";
import { EnvError, parseEnv, serverSchemas } from "../../src/env.ts";

const KEY = "unit-test-kapso-api-key-0123456789"; // throwaway, tests only
const base = { phoneNumberId: "1279070011960861", apiKey: KEY, toWaId: "201000000001", body: "hello" };
const reply = (status: number, json: unknown) => (async () => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

test("kapso send: request shape - endpoint, X-API-Key header, text body, no secrets in the URL", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ messages: [{ id: "wamid.ABC=" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const r = await sendKapsoText({ ...base, fetchImpl: f });
  assert.deepEqual(r, { ok: true, waMessageId: "wamid.ABC=" });
  assert.equal(seen!.url, `${KAPSO_SEND_BASE}/1279070011960861/messages`);
  assert.equal(seen!.url.includes(KEY), false);
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h["X-API-Key"], KEY);
  assert.equal("Authorization" in h, false);
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { messaging_product: "whatsapp", recipient_type: "individual", to: "201000000001", type: "text", text: { preview_url: false, body: "hello" } });
  assert.equal(seen!.init.method, "POST");
});

test("kapso send: invalid input is refused locally and nothing is requested", async () => {
  let calls = 0; const f = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
  for (const o of [{ toWaId: "US.1349120865" }, { toWaId: "+201000000001" }, { toWaId: "" }, { body: "   " }, { body: "x".repeat(4097) }, { phoneNumberId: "../x" }, { apiKey: "short" }]) {
    const r = await sendKapsoText({ ...base, ...o, fetchImpl: f });
    assert.equal(r.ok, false); assert.equal((r as { kind: string }).kind, "definite");
  }
  assert.equal(calls, 0);
});

test("kapso send: 4xx refusals are DEFINITE (nothing was sent) - Meta and Kapso error shapes", async () => {
  const cases: Array<[number, unknown, string]> = [
    [422, { error: { message: "Cannot send non-template messages outside the 24-hour window.", type: "MessageError", code: 131047 } }, "131047"],
    [400, { error: { message: "Invalid phone number format", type: "OAuthException", code: 400, error_subcode: 1001 } }, "400"],
    [402, { error: "no credits", code: "insufficient_credits", billing_url: "https://x" }, "insufficient_credits"],
    [409, { error: "Another app controls this conversation.", code: "thread_not_owner" }, "thread_not_owner"],
    [409, { error: "Another message is already in-flight for this conversation. Please retry shortly." }, "http_409"],
    [429, { error: "Rate limit exceeded" }, "http_429"],
    [401, { error: "bad key" }, "http_401"],
    [423, { error: "review", code: "project_under_review" }, "project_under_review"],
  ];
  for (const [status, json, code] of cases) {
    const r = await sendKapsoText({ ...base, fetchImpl: reply(status, json) });
    assert.equal(r.ok, false); const f = r as { kind: string; code: string; httpStatus: number };
    assert.deepEqual([f.kind, f.code, f.httpStatus], ["definite", code, status], `${status} ${code}`);
  }
});

test("kapso send: UNCONFIRMED outcomes (5xx, timeout, network error, 2xx without an id) are never reported as failed or retried", async () => {
  let calls = 0;
  const counting = (inner: typeof fetch) => (async (...a: Parameters<typeof fetch>) => { calls++; return inner(...a); }) as typeof fetch;
  const out: Array<[string, typeof fetch]> = [
    ["5xx", counting(reply(502, { error: "bad gateway" }))],
    ["200 no id", counting(reply(200, { messaging_product: "whatsapp", messages: [] }))],
    ["200 not json", counting((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)],
    ["network", counting((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)],
    ["timeout", counting((async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch)],
  ];
  for (const [label, f] of out) {
    const r = await sendKapsoText({ ...base, fetchImpl: f });
    assert.equal(r.ok, false, label); assert.equal((r as { kind: string }).kind, "unconfirmed", label);
  }
  assert.equal(calls, out.length, "exactly one request each: the client never retries (Kapso has no idempotency key)");
});

test("kapso send: error text never contains the request body or recipient, and is bounded", async () => {
  const long = "x".repeat(2000);
  const r = await sendKapsoText({ ...base, body: "TOP SECRET WORDS", fetchImpl: reply(400, { error: { message: long, code: 1 } }) }) as { message: string };
  assert.ok(r.message.length <= 300);
  const net = await sendKapsoText({ ...base, body: "TOP SECRET WORDS", fetchImpl: (async () => { throw new Error("connect 201000000001 TOP SECRET WORDS " + KEY); }) as unknown as typeof fetch }) as { message: string; code: string };
  assert.equal(JSON.stringify(net).includes("TOP SECRET"), false);
  assert.equal(JSON.stringify(net).includes(KEY), false);
  assert.equal(JSON.stringify(net).includes("201000000001"), false);
});

test("kapso send: message id extraction is strict", () => {
  assert.equal(extractKapsoMessageId({ messages: [{ id: "wamid.HBgN" }] }), "wamid.HBgN");
  for (const bad of [null, {}, { messages: [] }, { messages: [{}] }, { messages: [{ id: "" }] }, { messages: [{ id: "has space" }] }, { messages: [{ id: 5 }] }]) assert.equal(extractKapsoMessageId(bad), null);
});

test("kapso send allow-list: fail closed; numbers normalised; * is explicit", () => {
  for (const empty of [undefined, null, "", "  ", ",", "abc", "123"]) assert.equal(isRecipientAllowed(parseSendAllowlist(empty as string), "201000000001"), false, String(empty));
  const l = parseSendAllowlist("+201000000001, 201-000-000002;(971)500000003");
  assert.deepEqual([...l.numbers].sort(), ["201000000001", "201000000002", "971500000003"]);
  assert.equal(l.all, false);
  assert.equal(isRecipientAllowed(parseSendAllowlist("+201000000001, 201000000002"), "201000000001"), true);
  assert.equal(isRecipientAllowed(parseSendAllowlist("+201000000001"), "201000000099"), false);
  assert.equal(isRecipientAllowed(parseSendAllowlist("+201000000001"), null), false);
  assert.equal(isRecipientAllowed(parseSendAllowlist("*"), "201000000099"), true);
  assert.equal(isRecipientAllowed(parseSendAllowlist("*"), null), false, "a BSUID-only customer (no phone) is never allowed, even with *");
});

test("kapso send env: both variables are required and errors name variables only", () => {
  assert.throws(() => parseEnv(serverSchemas.kapsoSend, {}), (e: unknown) => e instanceof EnvError && e.variables.join() === "KAPSO_API_KEY,KAPSO_SEND_ALLOWLIST");
  assert.throws(() => parseEnv(serverSchemas.kapsoSend, { KAPSO_API_KEY: KEY }), (e: unknown) => e instanceof EnvError && e.variables.join() === "KAPSO_SEND_ALLOWLIST");
  const ok = parseEnv(serverSchemas.kapsoSend, { KAPSO_API_KEY: KEY, KAPSO_SEND_ALLOWLIST: "+201000000001" });
  assert.equal(ok.KAPSO_SEND_ALLOWLIST, "+201000000001");
});

test("kapso send wiring: the allow-list and text-only checks run BEFORE queue_outbound; the unconfirmed path never resends", () => {
  const src = readFileSync(new URL("../../src/server/whatsapp/send.ts", import.meta.url), "utf8");
  const iAllow = src.indexOf("isRecipientAllowed"), iQueue = src.indexOf('rpc("queue_outbound"'), iKapso = src.indexOf("sendKapsoText({");
  assert.ok(iAllow > 0 && iQueue > iAllow, "allow-list is checked before anything is queued");
  assert.ok(src.indexOf('"whatsapp.kapso_text_only"') < iQueue);
  assert.ok(iKapso > iQueue);
  assert.equal((src.match(/sendKapsoText\(/g) ?? []).length, 1, "a single call site, no retry loop around the Kapso send");
  assert.ok(src.includes("record_outbound_unconfirmed"));
  const kapsoBlock = src.slice(iKapso, src.indexOf("let result: SendResult"));
  assert.equal(/attempt|backoff|retry\(/i.test(kapsoBlock.replace(/never resend|resend/gi, "")), false, "no retry in the Kapso branch");
});

test("kapso send: a customer known only by BSUID is addressed with `recipient`, never `to`; a phone always wins; garbage is refused", async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ messages: [{ id: "wamid.B=" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const { toWaId: _drop, ...noPhone } = base; void _drop;
  assert.deepEqual(await sendKapsoText({ ...noPhone, toBsuid: "QA.13491208655302741918", fetchImpl: f }), { ok: true, waMessageId: "wamid.B=" });
  assert.equal(bodies[0].recipient, "QA.13491208655302741918");
  assert.equal("to" in bodies[0], false, "no phone number is sent or invented");
  await sendKapsoText({ ...base, toBsuid: "QA.13491208655302741918", fetchImpl: f });
  assert.equal(bodies[1].to, "201000000001"); assert.equal("recipient" in bodies[1], false, "a known phone is used alone");
  let calls = 0; const g = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
  for (const toBsuid of ["", "x y", "a".repeat(200), '"}', undefined as unknown as string]) {
    const r = await sendKapsoText({ ...noPhone, toBsuid, fetchImpl: g });
    assert.equal(r.ok, false); assert.equal((r as { kind: string }).kind, "definite");
  }
  assert.equal(calls, 0);
});

test("kapso send: a 4xx for a BSUID recipient is a definite refusal (nothing was sent, a person decides)", async () => {
  const { toWaId: _drop, ...noPhone } = base; void _drop;
  const r = await sendKapsoText({ ...noPhone, toBsuid: "QA.123456789", fetchImpl: reply(400, { error: { code: 100, message: "Param recipient is not supported" } }) });
  assert.deepEqual(r, { ok: false, kind: "definite", code: "100", message: "Param recipient is not supported", httpStatus: 400 });
});

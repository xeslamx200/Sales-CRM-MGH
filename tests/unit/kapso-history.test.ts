import { test } from "node:test";
import assert from "node:assert/strict";
import { mapKapsoMessage, phoneDigits, startOfDay, unifyIdentities } from "../../src/lib/kapso/history.ts";

const msg = (o: Record<string, unknown>) => ({ id: "wamid.A1", type: "text", timestamp: "1786000000", from: "+974 5550 0001", text: { body: "hi" }, kapso: { direction: "inbound", whatsapp_conversation_id: "c1", contact_name: "Sara" }, ...o });

test("history: an inbound text becomes one row with the customer's number, name and text", () => {
  const r = mapKapsoMessage(msg({}));
  assert.ok("row" in r);
  assert.deepEqual(r.row, { id: "wamid.A1", d: "i", ts: 1786000000, ph: "97455500001", bs: null, nm: "Sara", ty: "text", b: "hi", st: "sent" });
  assert.equal(r.cid, "c1");
});

test("history: outbound uses the recipient, keeps a known status, and a media message without text gets a placeholder", () => {
  const r = mapKapsoMessage(msg({ id: "wamid.B", type: "image", from: "+97450000000", to: "97455500001", kapso: { direction: "outbound", status: "read" } }));
  assert.ok("row" in r);
  assert.equal(r.row.d, "o"); assert.equal(r.row.ph, "97455500001"); assert.equal(r.row.st, "read"); assert.equal(r.row.b, "[image]");
});

test("history: reactions, edits, bad ids and missing times are skipped", () => {
  assert.deepEqual(mapKapsoMessage(msg({ type: "reaction" })), { skip: "type" });
  assert.deepEqual(mapKapsoMessage(msg({ id: "bad id" })), { skip: "bad_id" });
  assert.deepEqual(mapKapsoMessage(msg({ timestamp: "x" })), { skip: "no_time" });
});

test("history: a BSUID-only customer keeps the BSUID; a staff reply inherits its conversation's identity; two phones are never merged", () => {
  const a = mapKapsoMessage(msg({ from: undefined, from_user_id: "QA.123456" }));
  assert.ok("row" in a); assert.equal(a.row.ph, null); assert.equal(a.row.bs, "QA.123456");
  const reply = mapKapsoMessage(msg({ id: "wamid.R", from: "+97450000000", to: undefined, kapso: { direction: "outbound", whatsapp_conversation_id: "c1" } }));
  const cust = mapKapsoMessage(msg({}));
  assert.ok("row" in reply && "row" in cust);
  const out = unifyIdentities([cust, reply]);
  assert.equal(out[1].ph, "97455500001", "the reply gets the customer's number from its conversation");
  const other = mapKapsoMessage(msg({ id: "wamid.X", from: "+97455500002" }));
  assert.ok("row" in other);
  const mixed = unifyIdentities([cust, other, reply]);
  assert.equal(mixed[2].ph, null, "a conversation with two different numbers is not guessed");
});

test("history: day and phone helpers", () => {
  assert.equal(startOfDay("2026-08-01"), Date.parse("2026-08-01T00:00:00Z") / 1000);
  assert.equal(startOfDay("2099-01-01"), null, "not in the future");
  assert.equal(startOfDay("01/08/2026"), null);
  assert.equal(phoneDigits("+20 10 4398 5305"), "201043985305");
  assert.equal(phoneDigits("123"), null);
});

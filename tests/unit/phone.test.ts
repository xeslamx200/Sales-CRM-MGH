import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, waIdToE164, e164ToWaId } from "../../src/lib/phone.ts";

const ok = (input: string, expected: string, cc?: string) =>
  assert.deepEqual(normalizePhone(input, cc), { ok: true, e164: expected }, input);

test("equivalent inputs normalize to the same E.164 number", () => {
  for (const input of ["+974 5555 0001", "+974-5555-0001", "00974 5555 0001", "974 5555 0001", "5555 0001", "(+974) 5555.0001"]) {
    ok(input, "+97455550001");
  }
});

test("Arabic-Indic and Persian digits are converted", () => {
  ok("+٩٧٤ ٥٥٥٥ ٠٠٠١", "+97455550001");
  ok("۰۰۹۷۴۵۵۵۵۰۰۰۱", "+97455550001");
});

test("local numbers use the company's default country code and drop the trunk zero", () => {
  ok("010 0000 0001", "+201000000001", "20");
  ok("1000000001", "+201000000001", "20");
});

test("explicit international numbers are never re-prefixed", () => {
  ok("+20 100 000 0001", "+201000000001", "974");
  ok("0020 100 000 0001", "+201000000001", "974");
});

test("invalid and ambiguous input is rejected, not guessed", () => {
  assert.deepEqual(normalizePhone(""), { ok: false, reason: "empty" });
  assert.deepEqual(normalizePhone(null), { ok: false, reason: "empty" });
  assert.deepEqual(normalizePhone("call me"), { ok: false, reason: "invalid" });
  assert.deepEqual(normalizePhone("+974 5555 0001 ext 3"), { ok: false, reason: "invalid" });
  assert.deepEqual(normalizePhone("+0 123 4567"), { ok: false, reason: "invalid" });
  assert.deepEqual(normalizePhone("+1234"), { ok: false, reason: "invalid" });
  assert.deepEqual(normalizePhone("+1234567890123456"), { ok: false, reason: "invalid" });
});

test("WhatsApp id conversions", () => {
  assert.equal(waIdToE164("97455550001"), "+97455550001");
  assert.equal(waIdToE164("+97455550001"), null);
  assert.equal(waIdToE164("0123"), null);
  assert.equal(e164ToWaId("+97455550001"), "97455550001");
  assert.equal(e164ToWaId("97455550001"), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChatExport } from "../../src/lib/whatsapp/chat-export.ts";

const android24 = [
  "‎15/11/2026, 09:05 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.",
  "15/11/2026, 09:05 - Nahj Team: Hello, welcome",
  "15/11/2026, 09:07 - Sara Ali: Hi, I want the course details",
  "and the price please",
  "15/11/2026, 09:08 - Sara Ali: <Media omitted>",
  "16/11/2026, 18:30 - Nahj Team: Sure: 750 QAR",
  "16/11/2026, 18:31 - Sara Ali joined using this group's invite link",
].join("\n");

test("chat export: Android 24-hour format - senders, times, multi-line text, media and system lines", () => {
  const r = parseChatExport(android24);
  assert.deepEqual(r.senders, ["Nahj Team", "Sara Ali"]);
  assert.equal(r.messages.length, 4);
  assert.equal(r.messages[0].local, "2026-11-15T09:05:00");
  assert.equal(r.messages[1].text, "Hi, I want the course details\nand the price please");
  assert.equal(r.messages[2].media, true); assert.equal(r.messages[2].text, "");
  assert.equal(r.messages[3].text, "Sure: 750 QAR", "a colon inside the text is kept");
  assert.equal(r.order, "dmy"); assert.equal(r.orderCertain, true, "15 and 16 can only be days");
  assert.equal(r.skipped, 2, "the encryption notice and the 'joined' line are not messages");
});

test("chat export: iPhone brackets with seconds, and 12-hour AM/PM", () => {
  const r = parseChatExport("[11/15/26, 1:05:09 PM] Nahj Team: ok\n[11/15/26, 12:10:00 AM] Sara: late night\n[11/16/26, 12:00:00 PM] Sara: noon");
  assert.equal(r.order, "mdy"); assert.equal(r.orderCertain, true, "a second number of 15 can only be a day");
  assert.deepEqual(r.messages.map((m) => m.local), ["2026-11-15T13:05:09", "2026-11-15T00:10:00", "2026-11-16T12:00:00"]);
});

test("chat export: Arabic digits, Arabic AM/PM (ص / م) and invisible direction marks", () => {
  const r = parseChatExport("‏[١٥‏/١١‏/٢٠٢٦ ٣:٠٥:٠٠ م] نهج: مرحبا\n‏١٥/١١/٢٠٢٦، ١٠:٠٥ ص - سارة: أهلا");
  assert.equal(r.messages.length, 1, "the second line uses an Arabic comma, which the Android pattern does not accept: it continues the first message");
  assert.equal(r.messages[0].local, "2026-11-15T15:05:00");
  assert.equal(r.messages[0].sender, "نهج");
});

test("chat export: an ambiguous date order defaults to day-first and says it is not certain; the caller can override it", () => {
  const text = "03/04/2026, 10:00 - A: x\n05/06/2026, 11:00 - B: y";
  const d = parseChatExport(text);
  assert.equal(d.order, "dmy"); assert.equal(d.orderCertain, false);
  assert.equal(d.messages[0].local, "2026-04-03T10:00:00");
  const m = parseChatExport(text, { order: "mdy" });
  assert.equal(m.messages[0].local, "2026-03-04T10:00:00"); assert.equal(m.orderCertain, true);
});

test("chat export: garbage and empty input give no messages, never a crash", () => {
  for (const t of ["", "hello world", "\n\n", "15/13/2026, 99:99 - A: bad time"]) assert.equal(parseChatExport(t).messages.length, 0);
});

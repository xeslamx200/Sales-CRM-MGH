import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTextMessage } from "../../src/lib/whatsapp/cloud-api.ts";
import { sendMediaMessage, sendTemplateMessage } from "../../src/lib/whatsapp/graph.ts";

/**
 * What the customer sees is decided by the WhatsApp Business account behind the
 * phone number id, never by the CRM. These tests pin the payloads the CRM sends
 * to Meta: they carry only the recipient and the content, with no field through
 * which an employee's name (or anything else about the sender) could travel.
 * Employee attribution lives in our own database (messages.sent_by).
 */
type Call = { url: string; body: Record<string, unknown> };
function capture() {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}
const base = { accessToken: "tok", apiVersion: "v26.0", phoneNumberId: "123456", toWaId: "97455550001" };

test("a text message carries exactly the recipient and the typed text", async () => {
  const c = capture();
  const text = "Thanks for contacting us";
  const r = await sendTextMessage({ ...base, body: text, fetchImpl: c.impl });
  assert.ok(r.ok);
  assert.deepEqual(c.calls[0].body, {
    messaging_product: "whatsapp", recipient_type: "individual", to: "97455550001", type: "text",
    text: { preview_url: false, body: text },
  });
  assert.equal(c.calls[0].url, "https://graph.facebook.com/v26.0/123456/messages", "sent from the business number's own id");
});

test("no payload has a sender, profile or employee field", async () => {
  const c = capture();
  await sendTextMessage({ ...base, body: "hi", fetchImpl: c.impl });
  await sendMediaMessage({ ...base, kind: "image", mediaId: "MID", caption: "offer", fetchImpl: c.impl });
  await sendMediaMessage({ ...base, kind: "document", mediaId: "MID", filename: "price list.pdf", fetchImpl: c.impl });
  await sendTemplateMessage({ ...base, name: "follow_up", language: "ar", params: ["Sara"], fetchImpl: c.impl });
  assert.equal(c.calls.length, 4);
  const allowedTop = new Set(["messaging_product", "recipient_type", "to", "type", "text", "image", "document", "template"]);
  for (const { body } of c.calls) {
    for (const key of Object.keys(body)) assert.ok(allowedTop.has(key), `unexpected top-level field "${key}"`);
    assert.ok(!JSON.stringify(Object.keys(body)).match(/from|sender|profile|employee|agent|user|name/i), "no identity-like top-level key");
  }
});

test("the text is sent verbatim: nothing (such as an employee name or signature) is appended", async () => {
  const c = capture();
  for (const text of ["hello", "مرحبا، كيف أخدمك؟", "line one\nline two"]) {
    await sendTextMessage({ ...base, body: text, fetchImpl: c.impl });
  }
  assert.deepEqual(c.calls.map((x) => (x.body.text as { body: string }).body), ["hello", "مرحبا، كيف أخدمك؟", "line one\nline two"]);
});

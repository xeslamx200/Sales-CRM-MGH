import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPhoneNumber, downloadMedia, fetchTemplates, getMediaUrl, isCredentialError, isInlinePreview, safeFileName,
  sendMediaMessage, sendTemplateMessage, templateBody, uploadMedia,
} from "../../src/lib/whatsapp/graph.ts";

type Call = { url: string; init: RequestInit };
function mockFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error("unexpected request");
    return typeof r === "function" ? r() : r;
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const base = { accessToken: "tok-123", apiVersion: "v26.0" };

test("credential errors are recognized (expired/revoked/invalid token, permissions, 401)", () => {
  assert.ok(isCredentialError("190", 400));
  assert.ok(isCredentialError("10", 403));
  assert.ok(isCredentialError(null, 401));
  assert.ok(!isCredentialError("131047", 400), "24h-window error is not a credential problem");
  assert.ok(!isCredentialError("130429", 429));
});

test("template body and parameter count come from the BODY component", () => {
  assert.deepEqual(templateBody([{ type: "HEADER", text: "x" }, { type: "BODY", text: "Hi {{1}}, order {{2}} ships {{2}}" }]),
    { body_text: "Hi {{1}}, order {{2}} ships {{2}}", param_count: 2 });
  assert.deepEqual(templateBody([]), { body_text: "", param_count: 0 });
});

test("template messages are sent with language and body parameters", async () => {
  const m = mockFetch([json({ messages: [{ id: "wamid.T" }] })]);
  const r = await sendTemplateMessage({ ...base, fetchImpl: m.impl, phoneNumberId: "123456", toWaId: "97455550001",
    name: "follow_up", language: "ar", params: ["سارة", "1042"] });
  assert.deepEqual(r, { ok: true, waMessageId: "wamid.T" });
  assert.equal(m.calls[0].url, "https://graph.facebook.com/v26.0/123456/messages");
  assert.equal((m.calls[0].init.headers as Record<string, string>).Authorization, "Bearer tok-123");
  assert.deepEqual(JSON.parse(String(m.calls[0].init.body)), {
    messaging_product: "whatsapp", recipient_type: "individual", to: "97455550001", type: "template",
    template: { name: "follow_up", language: { code: "ar" }, components: [{ type: "body", parameters: [{ type: "text", text: "سارة" }, { type: "text", text: "1042" }] }] },
  });
  const bad = await sendTemplateMessage({ ...base, fetchImpl: m.impl, phoneNumberId: "123456", toWaId: "x", name: "a", language: "ar", params: [] });
  assert.equal(bad.ok, false);
  assert.equal(m.calls.length, 1, "invalid input never reaches the network");
});

test("media messages reference an uploaded media id; documents keep a safe file name", async () => {
  const m = mockFetch([json({ messages: [{ id: "wamid.D" }] })]);
  await sendMediaMessage({ ...base, fetchImpl: m.impl, phoneNumberId: "123456", toWaId: "97455550001", kind: "document",
    mediaId: "MID", caption: "عرض السعر", filename: "../../etc/passwd" });
  const body = JSON.parse(String(m.calls[0].init.body));
  assert.equal(body.type, "document");
  assert.deepEqual(body.document, { id: "MID", caption: "عرض السعر", filename: ".._.._etc_passwd" });
});

test("uploads accept only supported types and send multipart with the token", async () => {
  const none = mockFetch([]);
  const rejected = await uploadMedia({ ...base, fetchImpl: none.impl, phoneNumberId: "123456", bytes: new Uint8Array([1]), mimeType: "application/x-msdownload", filename: "a.exe" });
  assert.equal(rejected.ok, false);
  assert.equal(none.calls.length, 0);
  const m = mockFetch([json({ id: "MEDIA1" })]);
  const r = await uploadMedia({ ...base, fetchImpl: m.impl, phoneNumberId: "123456", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "p.png" });
  assert.deepEqual(r, { ok: true, mediaId: "MEDIA1" });
  assert.ok(m.calls[0].init.body instanceof FormData);
  assert.equal((m.calls[0].init.body as FormData).get("type"), "image/png");
});

test("inbound media: URL lookup, then a bounded download that only ever sends the token to Meta", async () => {
  const m = mockFetch([json({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "application/pdf", file_size: 3 })]);
  const u = await getMediaUrl({ ...base, fetchImpl: m.impl, mediaId: "1234567890" });
  assert.equal(u.ok && u.mimeType, "application/pdf");

  const evil = mockFetch([]);
  const r1 = await downloadMedia({ url: "https://attacker.example/steal", accessToken: "tok-123", maxBytes: 10, fetchImpl: evil.impl });
  assert.equal(r1.ok, false);
  assert.equal(evil.calls.length, 0, "token was not sent to an untrusted host");

  const big = mockFetch([new Response(new Uint8Array(20), { headers: { "content-type": "image/jpeg" } })]);
  const r2 = await downloadMedia({ url: "https://lookaside.fbsbx.com/x", accessToken: "tok-123", maxBytes: 10, fetchImpl: big.impl });
  assert.equal(!r2.ok && r2.code, "media_too_large");

  const ok = mockFetch([new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf; charset=binary" } })]);
  const r3 = await downloadMedia({ url: "https://lookaside.fbsbx.com/x", accessToken: "tok-123", maxBytes: 10, fetchImpl: ok.impl });
  assert.ok(r3.ok && r3.bytes.byteLength === 3 && r3.mimeType === "application/pdf");
});

test("template sync follows Meta's paging links only", async () => {
  const m = mockFetch([
    json({ data: [{ name: "hello_world", language: "en_US", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hello World" }] }],
      paging: { next: "https://graph.facebook.com/v26.0/999999/message_templates?after=abc" } }),
    json({ data: [{ name: "follow_up", language: "ar", status: "APPROVED", components: [{ type: "BODY", text: "مرحباً {{1}}" }] }],
      paging: { next: "https://evil.example/next" } }),
  ]);
  const r = await fetchTemplates({ ...base, fetchImpl: m.impl, wabaId: "999999" });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.templates.map((t) => [t.name, t.param_count]), [["hello_world", 0], ["follow_up", 1]]);
  assert.equal(m.calls.length, 2, "foreign paging link not followed");
  assert.match(m.calls[1].url, /^https:\/\/graph\.facebook\.com\/v26\.0\/999999\/message_templates\?after=abc$/);
});

test("connection check surfaces an expired token as a credential error", async () => {
  const m = mockFetch([json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, 401)]);
  const r = await checkPhoneNumber({ ...base, fetchImpl: m.impl, phoneNumberId: "123456" });
  assert.ok(!r.ok && isCredentialError(r.code, r.httpStatus));
});

test("file names are made safe; only harmless types preview inline", () => {
  assert.equal(safeFileName('a/b\\c:"d"<e>.pdf'), "a_b_c__d__e_.pdf");
  assert.equal(safeFileName(".."), "file");
  assert.ok(isInlinePreview("image/png"));
  assert.ok(!isInlinePreview("text/plain"), "text is downloaded, never rendered");
  assert.ok(!isInlinePreview("application/pdf"));
});

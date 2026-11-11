import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  extractKapsoMedia, fetchKapsoMedia, isAutoMediaDescription, isKapsoHost, KAPSO_META_BASE, mediaCaption,
} from "../../src/lib/kapso/media.ts";
import { handleKapsoPostV2, parseKapsoPayloadV2, serializeKapsoEventV2, type KapsoInboundV2, type KapsoStatusV2, type KapsoStoreV2, type HeldRecord, type KapsoAccountClass } from "../../src/lib/kapso/v2.ts";
import { createKapsoStoreV2 } from "../../src/lib/kapso/store-v2.ts";
import type { ClaimResult } from "../../src/lib/whatsapp/processor.ts";

const KEY = "unit-test-kapso-api-key-0123456789"; // throwaway
const SIGNED = "https://app.kapso.ai/rails/active_storage/blobs/redirect/SIGNEDID/photo.jpg";
const enc = (s: string) => new TextEncoder().encode(s);
const sign = (b: Uint8Array) => createHmac("sha256", "unit-test-secret-0123456789").update(b).digest("hex");

/** Shapes taken from the real Platform API answers of the MGH number. */
function mediaItem(type: "image" | "audio" | "sticker" | "video" | "document", extra: Record<string, unknown> = {}, id = "wamid.MEDIA1") {
  const part: Record<string, unknown> = { id: "MEDIAID1", sha256: "abc", mime_type: type === "audio" ? "audio/ogg" : type === "sticker" ? "image/webp" : "image/jpeg", ...extra };
  return {
    message: {
      id, timestamp: "1790000000", type, from: "15550000111", [type]: part,
      kapso: {
        direction: "inbound", origin: "cloud_api", has_media: true,
        content: `${type} attached (x.bin) [Size: 50 KB | Type: x] URL: https://api.kapso.ai/media/SECRETLINK`,
        media_url: "https://api.kapso.ai/media/SECRETLINK",
        media_data: { url: SIGNED, filename: type === "audio" ? "voice.ogg" : "photo.jpg", content_type: part.mime_type, byte_size: 51200 },
        ...(type === "audio" ? { transcript: { text: "مرحبا أريد تفاصيل الورشة" } } : {}),
      },
    },
    conversation: { id: "c1", contact_name: "Sara", phone_number: "15550000111", phone_number_id: "pnid-A" },
    phone_number_id: "pnid-A",
  };
}
const RECEIVED = "whatsapp.message.received";

test("kapso media: image / audio / sticker references - no URL of ours is exposed, text is the caption only", () => {
  const img = parseKapsoPayloadV2(mediaItem("image", { caption: "صورة المنتج" }), RECEIVED);
  const e = img.events[0] as KapsoInboundV2;
  assert.deepEqual(img.errors, []);
  assert.equal(e.body, "صورة المنتج", "the caption, never Kapso's generated description");
  assert.deepEqual(e.media, { provider: "kapso", kind: "image", id: "MEDIAID1", url: SIGNED, mime_type: "image/jpeg", filename: "photo.jpg", size: 51200 });

  const au = (parseKapsoPayloadV2(mediaItem("audio", { voice: true }), RECEIVED).events[0] as KapsoInboundV2);
  assert.equal(au.body, null, "a voice note has no text of its own");
  assert.equal(au.media?.voice, true);
  assert.equal(au.media?.transcript, "مرحبا أريد تفاصيل الورشة");
  assert.equal(au.media?.mime_type, "audio/ogg");

  const st = (parseKapsoPayloadV2(mediaItem("sticker", { animated: true }), RECEIVED).events[0] as KapsoInboundV2);
  assert.equal(st.body, null);
  assert.deepEqual([st.media?.kind, st.media?.animated, st.media?.mime_type], ["sticker", true, "image/webp"]);

  for (const ev of [e, au, st]) {
    const json = JSON.stringify(ev);
    assert.equal(json.includes("SECRETLINK"), false, "Kapso's generated 'URL: …' text never reaches the stored message");
    assert.equal(json.includes("attached"), false);
  }
});

test("kapso media: a media message without a usable id keeps the old behaviour (no media, old text fallback)", () => {
  const p = mediaItem("image");
  delete (p.message.image as Record<string, unknown>).id;
  const e = parseKapsoPayloadV2(p, RECEIVED).events[0] as KapsoInboundV2;
  assert.equal(e.media, null);
  const ph = mediaItem("image"); (ph.message as { type: string }).type = "media_placeholder";
  assert.equal((parseKapsoPayloadV2(ph, RECEIVED).events[0] as KapsoInboundV2).media, null);
  assert.equal(extractKapsoMedia({ type: "text", text: { body: "hi" } }), null);
  assert.equal(extractKapsoMedia({ type: "image", image: { id: "has space" } }), null);
  assert.equal(extractKapsoMedia({ type: "image", image: { id: "x".repeat(201) } }), null);
});

test("kapso media: only https hosts under kapso.ai are ever kept or requested", () => {
  for (const ok of ["https://api.kapso.ai/media/x", "https://app.kapso.ai/rails/x", "https://kapso.ai/x"]) assert.equal(isKapsoHost(ok), true, ok);
  for (const bad of ["http://api.kapso.ai/x", "https://evilkapso.ai/x", "https://kapso.ai.evil.com/x", "https://user:pw@api.kapso.ai/x", "https://169.254.169.254/x", "ftp://api.kapso.ai/x", "", null, undefined, "not a url"]) {
    assert.equal(isKapsoHost(bad as string), false, String(bad));
  }
  const p = mediaItem("image");
  (p.message.kapso as Record<string, unknown>).media_data = { url: "https://169.254.169.254/latest/meta-data", content_type: "image/jpeg", byte_size: 5 };
  (p.message.kapso as Record<string, unknown>).media_url = "http://evil.example/x";
  assert.equal((parseKapsoPayloadV2(p, RECEIVED).events[0] as KapsoInboundV2).media?.url, null, "an untrusted link is dropped; the media id still works");
});

test("kapso media: odd metadata is sanitised (mime, filename, size)", () => {
  const p = mediaItem("document", { filename: "../../etc/passwd\u0000.pdf" });
  (p.message.kapso as Record<string, unknown>).media_data = { url: SIGNED, filename: "a/b\\c\u0001.pdf", content_type: "application/pdf; charset=x", byte_size: -5 };
  const m = (parseKapsoPayloadV2(p, RECEIVED).events[0] as KapsoInboundV2).media!;
  assert.equal(m.filename, "a_b_c_.pdf");
  assert.equal(m.mime_type, "application/pdf");
  assert.equal(m.size, null);
  (p.message.kapso as Record<string, unknown>).media_data = { url: SIGNED, content_type: "<script>", byte_size: 1 };
  assert.equal((parseKapsoPayloadV2(p, RECEIVED).events[0] as KapsoInboundV2).media!.mime_type, null);
  assert.equal(mediaCaption({ type: "image", image: { caption: "c" } }), "c");
});

test("kapso media: auto-generated descriptions are recognised so old messages show the file, not the noise", () => {
  for (const d of ["Sticker attached (sticker_60c622aa2871.webp) 221.1 KB · WEBP", "[Audio attached] (voice.ogg) [Size: 50 KB | Type: audio/ogg]", "Image attached (photo.jpg)", "[image]", "[media_placeholder]", "  [sticker] "]) {
    assert.equal(isAutoMediaDescription(d), true, d);
  }
  for (const real of ["Hello", "صورة المنتج", "I attached the image you asked for", "", null, undefined, "Please see [image] below"]) assert.equal(isAutoMediaDescription(real as string), false, String(real));
});

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  const b = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  return new Response(b as BodyInit, { status, headers: typeof body === "string" || body instanceof Uint8Array ? headers : { "content-type": "application/json", ...headers } });
}
const bytes = (n: number) => new Uint8Array(n).fill(7);

test("kapso media fetch: documented path first (key only to api.kapso.ai), then the authenticated download link", async () => {
  const calls: Array<{ url: string; key: string | null }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, key: (init?.headers as Record<string, string> | undefined)?.["X-API-Key"] ?? null });
    if (url.startsWith(`${KAPSO_META_BASE}/MEDIAID1`)) return res(200, { download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=T", mime_type: "image/jpeg" });
    if (url.includes("media_download")) return res(200, bytes(1000), { "content-type": "image/jpeg" });
    return res(404, "no");
  }) as unknown as typeof fetch;
  const r = await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "1279070011960861", mediaId: "MEDIAID1", url: SIGNED, maxBytes: 5000, fetchImpl: f });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([r.bytes.byteLength, r.mimeType], [1000, "image/jpeg"]);
  assert.equal(calls[0].url, `${KAPSO_META_BASE}/MEDIAID1?phone_number_id=1279070011960861`);
  assert.equal(calls[0].key, KEY);
  assert.equal(calls[1].key, null, "the download link carries its own token: no key is sent");
  assert.equal(calls.length, 2, "the signed webhook link is not needed");
});

test("kapso media fetch: falls back to the signed link WITHOUT the key; never requests an untrusted host", async () => {
  const calls: Array<{ url: string; key: string | null }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, key: (init?.headers as Record<string, string> | undefined)?.["X-API-Key"] ?? null });
    if (url.startsWith(KAPSO_META_BASE)) return res(404, { error: "gone" });
    if (url === SIGNED) return res(200, bytes(300), { "content-type": "image/jpeg; charset=binary" });
    return res(500, "x");
  }) as unknown as typeof fetch;
  const ok = await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "pnid1", mediaId: "MEDIAID1", url: SIGNED, maxBytes: 5000, fetchImpl: f });
  assert.equal(ok.ok, true);
  assert.equal(calls.find((c) => c.url === SIGNED)!.key, null, "the signed link never receives the API key");

  const evil = await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "pnid1", mediaId: "MEDIAID1", url: "https://evil.example/x", maxBytes: 5000, fetchImpl: f });
  assert.deepEqual(evil, { ok: false, code: "untrusted_host" });
  assert.equal(calls.some((c) => c.url.includes("evil.example")), false);

  // a download_url pointing elsewhere is refused too
  const f2 = (async (url: string) => (url.startsWith(KAPSO_META_BASE) ? res(200, { download_url: "https://evil.example/steal" }) : res(500, "x"))) as unknown as typeof fetch;
  const r2 = await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "pnid1", mediaId: "MEDIAID1", maxBytes: 5000, fetchImpl: f2 });
  assert.equal(r2.ok, false);
});

test("kapso media fetch: size cap (declared and streamed), empty body, errors, no key", async () => {
  const mk = (len: number, declared = true) => (async (url: string) => (url.startsWith(KAPSO_META_BASE)
    ? res(200, { download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=T" })
    : res(200, bytes(len), declared ? { "content-type": "audio/ogg", "content-length": String(len) } : { "content-type": "audio/ogg" }))) as unknown as typeof fetch;
  assert.deepEqual(await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "pnid1", mediaId: "M1", maxBytes: 100, fetchImpl: mk(500) }), { ok: false, code: "too_large" });
  assert.deepEqual(await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "pnid1", mediaId: "M1", maxBytes: 100, fetchImpl: mk(500, false) }), { ok: false, code: "too_large" }, "no content-length: still capped while streaming");
  assert.deepEqual(await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "pnid1", mediaId: "M1", maxBytes: 100, fetchImpl: mk(0) }), { ok: false, code: "unavailable" });
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.deepEqual(await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "pnid1", mediaId: "M1", maxBytes: 100, fetchImpl: down }), { ok: false, code: "unavailable" });
  assert.deepEqual(await fetchKapsoMedia({ apiKey: "", phoneNumberId: "pnid1", mediaId: "M1", maxBytes: 100, fetchImpl: down }), { ok: false, code: "not_configured" });
  const weird = (async (url: string) => (url.startsWith(KAPSO_META_BASE) ? res(200, { download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=T" }) : res(200, bytes(10), { "content-type": "<x>" }))) as unknown as typeof fetch;
  const r = await fetchKapsoMedia({ apiKey: KEY, phoneNumberId: "pnid1", mediaId: "M1", maxBytes: 100, fetchImpl: weird });
  assert.equal(r.ok && r.mimeType, "application/octet-stream", "a malformed content-type becomes an opaque download");
});

/** Minimal in-memory store, as in the other v2 tests. */
class Store implements KapsoStoreV2 {
  events = new Map<string, { status: string; payload: unknown }>();
  inbound: KapsoInboundV2[] = []; statuses: KapsoStatusV2[] = [];
  async claimEvent(e: { eventKey: string; payload: unknown }): Promise<ClaimResult> { const x = this.events.get(e.eventKey); if (x?.status === "processed") return "duplicate"; this.events.set(e.eventKey, { status: "pending", payload: e.payload }); return x ? "retry" : "new"; }
  async finishEvent(k: string, s: "processed" | "failed" | "ignored") { const x = this.events.get(k)!; if (x.status === "processed") return "already_final" as const; x.status = s; return "finished" as const; }
  async recordHeld(e: HeldRecord) { this.events.set(e.eventKey, { status: e.status, payload: e.payload }); return "recorded" as const; }
  async accountClass(): Promise<KapsoAccountClass> { return "production"; }
  async ingestInbound(e: KapsoInboundV2) { this.inbound.push(e); return { duplicate: false }; }
  async applyStatus(e: KapsoStatusV2) { this.statuses.push(e); return true; }
  async touchAccount() {}
}
const post = (payload: unknown, event: string) => { const raw = enc(JSON.stringify(payload)); return { rawBody: raw, signature: sign(raw), eventName: event, payloadVersion: "v2" }; };

test("kapso media pipeline: the file reference reaches the store and the retry payload; the prefetch hook fires once per processed media message", async () => {
  const s = new Store(); const seen: string[] = [];
  const opts = { onMedia: (id: string) => { seen.push(id); } };
  const a = await handleKapsoPostV2(post(mediaItem("image", { caption: "c" }, "wamid.PM1"), RECEIVED), "unit-test-secret-0123456789", s, opts);
  assert.deepEqual([a.processed, seen], [1, ["wamid.PM1"]]);
  assert.equal(s.inbound[0].media?.id, "MEDIAID1");
  const dup = await handleKapsoPostV2(post(mediaItem("image", { caption: "c" }, "wamid.PM1"), RECEIVED), "unit-test-secret-0123456789", s, opts);
  assert.deepEqual([dup.duplicates, seen.length], [1, 1], "a duplicate delivery schedules nothing");
  const out = mediaItem("audio", {}, "wamid.PM2");   // a voice note sent from the Business App (echo): outbound shape
  (out.message.kapso as Record<string, unknown>).direction = "outbound"; (out.message.kapso as Record<string, unknown>).origin = "business_app";
  await handleKapsoPostV2(post({ ...out, message: { ...out.message, to: "15550000111", from: undefined } }, "whatsapp.message.sent"), "unit-test-secret-0123456789", s, opts);
  const text = await handleKapsoPostV2(post({ ...mediaItem("image"), message: { id: "wamid.TX", timestamp: "1790000000", type: "text", text: { body: "hi" }, from: "15550000111", kapso: { direction: "inbound" } } }, RECEIVED), "unit-test-secret-0123456789", s, opts);
  assert.equal(text.processed, 1);
  assert.deepEqual(seen, ["wamid.PM1", "wamid.PM2"], "no hook for a text message");
  const bad = await handleKapsoPostV2(post(mediaItem("image", {}, "wamid.PM3"), RECEIVED), "unit-test-secret-0123456789", s, { onMedia: () => { throw new Error("boom"); } });
  assert.deepEqual([bad.httpStatus, bad.processed], [200, 1], "a failing hook never changes the webhook answer");

  const ser = serializeKapsoEventV2(s.inbound[0]);
  assert.equal((ser.media as { id: string }).id, "MEDIAID1", "the retry payload keeps the media (process_webhook_retries reads p->'media')");
  const plain = serializeKapsoEventV2(s.inbound[1] ?? s.inbound[0]);
  assert.ok("media" in plain);
});

test("kapso media store mapping: p_media carries the reference (inbound and echo)", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const st = createKapsoStoreV2({ rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "ingest_kapso_inbound" ? [{ o_duplicate: false }] : true, error: null }; } });
  const inb = parseKapsoPayloadV2(mediaItem("image", { caption: "c" }), RECEIVED).events[0] as KapsoInboundV2;
  await st.ingestInbound(inb);
  assert.equal((calls[0].args.p_media as { kind: string }).kind, "image");
  const echo = mediaItem("image", {}, "wamid.ECHO"); (echo.message.kapso as Record<string, unknown>).direction = "outbound"; (echo.message.kapso as Record<string, unknown>).origin = "business_app";
  const sent = parseKapsoPayloadV2({ ...echo, message: { ...echo.message, to: "15550000111", from: undefined } }, "whatsapp.message.sent").events[0] as KapsoStatusV2;
  await st.applyStatus(sent);
  assert.equal((calls[1].args.p_media as { id: string }).id, "MEDIAID1");
  const text = parseKapsoPayloadV2({ message: { id: "wamid.T", timestamp: "1790000000", type: "text", text: { body: "x" }, from: "15550000111", kapso: { direction: "inbound" } }, phone_number_id: "pnid-A", conversation: {} }, RECEIVED).events[0] as KapsoInboundV2;
  await st.ingestInbound(text);
  assert.equal(calls[2].args.p_media, null, "text messages send null");
});

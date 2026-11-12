import { test } from "node:test";
import assert from "node:assert/strict";
import { isOggOpus, opusPacketSamples, readWebmOpus, webmOpusToOgg } from "../../src/lib/audio/ogg-opus.ts";
import { KAPSO_SEND_BASE, sendKapsoMedia, uploadKapsoMedia } from "../../src/lib/kapso/send.ts";

// ---- a tiny WebM writer (EBML) shaped like what Chrome's MediaRecorder produces: unknown-size Segment and Cluster
const vint = (n: number) => (n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff]);
const el = (id: number[], body: number[] | Uint8Array) => [...id, ...vint(body.length), ...body];
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const opusHead = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0, 0, 0];   // pre-skip 312, 48 kHz
function webm(packets: number[][]): Uint8Array {
  const track = el([0xae], [...el([0xd7], [1]), ...el([0x83], [2]), ...el([0x86], [...Buffer.from("A_OPUS")]), ...el([0x63, 0xa2], opusHead)]);
  const blocks = packets.flatMap((p) => el([0xa3], [0x81, 0, 0, 0x80, ...p]));
  const cluster = [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN, ...el([0xe7], [0]), ...blocks];
  return Uint8Array.from([
    ...el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [...Buffer.from("webm")])),
    0x18, 0x53, 0x80, 0x67, ...UNKNOWN,
    ...el([0x16, 0x54, 0xae, 0x6b], track),
    ...cluster,
  ]);
}
// TOC 0x78 = hybrid 20 ms, code 0 (one frame, 960 samples)
const pkt = (n: number, fill: number) => [0x78, ...new Array(n).fill(fill)];

function pages(b: Uint8Array) {
  const out: { flags: number; granule: number; seq: number; packets: Uint8Array[]; crcOk: boolean }[] = [];
  let at = 0;
  while (at < b.length) {
    assert.equal(String.fromCharCode(...b.subarray(at, at + 4)), "OggS");
    const dv = new DataView(b.buffer, b.byteOffset + at);
    const nseg = b[at + 26];
    const lacing = [...b.subarray(at + 27, at + 27 + nseg)];
    const size = 27 + nseg + lacing.reduce((s, x) => s + x, 0);
    const copy = b.slice(at, at + size);
    const stored = new DataView(copy.buffer).getUint32(22, true);
    new DataView(copy.buffer).setUint32(22, 0, true);
    let c = 0;
    for (const x of copy) { c ^= x << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; }
    const packets: Uint8Array[] = []; let p = at + 27 + nseg, cur = 0;
    for (const l of lacing) { cur += l; if (l < 255) { packets.push(b.slice(p, p + cur)); p += cur; cur = 0; } }
    out.push({ flags: b[at + 5], granule: dv.getUint32(6, true) + dv.getUint32(10, true) * 2 ** 32, seq: dv.getUint32(18, true), packets, crcOk: (c >>> 0) === stored });
    at += size;
  }
  return out;
}

test("ogg-opus: reads the Opus header and packets out of a WebM with unknown-size segment and cluster", () => {
  const s = readWebmOpus(webm([pkt(10, 1), pkt(20, 2), pkt(30, 3)]));
  assert.equal(s.packets.length, 3);
  assert.deepEqual([...s.packets[1]], pkt(20, 2));
  assert.equal(String.fromCharCode(...s.head.subarray(0, 8)), "OpusHead");
});

test("ogg-opus: the OGG output is valid - header pages first, correct checksums, packets intact, granule counts samples after the pre-skip", () => {
  const input = Array.from({ length: 120 }, (_, i) => pkt(5 + (i % 7) * 60, i % 250));   // some > 255 bytes (multi-segment lacing)
  const ogg = webmOpusToOgg(webm(input));
  assert.equal(isOggOpus(ogg), true);
  const ps = pages(ogg);
  assert.equal(ps.every((p) => p.crcOk), true, "every page checksum matches");
  assert.equal(ps[0].flags, 0x02); assert.equal(ps[0].granule, 0);
  assert.equal(String.fromCharCode(...ps[1].packets[0].subarray(0, 8)), "OpusTags");
  assert.equal(ps.at(-1)!.flags & 0x04, 0x04, "last page is flagged end-of-stream");
  assert.deepEqual(ps.map((p) => p.seq), ps.map((_, i) => i));
  const audio = ps.slice(2).flatMap((p) => p.packets);
  assert.equal(audio.length, 120);
  audio.forEach((a, i) => assert.deepEqual([...a], input[i]));
  assert.equal(ps.at(-1)!.granule, 312 + 120 * 960);
});

test("ogg-opus: packet durations come from the TOC byte", () => {
  assert.equal(opusPacketSamples(Uint8Array.from([0x78])), 960);          // 20 ms, 1 frame
  assert.equal(opusPacketSamples(Uint8Array.from([0x79])), 1920);         // 2 frames
  assert.equal(opusPacketSamples(Uint8Array.from([0x7b, 3])), 2880);      // code 3, 3 frames
  assert.equal(opusPacketSamples(Uint8Array.from([0xf8])), 960);          // CELT 20 ms
  assert.equal(opusPacketSamples(Uint8Array.from([0x00])), 480);          // SILK 10 ms
});

test("ogg-opus: garbage is refused, and a non-Opus OGG is not accepted as a voice note", () => {
  assert.throws(() => webmOpusToOgg(Uint8Array.from([1, 2, 3, 4, 5])));
  assert.equal(isOggOpus(Uint8Array.from([1, 2, 3])), false);
  const vorbis = new Uint8Array(80); vorbis.set([0x4f, 0x67, 0x67, 0x53]); vorbis.set([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 28);
  assert.equal(isOggOpus(vorbis), false);
});

// ---- Kapso media sending
const KEY = "unit-test-kapso-api-key-0123456789"; // throwaway
const PN = "1279070011960861";

test("kapso media: upload is a multipart POST to /media with the API key and nothing in the URL", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ id: "MEDIA123" }), { status: 200 }); }) as unknown as typeof fetch;
  const r = await uploadKapsoMedia({ phoneNumberId: PN, apiKey: KEY, bytes: Uint8Array.from([1, 2, 3]), mimeType: "audio/ogg", filename: "voice.ogg", fetchImpl: f });
  assert.deepEqual(r, { ok: true, mediaId: "MEDIA123" });
  assert.equal(seen!.url, `${KAPSO_SEND_BASE}/${PN}/media`);
  assert.equal((seen!.init.headers as Record<string, string>)["X-API-Key"], KEY);
  const form = seen!.init.body as FormData;
  assert.equal(form.get("messaging_product"), "whatsapp");
  assert.equal((form.get("file") as File).name, "voice.ogg");
});

test("kapso media: every upload failure, a timeout included, is a definite 'not sent' (an upload never reaches the customer)", async () => {
  const boom = (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
  const a = await uploadKapsoMedia({ phoneNumberId: PN, apiKey: KEY, bytes: Uint8Array.from([1]), mimeType: "image/png", filename: "a.png", fetchImpl: boom });
  assert.equal(a.ok, false); assert.equal((a as { code: string }).code, "timeout");
  const e = (async () => new Response(JSON.stringify({ error: { message: "bad", code: 131053 } }), { status: 400 })) as unknown as typeof fetch;
  const b = await uploadKapsoMedia({ phoneNumberId: PN, apiKey: KEY, bytes: Uint8Array.from([1]), mimeType: "image/png", filename: "a.png", fetchImpl: e });
  assert.equal(b.ok, false); assert.equal((b as { code: string }).code, "131053");
  const none = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  assert.equal((await uploadKapsoMedia({ phoneNumberId: PN, apiKey: KEY, bytes: Uint8Array.from([1]), mimeType: "image/png", filename: "a.png", fetchImpl: none })).ok, false);
  assert.equal((await uploadKapsoMedia({ phoneNumberId: PN, apiKey: KEY, bytes: new Uint8Array(0), mimeType: "image/png", filename: "a.png", fetchImpl: none })).ok, false);
});

test("kapso media: message shapes - image caption, document filename + caption, voice note flag, no caption on audio", async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const o = { phoneNumberId: PN, apiKey: KEY, toWaId: "201000000001", mediaId: "M1", fetchImpl: f };
  assert.equal((await sendKapsoMedia({ ...o, kind: "image", caption: "hi" })).ok, true);
  assert.equal((await sendKapsoMedia({ ...o, kind: "document", caption: "doc", filename: "a.pdf" })).ok, true);
  assert.equal((await sendKapsoMedia({ ...o, kind: "audio", caption: "ignored", voice: true })).ok, true);
  assert.equal((await sendKapsoMedia({ ...o, kind: "audio" })).ok, true);
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: "201000000001" };
  assert.deepEqual(bodies[0], { ...base, type: "image", image: { id: "M1", caption: "hi" } });
  assert.deepEqual(bodies[1], { ...base, type: "document", document: { id: "M1", caption: "doc", filename: "a.pdf" } });
  assert.deepEqual(bodies[2], { ...base, type: "audio", audio: { id: "M1", voice: true } });
  assert.deepEqual(bodies[3], { ...base, type: "audio", audio: { id: "M1" } });
});

test("kapso media: a timeout or 5xx while sending is unconfirmed (never resent), a 4xx is a refusal; bad input never reaches the network", async () => {
  const o = { phoneNumberId: PN, apiKey: KEY, toWaId: "201000000001", mediaId: "M1", kind: "image" as const };
  const s500 = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
  const r1 = await sendKapsoMedia({ ...o, fetchImpl: s500 });
  assert.equal(r1.ok, false); assert.equal((r1 as { kind: string }).kind, "unconfirmed");
  const s422 = (async () => new Response(JSON.stringify({ error: "x", code: "outside_window" }), { status: 422 })) as unknown as typeof fetch;
  const r2 = await sendKapsoMedia({ ...o, fetchImpl: s422 });
  assert.equal((r2 as { kind: string }).kind, "definite");
  let calls = 0; const never = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
  for (const bad of [{ toWaId: "" }, { toWaId: "+20100" }, { mediaId: "../x" }, { phoneNumberId: "../x" }, { apiKey: "short" }]) {
    assert.equal((await sendKapsoMedia({ ...o, ...bad, fetchImpl: never })).ok, false);
  }
  assert.equal(calls, 0);
});

test("kapso media: a BSUID-only customer is addressed with `recipient`, a phone always wins", async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const o = { phoneNumberId: PN, apiKey: KEY, mediaId: "M1", kind: "image" as const, fetchImpl: f };
  assert.equal((await sendKapsoMedia({ ...o, toBsuid: "QA.13491208655302741918" })).ok, true);
  assert.equal(bodies[0].recipient, "QA.13491208655302741918"); assert.equal("to" in bodies[0], false);
  await sendKapsoMedia({ ...o, toWaId: "201000000001", toBsuid: "QA.13491208655302741918" });
  assert.equal(bodies[1].to, "201000000001"); assert.equal("recipient" in bodies[1], false);
  assert.equal((await sendKapsoMedia({ ...o, toBsuid: "a b" })).ok, false);
  assert.equal((await sendKapsoMedia({ ...o })).ok, false);
});

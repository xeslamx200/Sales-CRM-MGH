/**
 * Voice notes for WhatsApp must be OGG/Opus. Chrome and Edge record WebM/Opus: the very same Opus packets in another container, so no
 * re-encoding is needed, only a repack (webmOpusToOgg). Pure functions on bytes: they run in the browser (before upload) and in tests.
 */

const textOf = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** True when the bytes are an Ogg stream whose first packet is an Opus header. */
export function isOggOpus(b: Uint8Array): boolean {
  return b.length > 47 && textOf(b, 0, 4) === "OggS" && textOf(b, 28, 8) === "OpusHead";
}

// ---------------------------------------------------------------------------------------------------------------- WebM reading
const MASTER = new Set([0x18538067, 0x1f43b675, 0x1654ae6b, 0xae, 0xa0]);   // Segment, Cluster, Tracks, TrackEntry, BlockGroup
const ID_CODEC_PRIVATE = 0x63a2, ID_SIMPLE_BLOCK = 0xa3, ID_BLOCK = 0xa1, ID_CODEC_ID = 0x86, ID_TRACK_NUMBER = 0xd7, ID_TRACK_TYPE = 0x83;

function readId(b: Uint8Array, at: number): { id: number; len: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;   // 1..4 leading-zero based length
  if (len < 1 || len > 4 || at + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[at + i];
  return { id, len };
}
function readSize(b: Uint8Array, at: number): { size: number; len: number; unknown: boolean } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len < 1 || len > 8 || at + len > b.length) return null;
  let v = first & (0xff >> len);
  let allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[at + i]; if (b[at + i] !== 0xff) allOnes = false; }
  return { size: v, len, unknown: allOnes };
}

export type OpusStream = { head: Uint8Array; packets: Uint8Array[] };

/** The Opus header (CodecPrivate) and the Opus packets of the first audio track of a WebM file. */
export function readWebmOpus(b: Uint8Array): OpusStream {
  let head: Uint8Array | null = null;
  const packets: Uint8Array[] = [];
  let opusTrack = -1;
  let entryTrack = -1, entryIsOpus = false, entryHead: Uint8Array | null = null;
  const closeEntry = () => { if (entryIsOpus && opusTrack < 0) { opusTrack = entryTrack; head = entryHead; } entryTrack = -1; entryIsOpus = false; entryHead = null; };
  let at = 0;
  while (at < b.length) {
    const id = readId(b, at);
    if (!id) break;
    const sz = readSize(b, at + id.len);
    if (!sz) break;
    const body = at + id.len + sz.len;
    if (id.id === 0xae) closeEntry();   // a new TrackEntry starts: finish the previous one
    if (MASTER.has(id.id)) { at = body; continue; }   // descend (also for unknown-size live streams)
    const end = sz.unknown ? b.length : Math.min(b.length, body + sz.size);
    if (id.id === ID_CODEC_ID) entryIsOpus = textOf(b, body, end - body) === "A_OPUS";
    else if (id.id === ID_TRACK_NUMBER) { let n = 0; for (let i = body; i < end; i++) n = n * 256 + b[i]; entryTrack = n; }
    else if (id.id === ID_TRACK_TYPE) { /* audio is identified by the codec */ }
    else if (id.id === ID_CODEC_PRIVATE) entryHead = b.slice(body, end);
    else if (id.id === ID_SIMPLE_BLOCK || id.id === ID_BLOCK) {
      closeEntry();
      const tn = readSize(b, body);   // the track number is a vint
      if (tn && (opusTrack < 0 || tn.size === opusTrack)) {
        const flags = b[body + tn.len + 2];
        if ((flags & 0x06) !== 0) throw new Error("laced WebM blocks are not supported");
        packets.push(b.slice(body + tn.len + 3, end));
      }
    }
    at = end;
  }
  closeEntry();
  if (packets.length === 0) throw new Error("no Opus audio found in the WebM file");
  return { head: head ?? defaultHead(), packets };
}

function defaultHead(): Uint8Array {
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1, 0x38, 0x01]);   // "OpusHead", v1, mono, pre-skip 312
  new DataView(h.buffer).setUint32(12, 48000, true);
  return h;
}

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte. */
export function opusPacketSamples(p: Uint8Array): number {
  if (p.length === 0) return 0;
  const toc = p[0], config = toc >> 3, code = toc & 3;
  const frameMs = config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
  const frames = code === 0 ? 1 : code === 3 ? (p[1] ?? 1) & 0x3f : 2;
  return Math.round((frameMs * 48 * frames));
}

// ---------------------------------------------------------------------------------------------------------------- Ogg writing
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; }
  return t;
})();
function crc(b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

function page(packets: Uint8Array[], o: { flags: number; granule: number; serial: number; seq: number }): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
  const dataLen = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + dataLen);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53, 0, o.flags]);   // "OggS", version 0
  dv.setUint32(6, o.granule % 2 ** 32, true);
  dv.setUint32(10, Math.floor(o.granule / 2 ** 32), true);
  dv.setUint32(14, o.serial, true);
  dv.setUint32(18, o.seq, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) { out.set(p, at); at += p.length; }
  dv.setUint32(22, crc(out), true);
  return out;
}

/** Repack the Opus packets of a WebM recording as an OGG/Opus file (no re-encoding). */
export function webmOpusToOgg(webm: Uint8Array): Uint8Array {
  const { head, packets } = readWebmOpus(webm);
  const preSkip = head.length >= 12 && textOf(head, 0, 8) === "OpusHead" ? new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true) : 312;
  const serial = Math.floor(Math.random() * 2 ** 32) >>> 0;
  const vendor = new TextEncoder().encode("crm");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const chunks: Uint8Array[] = [
    page([head], { flags: 0x02, granule: 0, serial, seq: 0 }),
    page([tags], { flags: 0, granule: 0, serial, seq: 1 }),
  ];
  let seq = 2, samples = 0, group: Uint8Array[] = [], segs = 0;
  const flush = (last: boolean) => {
    if (group.length === 0 && !last) return;
    chunks.push(page(group, { flags: last ? 0x04 : 0, granule: preSkip + samples, serial, seq: seq++ }));
    group = []; segs = 0;
  };
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    const need = Math.floor(p.length / 255) + 1;
    if (segs + need > 240) flush(false);
    group.push(p); segs += need; samples += opusPacketSamples(p);
    if (group.length >= 50 && i < packets.length - 1) flush(false);
  }
  flush(true);
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

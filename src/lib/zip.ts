/**
 * A tiny reader for the .zip that "Export chat" makes on an iPhone (and on Android when media is included): finds the chat's .txt file and returns its
 * text. Browser only (it uses DecompressionStream for the "deflate" method); everything else in the zip, photos and voice notes included, is ignored.
 */
const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);

export async function readZipText(buffer: ArrayBuffer): Promise<{ name: string; text: string } | null> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // end of central directory record: signature 0x06054b50, within the last 64 KB
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 65535); i--) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = u16(view, eocd + 10);
  let p = u32(view, eocd + 16);
  const found: { name: string; method: number; size: number; offset: number }[] = [];
  for (let n = 0; n < count && p + 46 <= buffer.byteLength; n++) {
    if (u32(view, p) !== 0x02014b50) break;
    const method = u16(view, p + 10), size = u32(view, p + 20), nameLen = u16(view, p + 28), extra = u16(view, p + 30), comment = u16(view, p + 32), offset = u32(view, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (/\.txt$/i.test(name) && !name.startsWith("__MACOSX")) found.push({ name, method, size, offset });
    p += 46 + nameLen + extra + comment;
  }
  const pick = found.find((f) => /(^|\/)_chat\.txt$/i.test(f.name)) ?? found.sort((a, b) => b.size - a.size)[0];
  if (!pick) return null;
  if (u32(view, pick.offset) !== 0x04034b50) return null;
  const start = pick.offset + 30 + u16(view, pick.offset + 26) + u16(view, pick.offset + 28);
  const data = bytes.subarray(start, start + pick.size);
  let raw: Uint8Array;
  if (pick.method === 0) raw = data;
  else if (pick.method === 8) {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } else return null;
  return { name: pick.name, text: new TextDecoder("utf-8").decode(raw) };
}

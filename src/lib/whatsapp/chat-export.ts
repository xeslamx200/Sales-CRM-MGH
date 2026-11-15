/**
 * Reads the text file WhatsApp makes with "Export chat" (Android: "DD/MM/YYYY, HH:MM - Name: text"; iPhone: "[DD/MM/YYYY, HH:MM:SS] Name: text";
 * 12-hour clocks with AM/PM or ص/م, Arabic-Indic digits, two-digit years, messages that continue on the next lines).
 * Pure functions (no I/O): the browser uses them for the preview, the server rebuilds the rows it stores.
 */

export type ExportMessage = {
  sender: string;
  /** Local time as written in the export, "YYYY-MM-DDTHH:MM:SS" (the phone's clock: the caller says which time zone it was). */
  local: string;
  text: string;
  /** The export only says a photo / voice note / file was there ("<Media omitted>"): the file itself is not in a text export. */
  media: boolean;
};
export type DateOrder = "dmy" | "mdy";
export type ParsedExport = { messages: ExportMessage[]; senders: string[]; order: DateOrder; orderCertain: boolean; skipped: number };

const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const SPACES = /[  ]/g;

function digits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
export function clean(line: string): string {
  return digits(line.replace(INVISIBLE, "").replace(SPACES, " "));
}

const DATE = String.raw`(\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4})`;
const TIME = String.raw`(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)\s*([AaPp]\.?\s?[Mm]\.?|ص|م)?`;
const ANDROID = new RegExp(String.raw`^${DATE},?\s+${TIME}\s+[-–—]\s+(.*)$`);
const IOS = new RegExp(String.raw`^\[${DATE},?\s+${TIME}\]\s+(.*)$`);

const MEDIA = /(<media omitted>|<attached:|(image|video|audio|sticker|document|gif|contact card|voice call|video call)\s+omitted|\(file attached\)|^‎?\w[\w .-]*\.(jpe?g|png|webp|mp4|opus|ogg|pdf|vcf)\b|تم استبعاد|<مرفق|الوسائط المحذوفة|صورة محذوفة)/i;

type Raw = { a: number; b: number; y: number; time: string; ampm: string | undefined; rest: string; first: string };

function splitHeader(line: string): Raw | null {
  const m = ANDROID.exec(line) ?? IOS.exec(line);
  if (!m) return null;
  const parts = m[1].split(/[/.\-]/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  // a 4-digit first part is a year (YYYY-MM-DD): treat as y, m, d by putting them in the (a=day, b=month) slots of "ymd"
  const ymd = m[1].split(/[/.\-]/)[0].length === 4;
  return { a: ymd ? parts[2] : parts[0], b: parts[1], y: ymd ? parts[0] : parts[2], time: m[2], ampm: m[3], rest: m[4], first: m[1] };
}

function build(r: Raw, order: DateOrder): string | null {
  let day = order === "dmy" ? r.a : r.b;
  let month = order === "dmy" ? r.b : r.a;
  if (/^\d{4}/.test(r.first)) { day = r.a; month = r.b; }   // YYYY-MM-DD never depends on the order
  const year = r.y < 100 ? 2000 + r.y : r.y;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const t = r.time.split(/[:.]/).map(Number);
  let h = t[0];
  const min = t[1], sec = t[2] ?? 0;
  if (r.ampm) {
    const pm = /^(p|م)/i.test(r.ampm.trim());
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || min > 59 || sec > 59) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p(month)}-${p(day)}T${p(h)}:${p(min)}:${p(sec)}`;
}

/** Day-first or month-first: decided by the dates themselves (a first number above 12 can only be a day); without proof, day-first. */
function detectOrder(raws: Raw[]): { order: DateOrder; certain: boolean } {
  let dmy = false, mdy = false;
  for (const r of raws) {
    if (/^\d{4}/.test(r.first)) continue;
    if (r.a > 12) dmy = true;
    if (r.b > 12) mdy = true;
  }
  if (dmy && !mdy) return { order: "dmy", certain: true };
  if (mdy && !dmy) return { order: "mdy", certain: true };
  return { order: "dmy", certain: false };
}

export function parseChatExport(text: string, opts: { order?: DateOrder } = {}): ParsedExport {
  const raws: Raw[] = [];
  const blocks: { raw: Raw; lines: string[] }[] = [];
  let skipped = 0;
  for (const original of text.split(/\r?\n/)) {
    const line = clean(original);
    const h = splitHeader(line);
    if (h) {
      raws.push(h);
      blocks.push({ raw: h, lines: [h.rest] });
    } else if (blocks.length > 0 && line.trim() !== "") {
      blocks[blocks.length - 1].lines.push(line);   // a message that continues on the next line
    }
  }
  const detected = detectOrder(raws);
  const order = opts.order ?? detected.order;
  const messages: ExportMessage[] = [];
  for (const b of blocks) {
    const first = b.lines[0];
    const cut = first.indexOf(": ");
    if (cut <= 0 || cut > 120) { skipped++; continue; }   // "Messages are end-to-end encrypted", "X joined", "You changed the subject": not a message
    const local = build(b.raw, order);
    if (!local) { skipped++; continue; }
    const sender = first.slice(0, cut).trim();
    const body = [first.slice(cut + 2), ...b.lines.slice(1)].join("\n").trim();
    const media = MEDIA.test(body) && body.length < 120;
    if (!media && body === "") { skipped++; continue; }
    messages.push({ sender, local, text: media ? "" : body, media });
  }
  const senders = [...new Set(messages.map((m) => m.sender))];
  return { messages, senders, order, orderCertain: opts.order ? true : detected.certain, skipped };
}

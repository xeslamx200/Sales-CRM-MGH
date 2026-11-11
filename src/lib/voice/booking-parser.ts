/**
 * Turns what an employee SAID (already transcribed to text by the browser) into the fields of the booking form.
 * Pure functions, no network and no AI: every recognised value is matched against the real lists (workshops, groups, countries) or taken from key words
 * such as "discount", "paid" or "note". Whatever is not understood is left empty; the employee always reviews the form and saves it herself.
 */

export type CountryEntry = { code: string; ar: string; en: string };
export type WorkshopEntry = { id: string; name: string };
export type GroupEntry = { id: string; name: string; sessions: string[] };

export type GroupHint = { text: string; number: number | null; date: { day: number; month: number } | null; tokens: string[] };

export type SpeechBooking = {
  transcript: string;
  customerName: string | null;
  phone: string | null;
  workshopId: string | null;
  workshopAmbiguous: boolean;
  workshopText: string | null;
  group: GroupHint | null;
  country: string | null;
  attendance: "online" | "offline" | null;
  discount: { type: "percent" | "fixed"; value: number; assumedPercent: boolean } | null;
  discountReason: string | null;
  paidNow: number | null;
  paidFull: boolean;
  note: string | null;
};

// ------------------------------------------------------------------------------------------------------------------------------ normalisation
/** Arabic text in a comparable form: no diacritics, one form of alef / yaa / taa marbuta, ASCII digits, no punctuation. */
export function normalizeAr(input: string): string {
  return input.toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/(\d)[,،٬](\d{3})/g, "$1$2")
    .replace(/٪/g, "%")
    .replace(/[^\p{L}\p{N}%+\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

type Tok = { raw: string; norm: string };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const raw of text.replace(/[،,;؛.!?؟]/g, " ").split(/\s+/)) {
    if (!raw) continue;
    const norm = normalizeAr(raw);
    if (norm) out.push({ raw, norm });
  }
  return out;
}

/** Without the common one-letter / "al" prefixes, so "للاعمال" and "الاعمال" compare equal. */
function stem(t: string): string {
  let s = t;
  for (const p of ["وال", "بال", "لل", "ال"]) if (s.startsWith(p) && s.length > p.length + 1) { s = s.slice(p.length); break; }
  return s;
}

// ------------------------------------------------------------------------------------------------------------------------------ spoken numbers
const UNITS: Record<string, number> = {
  صفر: 0, واحد: 1, واحده: 1, احد: 1, اتنين: 2, اثنين: 2, اثنان: 2, اثنتين: 2, اثنا: 2, تلاته: 3, ثلاثه: 3, تلات: 3, ثلاث: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5,
  سته: 6, ست: 6, سبعه: 7, سبع: 7, تمانيه: 8, ثمانيه: 8, تمان: 8, ثمان: 8, تسعه: 9, تسع: 9, عشره: 10, عشر: 10,
  حداشر: 11, احدعشر: 11, اتناشر: 12, اثناعشر: 12, تلتاشر: 13, ثلاثةعشر: 13, اربعتاشر: 14, خمستاشر: 15, ستاشر: 16, سبعتاشر: 17, تمنتاشر: 18, تسعتاشر: 19,
  عشرين: 20, عشرون: 20, ثلاثين: 30, تلاتين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تمانين: 80, تسعين: 90,
};
const HUNDRED_BASES: Record<string, number> = { ثلاث: 3, تلات: 3, تلت: 3, اربع: 4, ربع: 4, خمس: 5, ست: 6, سبع: 7, تمن: 8, ثمان: 8, تمان: 8, تسع: 9 };
const HUNDRED_SUFFIXES = ["ميه", "مايه", "مائه", "ميت", "مئه"];
const HUNDREDS: Record<string, number> = { ميه: 100, مايه: 100, مائه: 100, ميت: 100, مئه: 100, ميتين: 200, مائتين: 200, مئتين: 200, ميتان: 200 };
for (const [b, n] of Object.entries(HUNDRED_BASES)) for (const s of HUNDRED_SUFFIXES) HUNDREDS[b + s] = n * 100;
const THOUSANDS = new Set(["الف", "الاف", "ألف"]);
const CURRENCY_WORDS = new Set(["ريال", "ريالات", "جنيه", "جنيها", "دولار", "درهم", "دينار", "qar", "sar", "egp", "usd", "aed", "kwd", "bhd", "omr", "ر.ق", "ر.س"]);
const PERCENT_WORDS = new Set(["%", "بالميه", "بالمايه", "فالميه", "فالمايه", "percent", "بالمئه"]);

function wordValue(t: string): number | null {
  if (t in UNITS) return UNITS[t];
  if (t in HUNDREDS) return HUNDREDS[t];
  return null;
}

/** A number starting at tokens[start]: digits ("500", "٥٠٠", "10%") or words ("خمسمية", "ألفين وخمسمية"). */
export function readNumber(tokens: Tok[], start: number): { value: number; next: number; percent: boolean; currency: boolean } | null {
  let i = start;
  const first = tokens[i]?.norm;
  if (first === undefined) return null;
  const dm = /^(\d+(?:\.\d+)?)(%?)$/.exec(first);
  let total = 0;
  let current = 0;
  let consumed = 0;
  let percent = false;
  if (dm) {
    current = Number(dm[1]); percent = dm[2] === "%"; i++; consumed++;
    if (!percent && tokens[i] && THOUSANDS.has(tokens[i].norm)) { current *= 1000; i++; }
  } else {
    while (i < tokens.length) {
      let t = tokens[i].norm;
      let v = wordValue(t);
      if (v === null && t.startsWith("و") && t.length > 2) { t = t.slice(1); v = wordValue(t); }
      if (t === "و" && consumed > 0 && i + 1 < tokens.length) {
        const nx = tokens[i + 1].norm; const nv = wordValue(nx.startsWith("و") ? nx.slice(1) : nx);
        if (nv !== null || THOUSANDS.has(nx)) { i++; continue; }
        break;
      }
      if (t === "الفين" || t === "الفان") { total += 2000 + current * 0; current = 0; i++; consumed++; continue; }
      if (THOUSANDS.has(t) || (t.startsWith("و") && THOUSANDS.has(t.slice(1)))) { total += (current || 1) * 1000; current = 0; i++; consumed++; continue; }
      if (v === null) break;
      current += v; i++; consumed++;
    }
    if (consumed === 0) return null;
  }
  const value = total + current;
  if (!percent && tokens[i] && PERCENT_WORDS.has(tokens[i].norm)) { percent = true; i++; }
  else if (!percent && tokens[i]?.norm === "في" && tokens[i + 1] && /^(الميه|المايه|المئه)$/.test(tokens[i + 1].norm)) { percent = true; i += 2; }
  let currency = false;
  if (tokens[i] && CURRENCY_WORDS.has(tokens[i].norm)) { currency = true; i++; }
  return { value, next: i, percent, currency };
}

// ------------------------------------------------------------------------------------------------------------------------------ key words
type Field = "customer" | "phone" | "workshop" | "group" | "country" | "discount" | "reason" | "paid" | "note";
const KEYWORDS: Record<Field, string[]> = {
  customer: ["عميل", "العميل", "للعميل", "العميله", "للعميله", "باسم", "اسمه", "اسمها", "الاسم", "زبون", "الزبون", "للزبون", "customer", "client"],
  phone: ["رقم", "رقمه", "رقمها", "تليفون", "تلفون", "موبايل", "هاتف", "جوال", "جواله", "موبايله", "phone", "mobile"],
  workshop: ["ورشه", "الورشه", "للورشه", "دوره", "الدوره", "للدوره", "كورس", "الكورس", "workshop", "course"],
  group: ["مجموعه", "المجموعه", "جروب", "الجروب", "group", "للمجموعه"],
  country: ["دوله", "الدوله", "بلد", "البلد", "country"],
  discount: ["خصم", "الخصم", "بخصم", "تخفيض", "discount"],
  reason: ["بسبب", "لان", "لانه", "السبب", "سبب", "because", "reason"],
  paid: ["دفع", "دفعت", "دفعوا", "عربون", "مدفوع", "سدد", "سددت", "paid", "deposit"],
  note: ["ملاحظه", "ملاحظات", "ملحوظه", "note", "notes"],
};
const KEYWORD_FIELD = new Map<string, Field>();
for (const [f, words] of Object.entries(KEYWORDS) as [Field, string[]][]) for (const w of words) KEYWORD_FIELD.set(w, f);

function markerOf(t: string): Field | null {
  const direct = KEYWORD_FIELD.get(t);
  if (direct) return direct;
  if (t.startsWith("و") && t.length > 2) return KEYWORD_FIELD.get(t.slice(1)) ?? null;
  return null;
}

const FILLER = new Set(["حجز", "جديد", "سجل", "اعمل", "عايز", "عاوز", "اضافه", "ضيف", "لو", "سمحت", "من", "فضلك", "ل", "ب", "و", "في", "هو", "هي", "ده", "دي", "يا", "برضو", "كمان", "ثم", "بعدين"]);

const ONLINE_WORDS = ["اونلاين", "اون لاين", "عن بعد", "online", "زوم", "اونلاين"];
const OFFLINE_WORDS = ["حضوري", "حضور", "فيزيكال", "offline", "في المكان", "وجها لوجه", "حضوريا"];

const ORDINALS: Record<string, number> = {
  اول: 1, الاول: 1, الاولي: 1, الاوله: 1, اوله: 1, الثاني: 2, التاني: 2, الثانيه: 2, التانيه: 2, ثاني: 2, تاني: 2, الثالث: 3, التالت: 3, الثالثه: 3, التالته: 3,
  الرابع: 4, الرابعه: 4, الخامس: 5, الخامسه: 5, السادس: 6, السادسه: 6, السابع: 7, السابعه: 7, الثامن: 8, الثامنه: 8, التاسع: 9, التاسعه: 9, العاشر: 10, العاشره: 10,
};
const MONTHS: Record<string, number> = {
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const COUNTRY_ALIASES: Record<string, string[]> = {
  QA: ["قطر", "الدوحه"], SA: ["السعوديه", "سعوديه", "المملكه", "الرياض", "جده"], BH: ["البحرين", "بحرين"], KW: ["الكويت", "كويت"],
  AE: ["الامارات", "امارات", "دبي", "ابوظبي"], OM: ["عمان", "مسقط"], EG: ["مصر", "القاهره"],
};

// ------------------------------------------------------------------------------------------------------------------------------ the parser
type Ctx = { workshops: WorkshopEntry[]; countries: readonly CountryEntry[] };

function joinRaw(toks: Tok[]): string { return toks.map((t) => t.raw).join(" ").replace(/\s+/g, " ").trim(); }

function parseGroupHint(toks: Tok[]): GroupHint | null {
  if (toks.length === 0) return null;
  let number: number | null = null;
  let date: GroupHint["date"] = null;
  const words: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].norm;
    const m = MONTHS[t];
    if (m && i > 0) {
      const d = readNumber(toks, i - 1);
      if (d && d.value >= 1 && d.value <= 31) { date = { day: d.value, month: m }; continue; }
    }
    if (m) continue;
    if (t in ORDINALS) { number = ORDINALS[t]; continue; }
    const n = readNumber(toks, i);
    if (n && !n.percent) { if (number === null && !(toks[i + 1] && MONTHS[toks[i + 1].norm])) number = n.value; i = n.next - 1; continue; }
    words.push(stem(t));
  }
  return { text: joinRaw(toks), number, date, tokens: words.filter((w) => w.length > 1 && w !== "ال") };
}

export function parseBookingSpeech(text: string, ctx: Ctx): SpeechBooking {
  const out: SpeechBooking = {
    transcript: text, customerName: null, phone: null, workshopId: null, workshopAmbiguous: false, workshopText: null, group: null, country: null,
    attendance: null, discount: null, discountReason: null, paidNow: null, paidFull: false, note: null,
  };
  let work = text;

  // phone: a run of at least 8 digits, possibly spoken with spaces or dashes
  const ascii = normalizeAr(work);
  const ph = /(?:\+?\d[\s-]?){8,15}/.exec(ascii);
  if (ph) {
    const digits = ph[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) {
      out.phone = digits;
      // remove the same run from the working text (digits only appear once in the transcript)
      work = work.replace(/[٠-٩\d](?:[\s-]?[٠-٩\d]){7,14}/, " ");
    }
  }

  const lower = normalizeAr(work);
  // attendance
  if (ONLINE_WORDS.some((w) => lower.includes(w))) out.attendance = "online";
  else if (OFFLINE_WORDS.some((w) => lower.includes(w))) out.attendance = "offline";
  // country (whole-token match, Arabic or English, with a few city / alias names)
  const lowerTokens = lower.split(" ");
  const countryWords = new Set<string>();
  for (const c of ctx.countries) {
    const names = [normalizeAr(c.ar), normalizeAr(c.en), ...(COUNTRY_ALIASES[c.code] ?? [])];
    for (const nm of names) {
      const parts = nm.split(" ");
      for (let i = 0; i + parts.length <= lowerTokens.length; i++) {
        if (parts.every((p, k) => lowerTokens[i + k] === p || lowerTokens[i + k] === "ب" + p || lowerTokens[i + k] === "ل" + p || lowerTokens[i + k] === "في" + p)) {
          if (!out.country) out.country = c.code;
          for (const p of parts) { countryWords.add(p); countryWords.add("ب" + p); countryWords.add("ل" + p); }
        }
      }
    }
  }

  // segments by key word
  const toks = tokenize(work).filter((t) => !countryWords.has(t.norm) && !ONLINE_WORDS.includes(t.norm) && !OFFLINE_WORDS.includes(t.norm) && !["اون", "لاين", "بعد", "عن"].includes(t.norm));
  const seg: Record<Field | "lead", Tok[]> = { lead: [], customer: [], phone: [], workshop: [], group: [], country: [], discount: [], reason: [], paid: [], note: [] };
  let cur: Field | "lead" = "lead";
  for (const t of toks) {
    const m = markerOf(t.norm);
    // a note runs to the end; inside a discount reason the words "customer" / "number" are ordinary words ("because old customer")
    if (m && cur !== "note" && !(cur === "reason" && (m === "customer" || m === "phone" || m === "reason"))) { cur = m; continue; }
    seg[cur].push(t);
  }

  // customer
  const nameToks = (seg.customer.length ? seg.customer : seg.lead).filter((t) => !FILLER.has(t.norm) && !/^\d+$/.test(t.norm));
  const name = joinRaw(nameToks);
  if (name.length >= 2) out.customerName = name;

  // workshop: the best covered name part (a workshop is often named "Arabic / English")
  const wsToks = (seg.workshop.length ? seg.workshop : [...seg.lead, ...seg.customer]).map((t) => stem(t.norm));
  const wsSet = new Set(wsToks);
  const scored = ctx.workshops.map((w) => {
    let best = 0;
    let matched: string[] = [];
    for (const part of w.name.split(/[/|\-–—]/)) {
      const ptoks = normalizeAr(part).split(" ").map(stem).filter((x) => x.length > 1 && !["ورشه", "دوره", "كورس"].includes(x));
      if (ptoks.length === 0) continue;
      const hits = ptoks.filter((x) => wsSet.has(x));
      if (hits.length > 0 && ptoks.some((x) => x.length >= 3 && wsSet.has(x)) && hits.length / ptoks.length > best) { best = hits.length / ptoks.length; matched = hits; }
    }
    return { id: w.id, score: best, matched };
  }).filter((s) => s.score >= 0.6).sort((a, b) => b.score - a.score);
  if (scored.length > 0) {
    if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) < 0.01) out.workshopAmbiguous = true;
    else out.workshopId = scored[0].id;
    out.workshopText = ctx.workshops.find((w) => w.id === scored[0].id)?.name ?? null;
    // the words that named the workshop are not part of the customer's name
    if (seg.customer.length === 0 && out.customerName) {
      const used = new Set(scored[0].matched);
      const n2 = joinRaw(nameToks.filter((t) => !used.has(stem(t.norm))));
      out.customerName = n2.length >= 2 ? n2 : null;
    }
  }

  // group
  out.group = parseGroupHint(seg.group);

  // discount
  if (seg.discount.length) {
    const n = readNumber(seg.discount, seg.discount.findIndex((_, i) => readNumber(seg.discount, i) !== null));
    if (n) {
      if (n.percent) out.discount = { type: "percent", value: n.value, assumedPercent: false };
      else if (n.currency || n.value > 100) out.discount = { type: "fixed", value: n.value, assumedPercent: false };
      else out.discount = { type: "percent", value: n.value, assumedPercent: true };
    }
  }
  const reason = joinRaw(seg.reason);
  if (reason) out.discountReason = reason;

  // paid now
  if (seg.paid.length) {
    const idx = seg.paid.findIndex((_, i) => readNumber(seg.paid, i) !== null);
    if (idx >= 0) { const n = readNumber(seg.paid, idx); if (n && n.value > 0) out.paidNow = n.value; }
    if (out.paidNow === null && seg.paid.some((t) => ["كامل", "كله", "بالكامل", "full"].includes(t.norm))) out.paidFull = true;
  }

  const note = joinRaw(seg.note);
  if (note) out.note = note;
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------ group matching
/** The group the speaker meant, from "group 2", "the second group", a name, or a session date such as "5 December". null when nothing or several match. */
export function matchGroup(hint: GroupHint, groups: GroupEntry[]): { id: string | null; ambiguous: boolean } {
  if (hint.date) {
    const hit = groups.filter((g) => g.sessions.some((d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
      return m && Number(m[2]) === hint.date!.month && Number(m[3]) === hint.date!.day;
    }));
    if (hit.length === 1) return { id: hit[0].id, ambiguous: false };
    if (hit.length > 1) return { id: null, ambiguous: true };
  }
  if (hint.number !== null) {
    const n = hint.number;
    const named = groups.filter((g) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(normalizeAr(g.name)));
    if (named.length === 1) return { id: named[0].id, ambiguous: false };
    if (named.length > 1) return { id: null, ambiguous: true };
    const anyNumbered = groups.some((g) => /\d/.test(normalizeAr(g.name)));
    if (!anyNumbered && n >= 1 && n <= groups.length) return { id: groups[n - 1].id, ambiguous: false };
  }
  if (hint.tokens.length) {
    const scored = groups.map((g) => {
      const toks = normalizeAr(g.name).split(" ").map(stem);
      return { id: g.id, hit: hint.tokens.filter((t) => toks.includes(t)).length };
    }).filter((s) => s.hit > 0).sort((a, b) => b.hit - a.hit);
    if (scored.length === 1 || (scored.length > 1 && scored[0].hit > scored[1].hit)) return { id: scored[0].id, ambiguous: false };
    if (scored.length > 1) return { id: null, ambiguous: true };
  }
  return { id: null, ambiguous: false };
}

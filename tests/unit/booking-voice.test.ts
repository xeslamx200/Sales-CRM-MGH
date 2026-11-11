import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGroup, normalizeAr, parseBookingSpeech, readNumber } from "../../src/lib/voice/booking-parser.ts";

const countries = [
  { code: "QA", ar: "قطر", en: "Qatar" }, { code: "SA", ar: "السعودية", en: "Saudi Arabia" }, { code: "BH", ar: "البحرين", en: "Bahrain" },
  { code: "KW", ar: "الكويت", en: "Kuwait" }, { code: "AE", ar: "الإمارات", en: "UAE" }, { code: "OM", ar: "عُمان", en: "Oman" }, { code: "EG", ar: "مصر", en: "Egypt" },
];
const workshops = [
  { id: "w1", name: "كلود للأعمال / Claude for Business" },
  { id: "w2", name: "الذكاء الاصطناعي للمبيعات" },
  { id: "w3", name: "إدارة الوقت" },
];
const ctx = { workshops, countries };
const num = (s: string) => { const t = normalizeAr(s).split(" ").map((norm) => ({ raw: norm, norm })); return readNumber(t, 0)?.value ?? null; };

test("spoken numbers: digits, Arabic digits and Egyptian / Gulf words", () => {
  assert.equal(num("500"), 500);
  assert.equal(num("٥٠٠"), 500);
  assert.equal(num("خمسمية"), 500);
  assert.equal(num("خمسمائة"), 500);
  assert.equal(num("ميه وخمسين"), 150);
  assert.equal(num("الف وخمسمية"), 1500);
  assert.equal(num("ألفين"), 2000);
  assert.equal(num("ألفين وخمسمية"), 2500);
  assert.equal(num("تلاتمية"), 300);
  assert.equal(num("عشرة"), 10);
  assert.equal(num("خمسه وعشرين"), 25);
  assert.equal(num("3 الاف"), 3000);
  assert.equal(num("hello"), null);
});

test("a full dictated booking in Arabic fills every field", () => {
  const p = parseBookingSpeech("حجز جديد للعميل أحمد محمد رقمه 01001234567 ورشة كلود للأعمال المجموعة الثانية دولة قطر أونلاين خصم عشرة في المية بسبب عميل قديم ودفع خمسمية ريال ملاحظة يريد فاتورة", ctx);
  assert.equal(p.customerName, "أحمد محمد");
  assert.equal(p.phone, "01001234567");
  assert.equal(p.workshopId, "w1");
  assert.equal(p.group?.number, 2);
  assert.equal(p.country, "QA");
  assert.equal(p.attendance, "online");
  assert.deepEqual(p.discount, { type: "percent", value: 10, assumedPercent: false });
  assert.equal(p.discountReason, "عميل قديم");
  assert.equal(p.paidNow, 500);
  assert.equal(p.note, "يريد فاتورة");
});

test("digits, percent sign, offline, another country and an English customer name", () => {
  const p = parseBookingSpeech("book for customer Sara Ali phone 0555 123 4567 workshop Claude for Business group 3 Saudi Arabia offline discount 15% reason returning customer paid 1000", ctx);
  assert.equal(p.customerName, "Sara Ali");
  assert.equal(p.phone, "05551234567");
  assert.equal(p.workshopId, "w1");
  assert.equal(p.group?.number, 3);
  assert.equal(p.country, "SA");
  assert.equal(p.attendance, "offline");
  assert.deepEqual(p.discount, { type: "percent", value: 15, assumedPercent: false });
  assert.equal(p.discountReason, "returning customer");
  assert.equal(p.paidNow, 1000);
});

test("a fixed discount is recognised by its currency or a large number; a bare small number is assumed to be a percentage", () => {
  assert.deepEqual(parseBookingSpeech("خصم 200 ريال بسبب سبب", ctx).discount, { type: "fixed", value: 200, assumedPercent: false });
  assert.deepEqual(parseBookingSpeech("خصم 150", ctx).discount, { type: "fixed", value: 150, assumedPercent: false });
  assert.deepEqual(parseBookingSpeech("خصم 20", ctx).discount, { type: "percent", value: 20, assumedPercent: true });
  assert.equal(parseBookingSpeech("حجز بدون خصم", ctx).discount, null);
});

test("the workshop is not guessed when it is not clearly named; the name of the customer is kept", () => {
  const p = parseBookingSpeech("العميل منى حسن ورشة تسويق", ctx);
  assert.equal(p.workshopId, null);
  assert.equal(p.customerName, "منى حسن");
  const q = parseBookingSpeech("منى حسن إدارة الوقت", ctx);
  assert.equal(q.workshopId, "w3");
  assert.equal(q.customerName, "منى حسن");
});

test("paid in full, nothing paid, and no phone", () => {
  assert.equal(parseBookingSpeech("دفع كامل", ctx).paidFull, true);
  assert.equal(parseBookingSpeech("دفع كامل", ctx).paidNow, null);
  const p = parseBookingSpeech("العميل ليلى", ctx);
  assert.equal(p.paidNow, null);
  assert.equal(p.phone, null);
});

test("a group is found by number, ordinal, name or a session date", () => {
  const groups = [
    { id: "g1", name: "Group 1", sessions: ["2026-12-06", "2026-12-07"] },
    { id: "g2", name: "Group 2", sessions: ["2026-12-20"] },
  ];
  assert.equal(matchGroup(parseBookingSpeech("مجموعة 2", ctx).group!, groups).id, "g2");
  assert.equal(matchGroup(parseBookingSpeech("المجموعة الأولى", ctx).group!, groups).id, "g1");
  assert.equal(matchGroup(parseBookingSpeech("جروب يوم 20 ديسمبر", ctx).group!, groups).id, "g2");
  assert.equal(matchGroup(parseBookingSpeech("مجموعة 9", ctx).group!, groups).id, null);
  const plain = [{ id: "a", name: "صباحي", sessions: [] }, { id: "b", name: "مسائي", sessions: [] }];
  assert.equal(matchGroup(parseBookingSpeech("المجموعة الثانية", ctx).group!, plain).id, "b");
  assert.equal(matchGroup(parseBookingSpeech("المجموعة المسائي", ctx).group!, plain).id, "b");
});

test("normalisation makes Arabic spellings comparable", () => {
  assert.equal(normalizeAr("أَحْمَد"), normalizeAr("احمد"));
  assert.equal(normalizeAr("مدرسة"), normalizeAr("مدرسه"));
  assert.equal(normalizeAr("١٢٣"), "123");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND_PRESETS, DEFAULT_BRAND, brandCssVars, brandIssues, brandStyleText, contrast, mix, normalizeHex, readableOn } from "../../src/lib/brand.ts";

test("contrast follows WCAG", () => {
  assert.equal(Math.round(contrast("#ffffff", "#000000")), 21);
  assert.equal(Math.round(contrast("#ffffff", "#ffffff")), 1);
  assert.ok(contrast("#ffffff", "#0b2a52") > 12);
});

test("every built-in preset, including the MGH default, is readable", () => {
  for (const p of BRAND_PRESETS) assert.deepEqual(brandIssues(p.colors), [], `preset ${p.key}`);
});

test("colours that would make the application unreadable are reported", () => {
  assert.deepEqual(brandIssues({ ...DEFAULT_BRAND, navy: "#dddddd" }).includes("navy_contrast"), true);
  assert.deepEqual(brandIssues({ ...DEFAULT_BRAND, gold: "#0c2b53" }).includes("gold_on_navy"), true);
  assert.deepEqual(brandIssues({ ...DEFAULT_BRAND, blue: "#ffe680" }).includes("blue_contrast"), true);
});

test("hex input is normalised and anything else is refused", () => {
  assert.equal(normalizeHex("#0B2A52"), "#0b2a52");
  assert.equal(normalizeHex("0b2a52"), "#0b2a52");
  assert.equal(normalizeHex("#abc"), "#aabbcc");
  assert.equal(normalizeHex("red"), null);
  assert.equal(normalizeHex("#12345"), null);
  assert.equal(normalizeHex("#123456; background:url(x)"), null);
});

test("text on the highlight is white or near-black, whichever reads better", () => {
  assert.equal(readableOn("#f9c846"), "#111827");
  assert.equal(readableOn("#0b2a52"), "#ffffff");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
});

test("the style text only ever contains plain hex values", () => {
  const css = brandStyleText(brandCssVars(DEFAULT_BRAND));
  assert.match(css, /^:root\{--brand-navy:#0b2a52;/);
  assert.match(css, /--sidebar:#0b2a52/);
  assert.match(css, /--primary:#1a468a/);
  assert.doesNotMatch(css, /[<>"'()]/);
  assert.equal(brandStyleText({ "--x": "red", "--y": "#fff", "bad name": "#ffffff", "--ok": "#aabbcc" }), ":root{--ok:#aabbcc}");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { egpPreview, parseExchangeRates, PAYMENT_CURRENCIES, rateFor, ratesNeedRefresh, workshopBalance, type RateTable } from "../../src/lib/fx.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const good = { result: "success", base_code: "EGP", rates: { EGP: 1, USD: 0.02, EUR: 0.018, SAR: 0.075, AED: 0.0735, GBP: 0.0155, KWD: 0.00625, QAR: 0.0735, BHD: 0.0077, OMR: 0.00787, JOD: 0.0145, TRY: 0.8 } };

test("fx parse: stores the INVERSE (EGP per 1 unit) and only the offered currencies", () => {
  const r = parseExchangeRates(good)!;
  assert.equal(r.USD, 50);
  assert.equal(r.EUR, 55.55555556);
  assert.equal("EGP" in r, false);
  assert.deepEqual(Object.keys(r).sort(), PAYMENT_CURRENCIES.filter((c) => c !== "EGP").sort());
  assert.equal(parseExchangeRates({ ...good, rates: { USD: 0.02, ZZZ: 3 } })!.USD, 50, "a partial answer still gives the valid ones");
});

test("fx parse: anything unexpected is rejected (the old rates stay)", () => {
  for (const bad of [null, "x", [], {}, { result: "error" }, { ...good, result: "error" }, { ...good, base_code: "USD" }, { ...good, rates: null },
    { ...good, rates: { USD: 0 } }, { ...good, rates: { USD: -1 } }, { ...good, rates: { USD: "0.02" } }, { ...good, rates: { USD: Infinity } }, { ...good, rates: {} },
    { ...good, rates: { USD: 1e-12 } }]) {
    assert.equal(parseExchangeRates(bad), null, JSON.stringify(bad).slice(0, 60));
  }
});

test("fx rateFor: EGP is 1, a foreign rate must exist and be fresh enough", () => {
  const t: RateTable = { USD: { rateToEgp: 50, fetchedAt: hoursAgo(1) }, EUR: { rateToEgp: 55, fetchedAt: hoursAgo(49) } };
  assert.equal(rateFor("EGP", {}, NOW), 1);
  assert.equal(rateFor("egp", {}, NOW), 1);
  assert.equal(rateFor("usd", t, NOW), 50);
  assert.equal(rateFor("EUR", t, NOW), null, "older than 48 h: the database refuses it too");
  assert.equal(rateFor("XYZ", t, NOW), null);
  assert.equal(rateFor("USD", { USD: { rateToEgp: 50, fetchedAt: "garbage" } }, NOW), null);
});

test("fx refresh policy: missing currency or rates older than 6 h", () => {
  const full: RateTable = Object.fromEntries(PAYMENT_CURRENCIES.filter((c) => c !== "EGP").map((c) => [c, { rateToEgp: 1, fetchedAt: hoursAgo(2) }]));
  assert.equal(ratesNeedRefresh(full, NOW), false);
  assert.equal(ratesNeedRefresh({}, NOW), true);
  assert.equal(ratesNeedRefresh({ ...full, USD: { rateToEgp: 1, fetchedAt: hoursAgo(7) } }, NOW), true);
  const { SAR: _drop, ...missing } = full; void _drop;
  assert.equal(ratesNeedRefresh(missing, NOW), true);
});

test("fx egpPreview: rounds like the database (2 decimals) and never goes negative", () => {
  assert.equal(egpPreview(100, 50), 5000);
  assert.equal(egpPreview(100, 60), 6000);
  assert.equal(egpPreview(33.33, 50.12345678), 1670.61);   // 1670.6148... -> .61
  assert.equal(egpPreview(0.01, 55.55555556), 0.56);
  assert.equal(egpPreview(12.5, 1), 12.5);
  for (const bad of [[0, 50], [-5, 50], [10, 0], [NaN, 50], [10, Infinity]] as const) assert.equal(egpPreview(bad[0], bad[1]), 0);
});

test("workshop balance: only confirmed payments, price optional", () => {
  assert.deepEqual(workshopBalance(10000, 2500), { paid: 2500, remaining: 7500, settled: false });
  assert.deepEqual(workshopBalance(10000, 10000), { paid: 10000, remaining: 0, settled: true });
  assert.deepEqual(workshopBalance(10000, 12000), { paid: 12000, remaining: 0, settled: true }, "overpayment: nothing remaining");
  assert.deepEqual(workshopBalance(null, 300), { paid: 300, remaining: null, settled: false });
  assert.equal(workshopBalance(10000.1, 0.1).remaining, 10000);
});

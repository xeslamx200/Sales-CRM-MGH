import { test } from "node:test";
import assert from "node:assert/strict";
import { tzOffsetMinutes, utcToZonedLocal, zonedLocalToUtc } from "../../src/lib/dates/zoned.ts";
import { parseEnv, publicSchema, serverSchemas, EnvError } from "../../src/env.ts";

test("wall-clock input is interpreted in the company's time zone", () => {
  assert.equal(zonedLocalToUtc("2026-10-19T14:30", "Asia/Qatar"), "2026-10-19T11:30:00.000Z");
  assert.equal(zonedLocalToUtc("2026-10-19T14:30", "UTC"), "2026-10-19T14:30:00.000Z");
  assert.equal(zonedLocalToUtc("2026-01-15T09:00", "Africa/Cairo"), "2026-01-15T07:00:00.000Z");
  // 00:30 on 1 Sept in Qatar is still 31 Aug in UTC.
  assert.equal(zonedLocalToUtc("2026-09-01T00:30", "Asia/Qatar"), "2026-08-31T21:30:00.000Z");
});

test("DST transitions resolve to the correct instant", () => {
  // Europe/London: clocks go forward 29 Mar 2026 01:00 UTC; 12:00 local is BST (UTC+1).
  assert.equal(zonedLocalToUtc("2026-03-29T12:00", "Europe/London"), "2026-03-29T11:00:00.000Z");
  assert.equal(zonedLocalToUtc("2026-03-28T12:00", "Europe/London"), "2026-03-28T12:00:00.000Z");
  assert.equal(tzOffsetMinutes(new Date("2026-07-01T00:00:00Z"), "Europe/London"), 60);
});

test("invalid local values are rejected", () => {
  assert.equal(zonedLocalToUtc("2026-02-31T10:00", "UTC"), null);
  assert.equal(zonedLocalToUtc("2026-10-19 14:30", "UTC"), null);
  assert.equal(zonedLocalToUtc("2026-10-19T24:30", "UTC"), null);
  assert.equal(zonedLocalToUtc("", "UTC"), null);
});

test("UTC instants round-trip to input values in the company zone", () => {
  assert.equal(utcToZonedLocal("2026-10-19T11:30:00Z", "Asia/Qatar"), "2026-10-19T14:30");
  assert.equal(utcToZonedLocal(null, "Asia/Qatar"), "");
  const local = "2026-12-31T23:45";
  assert.equal(utcToZonedLocal(zonedLocalToUtc(local, "Asia/Qatar")!, "Asia/Qatar"), local);
});

test("env validation names missing variables and never echoes values", () => {
  const secretValue = "super-secret-value-that-must-not-leak";
  assert.throws(
    () => parseEnv(serverSchemas.cron, { CRON_SECRET: "short" }),
    (e: unknown) => e instanceof EnvError && e.message.includes("CRON_SECRET") && !e.message.includes("short"),
  );
  assert.throws(
    () => parseEnv(publicSchema, { NEXT_PUBLIC_SUPABASE_URL: secretValue, NEXT_PUBLIC_SUPABASE_ANON_KEY: "" }),
    (e: unknown) => e instanceof EnvError
      && e.variables.join() === "NEXT_PUBLIC_SUPABASE_ANON_KEY,NEXT_PUBLIC_SUPABASE_URL"
      && !e.message.includes(secretValue),
  );
  const ok = parseEnv(serverSchemas.whatsapp, {
    WHATSAPP_APP_SECRET: "0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "0123456789abcdef0",
    WHATSAPP_ACCESS_TOKEN: "x".repeat(30), WHATSAPP_GRAPH_API_VERSION: " ",
  });
  assert.equal(ok.WHATSAPP_GRAPH_API_VERSION, "v26.0", "blank optional value falls back to the default");
});

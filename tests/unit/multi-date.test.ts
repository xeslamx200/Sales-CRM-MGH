import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workshopGroupSchema } from "../../src/schemas/workshops.ts";

// The calendar writes an ARRAY of YYYY-MM-DD strings; the form used to write lines of text. The server action re-validates with the same schema,
// so both shapes must keep being accepted and give the same sorted, de-duplicated dates.
const base = { offeringId: "5b078b36-4b98-4a9f-9a9f-e8bae3cd339b", name: "Run 1", capacity: "", attendance: "", isActive: true };

test("group sessions: an array from the calendar and lines of text give the same dates", () => {
  const a = workshopGroupSchema.parse({ ...base, sessions: ["2026-12-13", "2026-12-06"] });
  const b = workshopGroupSchema.parse({ ...base, sessions: "2026-12-13\n2026-12-06" });
  assert.deepEqual(a.sessions, ["2026-12-06", "2026-12-13"]);
  assert.deepEqual(b.sessions, a.sessions);
});

test("group sessions: nothing chosen, a bad date or more than 60 days is refused", () => {
  assert.equal(workshopGroupSchema.safeParse({ ...base, sessions: [] }).success, false);
  assert.equal(workshopGroupSchema.safeParse({ ...base, sessions: ["2026-13-40"] }).success, false);
  const many = Array.from({ length: 61 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  assert.equal(workshopGroupSchema.safeParse({ ...base, sessions: many }).success, false);
  assert.equal(workshopGroupSchema.safeParse({ ...base, sessions: many.slice(0, 60) }).success, true);
});

test("group sessions: the calendar limit matches the database limit", () => {
  const ui = readFileSync(new URL("../../src/components/form/multi-date-field.tsx", import.meta.url), "utf8");
  const sql = readFileSync(new URL("../../supabase/migrations/20261104000984_workshop_pricing_groups.sql", import.meta.url), "utf8");
  assert.match(ui, /MAX_DAYS = 60/);
  assert.match(sql, /cardinality\(sessions\) between 1 and 60/);
});

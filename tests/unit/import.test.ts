import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHeaders, validateLeadRows } from "../../src/lib/import/leads.ts";
import { parseCsv } from "../../src/lib/csv.ts";

test("headers are recognized in Arabic and English, case/spacing-insensitive", () => {
  const { map, unknown } = mapHeaders(["الاسم", "Phone Number", "E-mail", "المصدر", "Estimated Value", "favorite color"]);
  assert.deepEqual(map, { full_name: 0, phone: 1, email: 2, source: 3, estimated_value: 4 });
  assert.deepEqual(unknown, ["favorite color"]);
});

test("a file without a name column is rejected as a whole", () => {
  const r = validateLeadRows(["phone"], [["+97455550001"]]);
  assert.equal(r.missingName, true);
  assert.equal(r.rows.length, 0);
});

test("rows are validated individually with stable error keys", () => {
  const owners = new Map([["agent@example.test", "11111111-1111-1111-1111-111111111111"]]);
  const csv = [
    "name,phone,email,source,priority,value,owner",
    "سارة,٥٥٥٥ ٠٠٠١,SARA@EXAMPLE.COM,هاتف,عالية,\"1,500\",agent@example.test",
    ",abc,not-an-email,carrier pigeon,meh,-5,ghost@example.test",
    "Omar,+974 5555 0001,,walk in,,,",
  ].join("\n");
  const parsed = parseCsv(csv);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const { rows } = validateLeadRows(parsed.headers, parsed.rows, {
    sourceLabels: { "هاتف": "phone" }, priorityLabels: { "عالية": "high" }, owners,
  });
  assert.deepEqual(rows[0].errors, []);
  assert.deepEqual(rows[0].data, {
    full_name: "سارة", phone: "+97455550001", email: "sara@example.com", title: null, source: "phone",
    campaign: null, priority: "high", estimated_value: 1500, notes: null, owner_id: "11111111-1111-1111-1111-111111111111",
  });
  assert.deepEqual(rows[1].errors.sort(), ["email_invalid", "name_required", "owner_unknown", "phone_invalid", "priority_invalid", "source_invalid", "value_invalid"]);
  assert.equal(rows[1].line, 3, "line numbers count the header");
  assert.equal(rows[2].data.source, "walk_in", "enum keys accept spaces for underscores");
  assert.deepEqual(rows[2].warnings, ["duplicate_in_file"], "same phone twice in a file is flagged on the later row");
});

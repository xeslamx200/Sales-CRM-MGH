import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCsv } from "../../src/lib/export/csv.ts";
import { colName, crc32, sheetName, toXlsx } from "../../src/lib/export/xlsx.ts";

test("csv: BOM, CRLF, quoting, numbers, nulls", () => {
  const s = toCsv(["a", "b,c"], [["x", 1.5], ['he said "hi"', null], ["line\nbreak", 0]]);
  assert.equal(s, '﻿a,"b,c"\r\nx,1.5\r\n"he said ""hi""",\r\n"line\nbreak",0\r\n');
});

test("csv: text that could run as a formula is neutralised, numbers are left alone", () => {
  const s = toCsv(["v"], [['=HYPERLINK("http://x")'], ["+1"], ["-2"], ["@SUM(A1)"], [-5], ["ok"], ["أحمد"]]);
  const lines = s.slice(1).split("\r\n");
  assert.equal(lines[1], '"\'=HYPERLINK(""http://x"")"');
  assert.deepEqual(lines.slice(2, 8), ["'+1", "'-2", "'@SUM(A1)", "-5", "ok", "أحمد"]);
});

test("xlsx: helpers", () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  assert.equal(sheetName("a/b[c]:d*e?f"), "a b c d e f");
  assert.equal(sheetName("x".repeat(40)).length, 31);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);   // the standard CRC-32 check value
});

test("xlsx: a real, valid workbook (opened with Python's zipfile and an XML parser)", () => {
  const bytes = toXlsx("Customers", ["Name", "Amount"], [["أحمد & <co>", 1500.5], ["=cmd|' /C calc'!A0", null], [null, 3]], { rtl: true });
  const dir = mkdtempSync(join(tmpdir(), "xlsx-"));
  try {
    const file = join(dir, "t.xlsx");
    writeFileSync(file, bytes);
    const py = [
      "import zipfile, sys, xml.dom.minidom as m",
      "z = zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "names = sorted(z.namelist())",
      "for n in names: m.parseString(z.read(n))",
      "sheet = z.read('xl/worksheets/sheet1.xml').decode('utf8')",
      "print('|'.join(names)); print('rightToLeft' in sheet, '1500.5' in sheet, '&amp;' in sheet, \"'=cmd\" in sheet)",
    ].join("\n");
    let out: string;
    try { out = execFileSync("python", ["-I", "-c", py, file], { encoding: "utf8" }); } catch { out = execFileSync("python3", ["-I", "-c", py, file], { encoding: "utf8" }); }
    const [names, flags] = out.trim().split(/\r?\n/);
    assert.equal(names, "[Content_Types].xml|_rels/.rels|xl/_rels/workbook.xml.rels|xl/styles.xml|xl/workbook.xml|xl/worksheets/sheet1.xml");
    assert.equal(flags, "True True True True");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

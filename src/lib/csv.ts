/**
 * RFC 4180 CSV parsing and serialization.
 *
 * Export protection: cells beginning with = + - @ (or tab / CR) are prefixed
 * with an apostrophe so spreadsheet apps do not execute them as formulas
 * (CSV/formula injection). Exports include a UTF-8 BOM so Excel shows Arabic
 * correctly.
 */

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_IMPORT_ROWS = 5000;

export type ParseCsvResult =
  | { ok: true; headers: string[]; rows: string[][] }
  | { ok: false; error: "empty" | "too_large" | "too_many_rows" | "unterminated_quote" | "inconsistent_columns"; line?: number };

export function parseCsv(text: string, opts: { maxRows?: number; maxBytes?: number } = {}): ParseCsvResult {
  const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS;
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, error: "too_large" };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let i = 0;

  const endRecord = () => {
    record.push(field);
    field = "";
    // Skip fully blank lines.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === "\n") line++;
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { inQuotes = true; i++; continue; }
    if (c === ",") { record.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      endRecord(); line++; i++;
      if (records.length > maxRows + 1) return { ok: false, error: "too_many_rows" };
      continue;
    }
    field += c; i++;
  }
  if (inQuotes) return { ok: false, error: "unterminated_quote", line };
  if (field !== "" || record.length > 0) endRecord();
  if (records.length === 0) return { ok: false, error: "empty" };
  if (records.length > maxRows + 1) return { ok: false, error: "too_many_rows" };

  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1);
  const bad = rows.findIndex((r) => r.length !== headers.length);
  if (bad >= 0) return { ok: false, error: "inconsistent_columns", line: bad + 2 };
  return { ok: true, headers, rows };
}

const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: unknown): string {
  let s = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (DANGEROUS_PREFIX.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][], { bom = true } = {}): string {
  const lines = [headers, ...rows].map((r) => r.map(escapeCsvCell).join(","));
  return (bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

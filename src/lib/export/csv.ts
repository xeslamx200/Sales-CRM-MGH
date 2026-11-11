/** CSV (RFC 4180) for spreadsheets. Text cells that start with = + - @ (or a control character) are prefixed with ' so a spreadsheet never runs them as formulas. */
export type Cell = string | number | null | undefined;

const FORMULA = /^[=+\-@\t\r]/;

export function safeText(v: string): string {
  return FORMULA.test(v) ? `'${v}` : v;
}

function cell(v: Cell): string {
  if (v == null) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : safeText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 with a BOM (Excel needs it for Arabic) and CRLF line ends. */
export function toCsv(header: string[], rows: Cell[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

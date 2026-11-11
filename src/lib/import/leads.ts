/**
 * Validation for CSV lead imports. Pure and framework-free (unit-tested).
 *
 * The server re-runs this on commit; a client-side preview is never trusted.
 * Errors are stable keys, localized by the UI.
 */
import { normalizePhone } from "../phone.ts";

export const LEAD_SOURCES = ["website", "whatsapp", "phone", "referral", "walk_in", "social_media", "campaign", "event", "import", "other"] as const;
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export type Priority = (typeof PRIORITIES)[number];

export type ImportField = "full_name" | "phone" | "email" | "title" | "source" | "campaign" | "priority" | "estimated_value" | "notes" | "owner_email";

/** Accepted header names (case/spacing-insensitive), Arabic and English. */
const ALIASES: Record<ImportField, string[]> = {
  full_name: ["full_name", "name", "full name", "contact", "contact name", "الاسم", "الاسم الكامل", "اسم العميل"],
  phone: ["phone", "mobile", "phone number", "whatsapp", "الهاتف", "رقم الهاتف", "الجوال", "الموبايل", "واتساب"],
  email: ["email", "e-mail", "البريد", "البريد الإلكتروني", "الايميل"],
  title: ["title", "lead", "subject", "العنوان", "الموضوع"],
  source: ["source", "lead source", "المصدر"],
  campaign: ["campaign", "الحملة"],
  priority: ["priority", "الأولوية"],
  estimated_value: ["estimated_value", "estimated value", "value", "amount", "القيمة", "القيمة المتوقعة"],
  notes: ["notes", "note", "comments", "ملاحظات"],
  owner_email: ["owner_email", "owner", "owner email", "assigned to", "المسؤول", "بريد المسؤول"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

export function mapHeaders(headers: string[]): { map: Partial<Record<ImportField, number>>; unknown: string[] } {
  const map: Partial<Record<ImportField, number>> = {};
  const unknown: string[] = [];
  headers.forEach((h, i) => {
    const n = norm(h);
    const field = (Object.keys(ALIASES) as ImportField[]).find((f) => ALIASES[f].some((a) => norm(a) === n));
    if (field && map[field] === undefined) map[field] = i;
    else if (n) unknown.push(h);
  });
  return { map, unknown };
}

export type RowError =
  | "name_required" | "phone_invalid" | "email_invalid" | "source_invalid" | "priority_invalid"
  | "value_invalid" | "owner_unknown" | "too_long";
export type RowWarning = "duplicate_in_file" | "existing_contact";

export type ValidatedRow = {
  line: number; // 1-based line in the file (header = 1)
  data: {
    full_name: string; phone: string | null; email: string | null; title: string | null; source: LeadSource | null;
    campaign: string | null; priority: Priority | null; estimated_value: number | null; notes: string | null;
    owner_id: string | null;
  };
  errors: RowError[];
  warnings: RowWarning[];
};

export type ValidateOptions = {
  defaultCountryCode?: string;
  /** Localized labels accepted in place of enum keys (e.g. Arabic "هاتف"). */
  sourceLabels?: Record<string, LeadSource>;
  priorityLabels?: Record<string, Priority>;
  /** owner e-mail (lower-case) → user id, for members of the target company. */
  owners?: Map<string, string>;
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateLeadRows(headers: string[], rows: string[][], opts: ValidateOptions = {}): {
  rows: ValidatedRow[]; missingName: boolean; unknownHeaders: string[];
} {
  const { map, unknown } = mapHeaders(headers);
  if (map.full_name === undefined) return { rows: [], missingName: true, unknownHeaders: unknown };
  const cell = (r: string[], f: ImportField) => (map[f] === undefined ? "" : (r[map[f]!] ?? "").trim());
  const sourceLabels = Object.fromEntries(Object.entries(opts.sourceLabels ?? {}).map(([k, v]) => [norm(k), v]));
  const priorityLabels = Object.fromEntries(Object.entries(opts.priorityLabels ?? {}).map(([k, v]) => [norm(k), v]));
  const seenPhones = new Map<string, number>();

  const out = rows.map((r, i): ValidatedRow => {
    const errors: RowError[] = [];
    const warnings: RowWarning[] = [];
    const full_name = cell(r, "full_name");
    if (!full_name) errors.push("name_required");

    let phone: string | null = null;
    const rawPhone = cell(r, "phone");
    if (rawPhone) {
      const p = normalizePhone(rawPhone, opts.defaultCountryCode);
      if (p.ok) phone = p.e164;
      else errors.push("phone_invalid");
    }
    const email = cell(r, "email").toLowerCase() || null;
    if (email && !EMAIL.test(email)) errors.push("email_invalid");

    const rawSource = norm(cell(r, "source"));
    let source: LeadSource | null = null;
    if (rawSource) {
      source = (LEAD_SOURCES as readonly string[]).includes(rawSource.replace(/ /g, "_"))
        ? (rawSource.replace(/ /g, "_") as LeadSource) : sourceLabels[rawSource] ?? null;
      if (!source) errors.push("source_invalid");
    }
    const rawPriority = norm(cell(r, "priority"));
    let priority: Priority | null = null;
    if (rawPriority) {
      priority = (PRIORITIES as readonly string[]).includes(rawPriority) ? (rawPriority as Priority) : priorityLabels[rawPriority] ?? null;
      if (!priority) errors.push("priority_invalid");
    }
    const rawValue = cell(r, "estimated_value").replace(/[,\s]/g, "");
    let estimated_value: number | null = null;
    if (rawValue) {
      const n = Number(rawValue);
      if (Number.isFinite(n) && n >= 0 && n < 1e12) estimated_value = Math.round(n * 100) / 100;
      else errors.push("value_invalid");
    }
    const ownerEmail = cell(r, "owner_email").toLowerCase();
    let owner_id: string | null = null;
    if (ownerEmail) {
      owner_id = opts.owners?.get(ownerEmail) ?? null;
      if (!owner_id) errors.push("owner_unknown");
    }
    const title = cell(r, "title") || null;
    const campaign = cell(r, "campaign") || null;
    const notes = cell(r, "notes") || null;
    if (full_name.length > 200 || (title?.length ?? 0) > 200 || (campaign?.length ?? 0) > 200 || (notes?.length ?? 0) > 10000) {
      errors.push("too_long");
    }

    if (phone) {
      if (seenPhones.has(phone)) warnings.push("duplicate_in_file");
      else seenPhones.set(phone, i);
    }
    return {
      line: i + 2,
      data: { full_name, phone, email, title, source, campaign, priority, estimated_value, notes, owner_id },
      errors, warnings,
    };
  });
  return { rows: out, missingName: false, unknownHeaders: unknown };
}

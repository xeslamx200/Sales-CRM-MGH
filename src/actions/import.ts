"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, AppError, type ActionResult } from "@/server/action";
import { getViewer } from "@/server/auth/viewer";
import { requirePermission } from "@/server/auth/permissions";
import { listMembers } from "@/server/data/members";
import { parseCsv, toCsv, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from "@/lib/csv.ts";
import {
  validateLeadRows, LEAD_SOURCES, PRIORITIES, type LeadSource, type Priority, type RowError, type RowWarning,
} from "@/lib/import/leads.ts";
import { userMessage } from "@/lib/errors.ts";
import { limitUser } from "@/server/rate-limit";
import { ar } from "@/i18n/ar";
import { en } from "@/i18n/en";

const importSchema = z.object({
  companyId: z.uuid(),
  // Characters, not bytes: parseCsv enforces the byte limit precisely.
  csv: z.string().min(1).max(MAX_IMPORT_BYTES),
  skipFileDuplicates: z.boolean().default(true),
});

export type PreviewRow = { line: number; name: string; phone: string | null; errors: RowError[]; warnings: RowWarning[] };
export type ImportPreview = {
  total: number; valid: number; invalid: number; duplicatesInFile: number; existingContacts: number;
  unknownHeaders: string[]; sample: PreviewRow[]; problems: PreviewRow[];
};

/** Accept localized labels (Arabic and English) for enum columns. */
function labelMaps() {
  const sourceLabels: Record<string, LeadSource> = {};
  const priorityLabels: Record<string, Priority> = {};
  for (const d of [ar, en]) {
    for (const s of LEAD_SOURCES) sourceLabels[d.enums.leadSource[s]] = s;
    for (const p of PRIORITIES) priorityLabels[d.enums.priority[p]] = p;
  }
  return { sourceLabels, priorityLabels };
}

async function validate(companyId: string, csv: string, action: "import_preview" | "import_commit") {
  const viewer = await getViewer();
  await limitUser(await createClient(), action);
  if (!viewer.companies.some((c) => c.id === companyId)) throw new AppError("auth.forbidden");
  await requirePermission(companyId, "import_leads");
  const parsed = parseCsv(csv, { maxRows: MAX_IMPORT_ROWS, maxBytes: MAX_IMPORT_BYTES });
  if (!parsed.ok) throw new AppError(`csv.${parsed.error}`);
  const supabase = await createClient();
  const members = await listMembers(supabase, [companyId], { activeOnly: true });
  const owners = new Map(members.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m.userId]));
  const result = validateLeadRows(parsed.headers, parsed.rows, { ...labelMaps(), owners });
  if (result.missingName) throw new AppError("csv.missing_name_column");

  // Flag phones that match contacts the user can already see (RLS). Contacts
  // in other companies are linked, not duplicated, by find_or_create_contact.
  const phones = [...new Set(result.rows.flatMap((r) => (r.data.phone ? [r.data.phone] : [])))];
  const known = new Set<string>();
  for (let i = 0; i < phones.length; i += 200) {
    const { data } = await supabase.from("contacts").select("phone_e164").in("phone_e164", phones.slice(i, i + 200)).is("merged_into_id", null);
    for (const c of data ?? []) if (c.phone_e164) known.add(c.phone_e164);
  }
  for (const r of result.rows) if (r.data.phone && known.has(r.data.phone)) r.warnings.push("existing_contact");
  return { supabase, viewer, result };
}

export async function previewImport(input: z.input<typeof importSchema>): Promise<ActionResult<ImportPreview>> {
  return runAction(importSchema, input, async ({ companyId, csv }) => {
    const { result } = await validate(companyId, csv, "import_preview");
    const toPreview = (r: (typeof result.rows)[number]): PreviewRow => ({
      line: r.line, name: r.data.full_name, phone: r.data.phone, errors: r.errors, warnings: r.warnings,
    });
    return {
      total: result.rows.length,
      valid: result.rows.filter((r) => r.errors.length === 0).length,
      invalid: result.rows.filter((r) => r.errors.length > 0).length,
      duplicatesInFile: result.rows.filter((r) => r.warnings.includes("duplicate_in_file")).length,
      existingContacts: result.rows.filter((r) => r.warnings.includes("existing_contact")).length,
      unknownHeaders: result.unknownHeaders,
      sample: result.rows.slice(0, 50).map(toPreview),
      problems: result.rows.filter((r) => r.errors.length > 0).slice(0, 500).map(toPreview),
    };
  });
}

export type ImportResult = { imported: number; linkedExisting: number; failed: number; skipped: number; reportCsv: string | null };

export async function commitImport(input: z.input<typeof importSchema>): Promise<ActionResult<ImportResult>> {
  return runAction(importSchema, input, async ({ companyId, csv, skipFileDuplicates }) => {
    const { supabase, viewer, result } = await validate(companyId, csv, "import_commit");
    const t = viewer.t;
    const failures: { line: number; name: string; phone: string | null; reason: string }[] = [];
    let skipped = 0;
    const ready = result.rows.filter((r) => {
      if (r.errors.length > 0) {
        failures.push({ line: r.line, name: r.data.full_name, phone: r.data.phone, reason: r.errors.map((e) => t.import.errors[e]).join("؛ ") });
        return false;
      }
      if (skipFileDuplicates && r.warnings.includes("duplicate_in_file")) {
        skipped++;
        return false;
      }
      return true;
    });

    let imported = 0;
    let linkedExisting = 0;
    for (let i = 0; i < ready.length; i += 500) {
      const chunk = ready.slice(i, i + 500);
      const res = check(await supabase.rpc("import_leads", { p_company_id: companyId, p_rows: chunk.map((r) => r.data) })) ?? [];
      for (const row of res) {
        const src = chunk[row.row_index - 1];
        if (row.error_key) {
          failures.push({ line: src.line, name: src.data.full_name, phone: src.data.phone, reason: userMessage(row.error_key, viewer.locale) });
        } else {
          imported++;
          if (row.matched_existing) linkedExisting++;
        }
      }
    }
    revalidatePath("/leads");
    const reportCsv = failures.length
      ? toCsv([t.import.reportLine, t.common.name, t.common.phone, t.import.reportReason],
        failures.sort((a, b) => a.line - b.line).map((f) => [f.line, f.name, f.phone ?? "", f.reason]))
      : null;
    return { imported, linkedExisting, failed: failures.length, skipped, reportCsv };
  });
}

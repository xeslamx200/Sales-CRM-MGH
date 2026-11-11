// Flags potentially destructive statements in supabase/migrations so they get
// explicit review before `supabase db push` (and in CI).
//
//   node scripts/db/check-migrations.mjs            # all migrations
//   node scripts/db/check-migrations.mjs 0840 0850  # only files matching
//
// A statement is allowed only with a justification comment on the line above:
//   -- destructive-ok: <reason>
// Function bodies ($$ … $$) are ignored: they only run when called and are
// covered by the SQL test suite.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const RISKY = [
  [/\bdrop\s+table\b/i, "DROP TABLE"],
  [/\bdrop\s+schema\b/i, "DROP SCHEMA"],
  [/\balter\s+table\b[^;]*\bdrop\s+column\b/i, "DROP COLUMN"],
  [/\balter\s+table\b[^;]*\balter\s+column\b[^;]*\btype\b/i, "ALTER COLUMN TYPE"],
  [/\bdrop\s+type\b/i, "DROP TYPE"],
  [/^\s*truncate\b/im, "TRUNCATE"],
  [/^\s*delete\s+from\b/im, "DELETE"],
  [/^\s*update\s+\S+\s+set\b/im, "UPDATE (data rewrite)"],
  [/\bdrop\s+function\b/i, "DROP FUNCTION"],
  [/\brename\s+(to|column)\b/i, "RENAME"],
];

const filters = process.argv.slice(2);
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).filter((f) => !filters.length || filters.some((x) => f.includes(x))).sort();
const findings = [];
for (const file of files) {
  const raw = readFileSync(join(DIR, file), "utf8");
  // Blank out dollar-quoted bodies but keep line numbers.
  const text = raw.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, (m) => m.replace(/[^\n]/g, " "));
  const lines = text.split("\n");
  const rawLines = raw.split("\n");
  lines.forEach((line, i) => {
    const code = line.replace(/--.*$/, "");
    for (const [re, label] of RISKY) {
      if (!re.test(code)) continue;
      const justified = /--\s*destructive-ok:\s*\S/.test(rawLines[i - 1] ?? "") || /--\s*destructive-ok:\s*\S/.test(rawLines[i]);
      if (!justified) findings.push(`${file}:${i + 1}  ${label}  ${rawLines[i].trim().slice(0, 100)}`);
    }
  });
}
if (findings.length) {
  console.error(`Potentially destructive statements without a "-- destructive-ok: <reason>" note (${findings.length}):`);
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log(`Migration safety check passed (${files.length} files).`);

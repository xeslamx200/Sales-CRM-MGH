import "server-only";
import { normalizePhone } from "@/lib/phone.ts";
import { zonedLocalToUtc } from "@/lib/dates/zoned.ts";
import { AppError } from "@/server/action";
import type { Viewer } from "@/server/auth/viewer";
import type { ServerClient } from "@/server/supabase/server";

/** Time zone of a company the viewer can access (reports and dates use it). */
export function companyTz(viewer: Viewer, companyId: string): string {
  return viewer.companies.find((c) => c.id === companyId)?.timezone ?? "UTC";
}

/** Wall-clock "YYYY-MM-DDTHH:mm" in the company's zone → ISO instant. */
export function localToUtc(local: string | null | undefined, tz: string): string | null {
  if (!local) return null;
  const iso = zonedLocalToUtc(local, tz);
  if (!iso) throw new AppError("validation");
  return iso;
}

/** E.164 or null; throws phone.invalid for input that isn't a phone number. */
export function phoneOrNull(input: string | null | undefined): string | null {
  if (!input || !input.trim()) return null;
  const r = normalizePhone(input);
  if (!r.ok) throw new AppError("phone.invalid");
  return r.e164;
}

/** Company of a record visible to the caller (RLS), or forbidden. */
export async function recordCompany(
  supabase: ServerClient, table: "leads" | "tasks", id: string,
): Promise<string> {
  const { data } = await supabase.from(table).select("company_id").eq("id", id).maybeSingle();
  if (!data) throw new AppError("auth.forbidden");
  return data.company_id;
}

/** [start, end) of "today" in a time zone, as ISO instants. */
export function todayBounds(tz: string, now = new Date()): { start: string; end: string; date: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  return { start: zonedLocalToUtc(`${date}T00:00`, tz)!, end: zonedLocalToUtc(`${next}T00:00`, tz)!, date };
}

/** ISO instant `days` days before the request time. */
export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Is `iso` within the last `hours` hours of the request time? */
export function isWithinHours(iso: string | null | undefined, hours: number): boolean {
  return Boolean(iso) && Date.parse(iso!) > Date.now() - hours * 3_600_000;
}

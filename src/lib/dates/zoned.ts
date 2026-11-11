/**
 * Convert between `<input type="datetime-local">` values ("YYYY-MM-DDTHH:mm",
 * wall-clock time in a company's time zone) and UTC instants.
 *
 * The server never interprets a wall-clock time in its own time zone: due
 * dates and follow-ups are always entered in the company's zone.
 */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Offset of `timeZone` from UTC at `instant`, in minutes (e.g. +180 for Qatar). */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** "2026-10-19T14:30" in Asia/Qatar → "2026-10-19T11:30:00.000Z". Null if invalid. */
export function zonedLocalToUtc(local: string, timeZone: string): string | null {
  const m = LOCAL.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  // Two passes handle DST transitions (offset at the guessed instant may differ).
  let guess = wall - tzOffsetMinutes(new Date(wall), timeZone) * 60_000;
  guess = wall - tzOffsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess).toISOString();
}

/** UTC instant → "YYYY-MM-DDTHH:mm" wall-clock time in `timeZone` (for input defaults). */
export function utcToZonedLocal(iso: string | Date | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() + tzOffsetMinutes(d, timeZone) * 60_000);
  return local.toISOString().slice(0, 16);
}

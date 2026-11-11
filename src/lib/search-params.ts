/** Parse Next.js searchParams safely (values are untrusted user input). */
export type SP = Record<string, string | string[] | undefined>;

export function str(sp: SP, key: string, max = 100): string | null {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t ? t.slice(0, max) : null;
}

export function oneOf<T extends string>(sp: SP, key: string, allowed: readonly T[]): T | null {
  const v = str(sp, key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function page(sp: SP): number {
  const n = Number(str(sp, "page"));
  return Number.isInteger(n) && n > 0 && n < 10_000 ? n : 1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(sp: SP, key: string): string | null {
  const v = str(sp, key);
  return v && UUID.test(v) ? v : null;
}

/**
 * Make free text safe inside a PostgREST `or=(…)` filter: drop characters
 * with syntactic meaning there and LIKE wildcards.
 */
export function filterText(s: string): string {
  return s.replace(/[,()*%_\\:"']/g, " ").replace(/\s+/g, " ").trim();
}

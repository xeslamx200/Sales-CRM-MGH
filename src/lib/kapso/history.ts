/**
 * Kapso message history -> rows for public.kapso_import_history (migration 997). Pure (no I/O), shared by the super admin's
 * "Check and complete messages" sync. Never reads or returns more than the CRM stores for a message.
 */

/** Types that are not messages a person wrote (edits, reactions, errors): never stored. */
const SKIP_TYPES = new Set(["errors", "edit", "reaction", "unsupported"]);
const WAMID = /^[A-Za-z0-9._=+/-]{1,200}$/;
const BSUID = /^[^\s]{1,128}$/;

export type HistoryRow = { id: string; d: "i" | "o"; ts: number; ph: string | null; bs: string | null; nm: string | null; ty: string; b: string; st: string };
export type MapResult = { row: HistoryRow; cid: string | null } | { skip: "type" | "bad_id" | "no_time" };

export function phoneDigits(v: unknown): string | null {
  const d = String(v ?? "").replace(/[\s()+-]/g, "");
  return /^[1-9]\d{6,14}$/.test(d) ? d : null;
}

type KapsoMessage = Record<string, unknown> & { id?: unknown; type?: unknown; timestamp?: unknown; kapso?: Record<string, unknown> };

/** One Kapso API message -> one row (or why it is skipped). */
export function mapKapsoMessage(m: KapsoMessage): MapResult {
  const k = (m.kapso ?? {}) as Record<string, unknown>;
  const inbound = k.direction === "inbound";
  const type = String(m.type ?? "unknown").slice(0, 40);
  if (SKIP_TYPES.has(type)) return { skip: "type" };
  const id = String(m.id ?? "");
  if (!WAMID.test(id)) return { skip: "bad_id" };
  const ts = Number(m.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { skip: "no_time" };
  const phone = phoneDigits(inbound ? m.from : m.to) ?? phoneDigits(k.phone_number);
  const bsRaw = String((inbound ? m.from_user_id : m.to_user_id) ?? "");
  const textPart = (m.text ?? {}) as { body?: unknown };
  const text = type === "text" ? (textPart.body ?? k.content) : (k.content ?? null);
  const body = (text && String(text).trim() ? String(text) : `[${type}]`).slice(0, 4096);
  const status = typeof k.status === "string" && ["sent", "delivered", "read", "failed"].includes(k.status) ? k.status : "sent";
  return {
    row: {
      id, d: inbound ? "i" : "o", ts: Math.trunc(ts), ph: phone, bs: BSUID.test(bsRaw) ? bsRaw : null,
      nm: k.contact_name ? String(k.contact_name).slice(0, 200) : null, ty: type, b: body, st: status,
    },
    cid: typeof k.whatsapp_conversation_id === "string" ? k.whatsapp_conversation_id : null,
  };
}

/**
 * A Kapso conversation is one customer: when all its messages in the batch agree on one phone and one BSUID, every message of it carries
 * that identity (staff replies often have neither). A conversation with two different phones or BSUIDs is not unified (never guessed).
 */
export function unifyIdentities(items: { row: HistoryRow; cid: string | null }[]): HistoryRow[] {
  const groups = new Map<string, { ph: Set<string>; bs: Set<string>; nm: string | null }>();
  for (const { row, cid } of items) {
    if (!cid) continue;
    const g = groups.get(cid) ?? { ph: new Set<string>(), bs: new Set<string>(), nm: null };
    groups.set(cid, g);
    if (row.ph) g.ph.add(row.ph);
    if (row.bs) g.bs.add(row.bs);
    g.nm ??= row.nm;
  }
  return items.map(({ row, cid }) => {
    const g = cid ? groups.get(cid) : undefined;
    if (!g || g.ph.size > 1 || g.bs.size > 1) return row;
    return { ...row, ph: row.ph ?? [...g.ph][0] ?? null, bs: row.bs ?? [...g.bs][0] ?? null, nm: row.nm ?? g.nm };
  });
}

/** "YYYY-MM-DD" (start of that day, UTC) -> unix seconds; null when invalid or in the future. */
export function startOfDay(date: string, now = Date.now()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t) || t > now) return null;
  return Math.floor(t / 1000);
}

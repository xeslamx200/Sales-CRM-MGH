import "server-only";
import { createAdminClient } from "@/server/supabase/admin";
import { serverEnv } from "@/server/env";
import { mapKapsoMessage, unifyIdentities, type HistoryRow } from "@/lib/kapso/history.ts";
import { fetchKapsoMedia } from "@/lib/kapso/media.ts";
import { INBOUND_MEDIA_TYPES, safeFileName } from "@/lib/whatsapp/graph.ts";
import type { Json } from "@/types/database";

/**
 * "Check and complete messages" (super admin): for every real Kapso number, read Kapso's message list newest first down to the chosen day,
 * store what the CRM does not have (public.kapso_import_history, migration 997), then copy the files of pictures, voice notes, stickers and
 * documents that are not stored yet. Videos are left out (storage size).
 *
 * The work is done in small steps (about 10 seconds each) so a long history never hits a request time limit: the browser sends the state
 * back and calls the next step until every number is done. The caller's permission is checked by the action before each step.
 * Never logs message text, names, numbers, keys or file links.
 */

const KAPSO = process.env.KAPSO_PLATFORM_URL ?? "https://api.kapso.ai";   // overridable only for the local test harness
const STEP_MS = 10_000;
const MEDIA_TYPES = new Set(["image", "audio", "sticker", "document"]);
const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

export type NumberProgress = {
  pn: string; name: string; phase: "messages" | "media" | "done"; cursor: string | null;
  seen: number; alreadyThere: number; added: number; failed: number; skipped: number;
  filesSeen: number; filesCopied: number; filesFailed: number;
  /** filled when the number is done: what the CRM holds from the chosen day */
  crmMessages?: number; crmConversations?: number;
};
export type SyncState = { from: number; fromDay: string; numbers: NumberProgress[]; current: number; done: boolean; rateLimited?: boolean };

export async function startSync(fromDay: string, from: number): Promise<SyncState> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("whatsapp_accounts").select("phone_number_id, display_name")
    .eq("provider", "kapso").eq("environment", "production").in("status", ["active", "test"]).not("phone_number_id", "is", null).order("display_name");
  if (error) throw error;
  return {
    from, fromDay, current: 0, done: (data ?? []).length === 0,
    numbers: (data ?? []).map((a) => ({
      pn: a.phone_number_id as string, name: a.display_name, phase: "messages", cursor: null,
      seen: 0, alreadyThere: 0, added: 0, failed: 0, skipped: 0, filesSeen: 0, filesCopied: 0, filesFailed: 0,
    })),
  };
}

type Page = { data: Record<string, unknown>[]; next: string | null; retryAfter?: number };

async function listPage(apiKey: string, pn: string, cursor: string | null, media: boolean): Promise<Page> {
  const u = new URL(`${KAPSO}/platform/v1/whatsapp/messages`);
  u.searchParams.set("phone_number_id", pn);
  u.searchParams.set("limit", "100");
  if (media) u.searchParams.set("has_media", "true");
  if (cursor) u.searchParams.set("after", cursor);
  const r = await fetch(u, { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) return { data: [], next: cursor, retryAfter: Number(r.headers.get("retry-after") ?? 60) };
  if (!r.ok) throw new Error(`kapso_http_${r.status}`);
  const j = (await r.json()) as { data?: Record<string, unknown>[]; paging?: { next?: string | null; cursors?: { after?: string | null } } };
  const data = j.data ?? [];
  const next = data.length && j.paging?.next ? (j.paging?.cursors?.after ?? null) : null;
  return { data, next };
}

/** One step of the sync. Returns the new state (the caller loops until state.done). */
export async function syncStep(state: SyncState): Promise<SyncState> {
  const { KAPSO_API_KEY } = serverEnv("kapsoApi");
  const admin = createAdminClient();
  const s: SyncState = structuredClone(state);
  s.rateLimited = false;
  const t0 = Date.now();

  while (!s.done && Date.now() - t0 < STEP_MS) {
    const n = s.numbers[s.current];
    if (!n) { s.done = true; break; }

    if (n.phase === "messages") {
      const items: { row: HistoryRow; cid: string | null }[] = [];
      let reachedStart = false;
      while (Date.now() - t0 < STEP_MS) {
        const page = await listPage(KAPSO_API_KEY, n.pn, n.cursor, false);
        if (page.retryAfter) { s.rateLimited = true; break; }
        for (const m of page.data) {
          const ts = Number(m.timestamp);
          if (Number.isFinite(ts) && ts < s.from) { reachedStart = true; continue; }
          const r = mapKapsoMessage(m);
          if ("skip" in r) { n.skipped++; continue; }
          n.seen++;
          items.push(r);
        }
        n.cursor = page.next;
        if (reachedStart || !page.next) { reachedStart = true; break; }
      }
      const rows = unifyIdentities(items);
      for (let i = 0; i < rows.length; i += 2000) {
        const { data, error } = await admin.rpc("kapso_import_history", { p_phone_number_id: n.pn, p_rows: rows.slice(i, i + 2000) as unknown as Json });
        if (error) throw error;
        const res = data as { inserted: number; duplicate: number; failed: number };
        n.added += res.inserted; n.alreadyThere += res.duplicate; n.failed += res.failed;
      }
      if (reachedStart) { n.phase = "media"; n.cursor = null; }
      if (s.rateLimited) break;
      continue;
    }

    if (n.phase === "media") {
      let reachedStart = false;
      const page = await listPage(KAPSO_API_KEY, n.pn, n.cursor, true);
      if (page.retryAfter) { s.rateLimited = true; break; }
      const wanted = page.data.filter((m) => {
        const ts = Number(m.timestamp);
        if (Number.isFinite(ts) && ts < s.from) { reachedStart = true; return false; }
        return MEDIA_TYPES.has(String(m.type));
      });
      n.filesSeen += wanted.length;
      if (wanted.length) {
        const { data: msgs } = await admin.from("messages").select("id, conversation_id, wa_message_id").in("wa_message_id", wanted.map((m) => String(m.id)));
        const byWamid = new Map((msgs ?? []).map((m) => [m.wa_message_id as string, m]));
        const { data: cached } = await admin.from("message_media_cache").select("message_id").in("message_id", (msgs ?? []).map((m) => m.id));
        const have = new Set((cached ?? []).map((c) => c.message_id));
        for (const m of wanted) {
          if (Date.now() - t0 > STEP_MS + 15_000) break;   // keep the step bounded even with slow downloads
          const msg = byWamid.get(String(m.id));
          if (!msg || have.has(msg.id)) continue;
          const type = String(m.type);
          const part = (m[type] ?? {}) as { id?: string; mime_type?: string };
          const md = ((m.kapso ?? {}) as { media_data?: { url?: string; filename?: string } }).media_data ?? {};
          const file = await fetchKapsoMedia({ apiKey: KAPSO_API_KEY, phoneNumberId: n.pn, mediaId: part.id ?? "", url: md.url ?? null, maxBytes: MEDIA_MAX_BYTES });
          if (!file.ok) { n.filesFailed++; continue; }
          const mimeType = INBOUND_MEDIA_TYPES.has(file.mimeType) ? file.mimeType : "application/octet-stream";
          const path = `inbound/${msg.conversation_id}/${msg.id}/${safeFileName(md.filename ?? part.id ?? "file")}`;
          const up = await admin.storage.from("whatsapp-media").upload(path, file.bytes, { contentType: mimeType, upsert: true });
          if (up.error) { n.filesFailed++; continue; }
          const { error } = await admin.from("message_media_cache").upsert({ message_id: msg.id, storage_path: path, mime_type: mimeType, size_bytes: file.bytes.byteLength });
          if (error) { n.filesFailed++; continue; }
          n.filesCopied++;
        }
      }
      n.cursor = page.next;
      if (reachedStart || !page.next) {
        n.phase = "done"; n.cursor = null;
        // what the CRM now holds for this number from the chosen day (the "check" part)
        const { data: acc } = await admin.from("whatsapp_accounts").select("id").eq("phone_number_id", n.pn).maybeSingle();
        if (acc) {
          const since = new Date(s.from * 1000).toISOString();
          const [mc, cc] = await Promise.all([
            admin.from("messages").select("id, conversation:conversations!inner(whatsapp_account_id)", { count: "exact", head: true })
              .eq("conversation.whatsapp_account_id", acc.id).gte("sent_at", since),
            admin.from("conversations").select("id", { count: "exact", head: true }).eq("whatsapp_account_id", acc.id).gte("last_message_at", since),
          ]);
          n.crmMessages = mc.count ?? undefined; n.crmConversations = cc.count ?? undefined;
        }
        s.current++;
        if (s.current >= s.numbers.length) s.done = true;
      }
      continue;
    }
    s.current++;
    if (s.current >= s.numbers.length) s.done = true;
  }
  return s;
}

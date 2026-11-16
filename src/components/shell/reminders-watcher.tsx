"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useI18n } from "@/components/i18n-provider";
import { dueReminders } from "@/actions/reminders";

const KEY = "crm.reminders.dismissed";
const EVERY_MS = 60_000;

function readSeen(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
}
function writeSeen(v: Record<string, string>) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* the reminder simply shows again next time */ }
}

/**
 * Pops a reminder on the site when one of my tasks / follow-ups has come due: it stays on screen until I close it or open it (so it is not missed),
 * then is not shown again for that due time. Checked when the page opens, every minute, and when the tab comes back into view.
 */
export function RemindersWatcher() {
  const { t } = useI18n();
  const router = useRouter();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    let stop = false;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      let list;
      try { list = await dueReminders(); } catch { return; }
      if (stop) return;
      const seen = readSeen();
      for (const r of list) {
        const mark = `${r.id}@${r.dueAt}`;
        if (seen[r.id] === r.dueAt || shown.current.has(mark)) continue;
        shown.current.add(mark);
        const href = r.leadId ? `/leads/${r.leadId}` : r.contactId ? `/contacts/${r.contactId}` : "/tasks";
        const done = () => writeSeen({ ...readSeen(), [r.id]: r.dueAt });
        toast(`${t.reminders.popup}: ${r.title}`, {
          id: `reminder-${r.id}`,
          description: r.description ?? undefined,
          duration: Infinity,
          closeButton: true,
          onDismiss: done,
          action: { label: t.reminders.open, onClick: () => { done(); router.push(href); } },
        });
      }
    };
    void check();
    const timer = setInterval(() => void check(), EVERY_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { stop = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [router, t]);

  return null;
}

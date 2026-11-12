"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, RefreshCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/app/status-badge";
import { useI18n } from "@/components/i18n-provider";
import { continueHistorySync, startHistorySync } from "@/actions/whatsapp-sync";
import type { SyncState } from "@/server/whatsapp/history-sync";
import { formatNumber } from "@/lib/format.ts";

/**
 * Super admin: check that every chat and message of the real Kapso numbers since a day is in the CRM, and add what is missing.
 * Runs as a series of short steps from the browser (the page shows the progress); closing the page simply stops it, and running it again
 * is safe (nothing is ever stored twice).
 */
export function HistorySync({ defaultFrom }: { defaultFrom: string }) {
  const { t, locale } = useI18n();
  const h = t.historySync;
  const router = useRouter();
  const [from, setFrom] = useState(defaultFrom);
  const [state, setState] = useState<SyncState | null>(null);
  const [running, setRunning] = useState(false);
  const [wait, setWait] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  const n = (v: number | undefined) => formatNumber(v ?? 0, locale);

  const run = async () => {
    setError(null); stop.current = false; setRunning(true);
    try {
      let res = await startHistorySync({ from });
      while (res.ok && !res.data.done && !stop.current) {
        setState(res.data);
        if (res.data.rateLimited) {
          // Kapso asked us to slow down: wait a minute, then continue where we were
          for (let s = 60; s > 0 && !stop.current; s--) { setWait(s); await new Promise((r) => setTimeout(r, 1000)); }
          setWait(0);
        }
        res = await continueHistorySync({ state: res.data });
      }
      if (!res.ok) setError(res.error);
      else { setState(res.data); if (res.data.done) router.refresh(); }
    } catch {
      setError(t.common.errorBody);
    } finally {
      setRunning(false); setWait(0);
    }
  };

  const phase = (p: SyncState["numbers"][number]["phase"]) => p === "messages" ? h.phaseMessages : p === "media" ? h.phaseFiles : h.phaseDone;

  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-card p-4 shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5" data-testid="history-sync">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">{h.title}</h2>
        <p className="text-sm text-muted-foreground">{h.hint}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          {h.from}
          <Input type="date" dir="ltr" className="h-9 w-44" value={from} max={new Date().toISOString().slice(0, 10)} disabled={running}
            onChange={(e) => setFrom(e.target.value)} data-testid="history-sync-from" />
        </label>
        {!running ? (
          <Button onClick={run} disabled={!from} data-testid="history-sync-run"><RefreshCcw />{h.run}</Button>
        ) : (
          <Button variant="outline" onClick={() => { stop.current = true; }} data-testid="history-sync-stop"><Square />{h.stop}</Button>
        )}
        {running && <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{wait ? h.waiting.replace("{s}", String(wait)) : h.running}</span>}
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {state && (
        <div className="relative min-w-0 max-w-full overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[44rem] text-sm" data-testid="history-sync-table">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {[h.number, h.status, h.inKapso, h.alreadyThere, h.added, h.failed, h.files, h.inCrm].map((x) => <th key={x} className="whitespace-nowrap px-3 py-2 text-start font-medium">{x}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y">
              {state.numbers.map((x, i) => (
                <tr key={x.pn}>
                  <td className="px-3 py-2 font-medium">{x.name}</td>
                  <td className="px-3 py-2">
                    {x.phase === "done" ? <StatusBadge tone="success"><CheckCircle2 className="size-3.5" />{phase(x.phase)}</StatusBadge>
                      : <StatusBadge tone={running && i === state.current ? "warning" : "neutral"}>{phase(x.phase)}</StatusBadge>}
                  </td>
                  <td className="ltr-nums px-3 py-2">{n(x.seen)}</td>
                  <td className="ltr-nums px-3 py-2">{n(x.alreadyThere)}</td>
                  <td className="ltr-nums px-3 py-2 font-semibold">{n(x.added)}</td>
                  <td className="ltr-nums px-3 py-2">{n(x.failed)}</td>
                  <td className="ltr-nums px-3 py-2">{n(x.filesCopied)}{x.filesFailed ? ` (${n(x.filesFailed)} ${h.notAvailable})` : ""}</td>
                  <td className="ltr-nums px-3 py-2">{x.crmMessages !== undefined ? `${n(x.crmMessages)} ${h.messages} · ${n(x.crmConversations)} ${h.chats}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state?.done && !running && (
        <p className="text-sm" data-testid="history-sync-done">
          {state.numbers.every((x) => x.failed === 0) ? h.doneAllOk : h.doneWithFailures}
          {" "}{h.totalAdded.replace("{n}", n(state.numbers.reduce((s, x) => s + x.added, 0)))}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{h.note}</p>
    </section>
  );
}

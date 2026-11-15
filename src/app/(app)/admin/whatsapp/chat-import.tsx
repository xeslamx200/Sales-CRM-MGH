"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/components/i18n-provider";
import { importChatExport, type ChatImportResult } from "@/actions/chat-import";
import { parseChatExport, type DateOrder, type ParsedExport } from "@/lib/whatsapp/chat-export";
import { readZipText } from "@/lib/zip";
import { fmt } from "@/i18n";
import { formatNumber } from "@/lib/format";

export type ImportNumber = { id: string; name: string; phone: string; timeZone: string };
const CHUNK = 1000;
const ZONES = ["Asia/Qatar", "Africa/Cairo", "Asia/Dubai", "Asia/Riyadh", "Asia/Kuwait", "Asia/Bahrain", "Europe/London", "UTC"];

/**
 * Super admin: bring a chat that never reached Kapso (an old chat, or one typed on a device that sends nothing) into the CRM from the file
 * WhatsApp makes with "Export chat". Text and times are imported; photos and voice notes only as "media" markers (a text export has no files).
 */
export function ChatImport({ numbers }: { numbers: ImportNumber[] }) {
  const { t, locale } = useI18n();
  const c = t.chatImport;
  const n = (v: number) => formatNumber(v, locale);
  const [accountId, setAccountId] = useState(numbers[0]?.id ?? "");
  const [phone, setPhone] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [order, setOrder] = useState<DateOrder | undefined>(undefined);
  const [business, setBusiness] = useState("");
  const [zone, setZone] = useState(numbers[0]?.timeZone ?? "UTC");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChatImportResult | null>(null);

  const parsed: ParsedExport | null = useMemo(() => (text === null ? null : parseChatExport(text, { order })), [text, order]);
  const account = numbers.find((x) => x.id === accountId);
  const customerSender = parsed?.senders.find((s) => s !== business) ?? "";
  const digits = phone.replace(/\D/g, "");
  const phoneOk = digits.length >= 7 && digits.length <= 15 && !digits.startsWith("0");
  const businessOk = Boolean(parsed && parsed.senders.includes(business));
  const ready = Boolean(parsed && parsed.messages.length > 0 && phoneOk && businessOk && account);

  const pick = async (file: File | undefined) => {
    setError(null); setResult(null); setText(null); setBusiness(""); setOrder(undefined);
    if (!file) return;
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const isZip = /\.zip$/i.test(file.name) || new Uint8Array(buf, 0, 2).join() === "80,75";
      const content = isZip ? (await readZipText(buf))?.text : new TextDecoder("utf-8").decode(buf);
      if (!content) { setError(c.noTextInZip); return; }
      setText(content);
      const p = parseChatExport(content);
      if (p.senders.length === 2) setBusiness("");   // the person must say who the business is: never guessed
      if (p.messages.length === 0) setError(c.nothingFound);
    } catch { setError(c.readFailed); }
  };

  const run = async () => {
    if (!parsed || !account) return;
    setBusy(true); setError(null); setResult(null); setProgress(0);
    const total: ChatImportResult = { inserted: 0, duplicate: 0, failed: 0, conversationId: null };
    try {
      for (let i = 0; i < parsed.messages.length; i += CHUNK) {
        const res = await importChatExport({
          accountId, phone: digits, customerName: (name.trim() || customerSender || null), businessSender: business, timeZone: zone, offset: i,
          messages: parsed.messages.slice(i, i + CHUNK),
        });
        if (!res.ok) { setError(res.error); break; }
        total.inserted += res.data.inserted; total.duplicate += res.data.duplicate; total.failed += res.data.failed; total.conversationId = res.data.conversationId ?? total.conversationId;
        setProgress(Math.min(parsed.messages.length, i + CHUNK));
        if (i + CHUNK >= parsed.messages.length) setResult({ ...total });
      }
    } catch { setError(t.common.errorBody); } finally { setBusy(false); }
  };

  const first = parsed?.messages[0]?.local.replace("T", " ").slice(0, 16);
  const last = parsed?.messages.at(-1)?.local.replace("T", " ").slice(0, 16);
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4" data-testid="chat-import">
      <div>
        <h2 className="font-semibold">{c.title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{c.hint}</p>
        <ol className="mt-2 list-decimal ps-5 text-xs text-muted-foreground">
          <li>{c.step1}</li><li>{c.step2}</li><li>{c.step3}</li>
        </ol>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ci-number">{c.number}</Label>
          <Select value={accountId} onValueChange={(v) => { setAccountId(v); setZone(numbers.find((x) => x.id === v)?.timeZone ?? zone); }}>
            <SelectTrigger id="ci-number" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{numbers.map((x) => <SelectItem key={x.id} value={x.id}>{x.name} · {x.phone}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ci-phone">{c.customerPhone}</Label>
          <Input id="ci-phone" value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" placeholder="97466077722" data-testid="ci-phone" />
          {phone !== "" && !phoneOk && <p className="text-xs text-destructive">{c.phoneInvalid}</p>}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="ci-file">{c.file}</Label>
        <Input id="ci-file" type="file" accept=".txt,.zip,text/plain,application/zip" onChange={(e) => void pick(e.target.files?.[0])} data-testid="ci-file" />
        {fileName && <p className="text-xs text-muted-foreground" dir="ltr">{fileName}</p>}
      </div>
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {parsed && parsed.messages.length > 0 && (
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-3" data-testid="ci-preview">
          <p className="text-sm">
            {fmt(c.found, { n: n(parsed.messages.length), from: first ?? "", to: last ?? "" })}
            {parsed.messages.some((m) => m.media) && <> · {fmt(c.mediaCount, { n: n(parsed.messages.filter((m) => m.media).length) })}</>}
          </p>
          <div className="grid gap-1.5">
            <Label>{c.whoIsBusiness}</Label>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              {parsed.senders.map((s) => (
                <Button key={s} type="button" size="sm" variant={business === s ? "secondary" : "outline"} aria-pressed={business === s} onClick={() => setBusiness(s)} dir="auto" data-testid="ci-sender">
                  {s} <span className="ltr-nums text-xs text-muted-foreground">({n(parsed.messages.filter((m) => m.sender === s).length)})</span>
                </Button>
              ))}
            </div>
            {parsed.senders.length > 2 && <p className="text-xs text-muted-foreground">{c.moreThanTwo}</p>}
          </div>
          {!parsed.orderCertain && (
            <div className="grid gap-1.5">
              <Label>{c.dateOrder}</Label>
              <div className="flex gap-2">
                {(["dmy", "mdy"] as const).map((o) => (
                  <Button key={o} type="button" size="sm" variant={parsed.order === o ? "secondary" : "outline"} aria-pressed={parsed.order === o} onClick={() => setOrder(o)}>
                    {o === "dmy" ? c.dayFirst : c.monthFirst}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{c.dateOrderHint}</p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ci-zone">{c.timeZone}</Label>
              <Select value={zone} onValueChange={setZone}>
                <SelectTrigger id="ci-zone" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{[...new Set([zone, ...ZONES])].map((z) => <SelectItem key={z} value={z}>{z}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{c.timeZoneHint}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ci-name">{c.customerName}</Label>
              <Input id="ci-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={customerSender} dir="auto" maxLength={200} />
            </div>
          </div>
          <ul className="max-h-48 divide-y overflow-auto rounded-md border bg-card text-sm">
            {parsed.messages.slice(0, 6).map((m, i) => (
              <li key={i} className="flex gap-2 px-3 py-1.5">
                <span className="ltr-nums shrink-0 text-xs text-muted-foreground" dir="ltr">{m.local.replace("T", " ").slice(0, 16)}</span>
                <span className={m.sender === business ? "text-primary" : ""} dir="auto"><b>{m.sender}:</b> {m.media ? c.mediaMarker : m.text.slice(0, 160)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void run()} disabled={!ready || busy} data-testid="ci-run">
              {busy ? <Loader2 className="animate-spin" /> : <FileUp />}{c.run}
            </Button>
            {busy && <span className="ltr-nums text-sm text-muted-foreground">{n(progress)} / {n(parsed.messages.length)}</span>}
            {!ready && !busy && <span className="text-xs text-muted-foreground">{!phoneOk ? c.needPhone : c.needBusiness}</span>}
          </div>
        </div>
      )}
      {result && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900" data-testid="ci-done">
          <CheckCircle2 className="size-4" />
          <span>{fmt(c.done, { added: n(result.inserted), already: n(result.duplicate), failed: n(result.failed) })}</span>
          {result.conversationId && <Link href={`/inbox?c=${result.conversationId}`} className="font-medium underline">{c.open}</Link>}
        </div>
      )}
    </section>
  );
}

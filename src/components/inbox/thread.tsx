"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle, ArrowLeftRight, Check, CheckCheck, ChevronDown, Clock, Lock, RotateCw, Send, Smartphone, StickyNote, Target, UserCheck, UserMinus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { Initials } from "@/components/inbox/initials";
import { isAutoMediaDescription } from "@/lib/kapso/media.ts";
import { useI18n } from "@/components/i18n-provider";
import {
  addNote, assignConversation, leadFromConversation, markConversationRead, moveConversationCompany, resendMessage,
  sendMessage, setConversationStatus,
} from "@/actions/inbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format.ts";
import { cn } from "@/lib/utils";
import { fmt } from "@/i18n";
import { VoiceRecorder } from "@/components/inbox/voice-recorder";
import { AttachButton, MessageMedia, TemplateComposer, type MessageMediaInfo, type TemplateOption } from "@/components/inbox/media-and-templates";
import { LeadPanel, type LeadPanelData } from "@/components/inbox/lead-panel";
import type { Enums } from "@/types/database";

export type ThreadMessage = {
  id: string; direction: Enums<"message_direction">; body: string | null; type: string; status: Enums<"message_status">;
  errorCode: string | null; errorMessage: string | null; sentAt: string; sender: string | null; echo: boolean;
  media: MessageMediaInfo | null;
};
export type ThreadNote = { id: string; body: string; at: string; author: string };
type Conversation = {
  id: string; status: Enums<"conversation_status">; ownerId: string | null; ownerName: string | null;
  contactId: string | null; contactName: string; phone: string | null; number: string; unread: number;
  simulated: boolean; sandbox: boolean; lastInboundAt: string | null; companyName: string | null;
  /** The conversation has no customer phone (BSUID only): nothing can be sent to it. */
  bsuidOnly: boolean;
};

const POLL_MS = 15_000;
const UNASSIGN = "__none__";

function StatusIcon({ status }: { status: Enums<"message_status"> }) {
  const { t } = useI18n();
  const label = t.enums.messageStatus[status];
  const cls = "size-3.5";
  switch (status) {
    case "queued": return <Clock className={cls} aria-label={label} />;
    case "sent": return <Check className={cls} aria-label={label} />;
    case "delivered": return <CheckCheck className={cls} aria-label={label} />;
    case "read": return <CheckCheck className={cn(cls, "text-sky-600")} aria-label={label} />;
    case "failed": return <AlertCircle className={cn(cls, "text-destructive")} aria-label={label} />;
    default: return null;
  }
}

export function ConversationThread({
  conversation: c, messages, notes, viewerId, canReply, windowOpen, canAssignOthers, assignees, timeZone,
  lead, moveTargets, templates, credentialError, olderHref = null,
}: {
  conversation: Conversation; messages: ThreadMessage[]; notes: ThreadNote[]; viewerId: string; canReply: boolean;
  windowOpen: boolean; canAssignOthers: boolean; assignees: { value: string; label: string }[]; timeZone: string;
  lead: LeadPanelData | null; moveTargets: { value: string; label: string }[];
  templates: TemplateOption[]; credentialError: boolean; olderHref?: string | null;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [body, setBody] = useState("");
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const requestId = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Opening a conversation clears its unread counter; new messages arrive by polling.
  useEffect(() => {
    if (c.unread > 0) void markConversationRead({ conversationId: c.id });
  }, [c.id, c.unread]);
  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [router]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, notes.length]);

  const ownedByOther = c.ownerId !== null && c.ownerId !== viewerId && !canAssignOthers;
  // Phase 1 of the Kapso Sandbox is receive-only; the database refuses a reply too.
  // A BSUID-only customer has no phone to send to (send.ts and the database refuse as well).
  const composerBlocked = c.sandbox ? t.inbox.sandboxNoSend
    : c.bsuidOnly ? t.inbox.bsuidOnlyNoSend
    : !canReply ? t.inbox.noReplyPermission
    : ownedByOther ? t.inbox.ownedByOther
    : null;

  const send = () => {
    const text = body.trim();
    if (!text) return;
    // Same id for retries of this exact submission → the server never sends twice.
    requestId.current ??= crypto.randomUUID();
    const clientRequestId = requestId.current;
    start(async () => {
      const res = await sendMessage({ conversationId: c.id, body: text, clientRequestId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      requestId.current = null;
      setBody("");
      if (res.data.status === "failed") toast.error(t.inbox.sendFailed);
    });
  };

  const assign = (ownerId: string | null) =>
    start(async () => {
      const res = await assignConversation({ conversationId: c.id, ownerId });
      if (!res.ok) toast.error(res.error);
    });

  const timeline = [
    ...messages.map((m) => ({ kind: "msg" as const, at: m.sentAt, m })),
    ...notes.map((n) => ({ kind: "note" as const, at: n.at, n })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const statusSelect = (
    <Select value={c.status} disabled={pending} onValueChange={(v) => start(async () => {
      const res = await setConversationStatus({ conversationId: c.id, status: v as Enums<"conversation_status"> });
      if (!res.ok) toast.error(res.error);
    })}>
      <SelectTrigger size="sm" className="w-full rounded-full bg-card sm:w-32" aria-label={t.common.status}><SelectValue /></SelectTrigger>
      <SelectContent>
        {(["open", "pending", "resolved"] as const).map((s) => (
          <SelectItem key={s} value={s}>{t.enums.conversationStatus[s]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const ownerControl = canAssignOthers ? (
    <Select value={c.ownerId ?? UNASSIGN} disabled={pending} onValueChange={(v) => assign(v === UNASSIGN ? null : v)}>
      <SelectTrigger size="sm" className="w-full rounded-full bg-card sm:w-44" aria-label={t.common.owner}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGN}>{t.common.unassigned}</SelectItem>
        <SelectSeparator />
        {assignees.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
      </SelectContent>
    </Select>
  ) : c.ownerId === null ? (
    <Button size="sm" variant="outline" className="w-full rounded-full sm:w-auto" disabled={pending} onClick={() => assign(viewerId)}>{t.inbox.claim}</Button>
  ) : c.ownerId === viewerId ? (
    <Button size="sm" variant="ghost" className="w-full rounded-full sm:w-auto" disabled={pending} onClick={() => assign(null)}>{t.inbox.release}</Button>
  ) : (
    <span className="text-xs text-muted-foreground">{fmt(t.inbox.ownedBy, { name: c.ownerName ?? "—" })}</span>
  );
  const createLeadAction = () => start(async () => {
    const res = await leadFromConversation({ conversationId: c.id });
    if (!res.ok) toast.error(res.error);
    else router.refresh();   // the lead panel appears; no navigation needed
  });
  const noteCards = notes.map((n) => (
    <div key={n.id} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
      <p className="mb-0.5 flex items-center gap-1 text-xs font-medium text-amber-900"><StickyNote className="size-3.5" />{n.author}</p>
      <p className="whitespace-pre-wrap break-words">{n.body}</p>
      <p className="mt-0.5 text-[11px] text-amber-800/80">{formatDateTime(n.at, timeZone, locale)}</p>
    </div>
  ));

  return (
    <div className="grid h-[78dvh] max-h-[80vh] gap-3 lg:h-full lg:grid-cols-[minmax(0,1fr)_19rem]">
      {/* ------------------------------------------------------------------ conversation */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:gap-3 sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Initials name={c.contactName} strong className="size-9 sm:size-11" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {c.contactId ? (
                  <Link href={`/contacts/${c.contactId}`} className="truncate font-semibold text-foreground hover:text-primary hover:underline">{c.contactName}</Link>
                ) : <span className="font-semibold">{c.contactName}</span>}
                {c.simulated && <StatusBadge tone="warning">{t.common.simulated}</StatusBadge>}
                {c.sandbox && <StatusBadge tone="warning">{t.common.sandbox}</StatusBadge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {c.phone && <><span className="ltr-nums">{c.phone}</span> · </>}{c.number}{c.companyName && <> · {c.companyName}</>}
              </p>
            </div>
          </div>
          <div className="grid w-full grid-cols-2 items-center gap-2 sm:flex sm:w-auto sm:flex-wrap [&>*]:min-w-0">
            {statusSelect}
            {ownerControl}
          </div>
        </header>

        {/* below lg the details column is hidden: the lead panel and notes stay reachable here */}
        <div className="lg:hidden">
          {lead ? (
            // folded by default on phones: the interest / service form is taller than the chat itself
            <details className="group border-b bg-muted/30">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 truncate">{t.autoLeads.leadPanel} · {lead.title}</span>
                <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <LeadPanel lead={lead} canAssign={canAssignOthers} assignees={assignees} />
            </details>
          ) : (
            <p className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
              {c.ownerId === null && !canAssignOthers ? t.autoLeads.claimToQualify : t.autoLeads.noLead}
            </p>
          )}
        </div>

        <div className="min-h-40 flex-1 space-y-2 overflow-y-auto bg-[#f3f5f9] p-3 sm:p-4">
          {olderHref && <Link href={olderHref} scroll={false} className="mx-auto rounded-full bg-card px-4 py-1.5 text-xs font-medium text-primary shadow-xs ring-1 ring-foreground/10 hover:bg-accent">{t.inbox.showEarlier}</Link>}
          {timeline.length === 0 && <p className="text-center text-sm text-muted-foreground">{t.inbox.noMessages}</p>}
          {timeline.map((item) => item.kind === "note" ? (
            <div key={`n-${item.n.id}`} className="mx-auto max-w-[85%] rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm lg:hidden">
              <p className="mb-0.5 flex items-center gap-1 text-xs font-medium text-amber-900">
                <StickyNote className="size-3.5" />{t.inbox.internalNote} · {item.n.author}
              </p>
              <p className="whitespace-pre-wrap">{item.n.body}</p>
              <p className="mt-0.5 text-[11px] text-amber-800/80">{formatDateTime(item.n.at, timeZone, locale)}</p>
            </div>
          ) : (
            <div key={item.m.id} className={cn("flex", item.m.direction === "inbound" ? "justify-start" : "justify-end")}>
              <div className={cn(
                "max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-xs",
                item.m.direction === "inbound" ? "rounded-ss-md bg-card ring-1 ring-foreground/5" : "rounded-se-md bg-[#fdf0c8]",
                item.m.status === "failed" && "ring-1 ring-destructive/50",
              )}>
                {item.m.direction === "outbound" && (
                  <p className="mb-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    {item.m.echo ? <><Smartphone className="size-3" />{t.inbox.fromPhoneApp}</> : item.m.sender}
                  </p>
                )}
                {item.m.media && <MessageMedia messageId={item.m.id} media={item.m.media} />}
                {item.m.media?.template && (
                  <span className="mb-0.5 inline-block rounded bg-background/70 px-1 text-[10px] text-muted-foreground">{t.inbox.template}: {item.m.media.template}</span>
                )}
                {(item.m.media?.hasFile ? Boolean(item.m.body) && !isAutoMediaDescription(item.m.body) : true) && (
                  // history copied from the phone: Kapso stores a stub with no file, so say so instead of showing its English placeholder text
                  item.m.type === "media_placeholder"
                    ? <p className="text-sm italic text-muted-foreground">{t.inbox.mediaPlaceholder}</p>
                    : <p className="whitespace-pre-wrap break-words" dir="auto">{item.m.body ?? `[${item.m.type}]`}</p>
                )}
                <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                  <span>{formatDateTime(item.m.sentAt, timeZone, locale)}</span>
                  {item.m.direction === "outbound" && <StatusIcon status={item.m.status} />}
                </div>
                {item.m.status === "failed" && (
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-destructive">
                    <span>{t.inbox.failed}{item.m.errorCode && <> (<span className="ltr-nums">{item.m.errorCode}</span>)</>}</span>
                    {!item.m.echo && item.m.type === "text" && (
                      <Button size="xs" variant="outline" disabled={pending || Boolean(composerBlocked)}
                        onClick={() => start(async () => {
                          const res = await resendMessage({ messageId: item.m.id, clientRequestId: crypto.randomUUID() });
                          if (!res.ok) toast.error(res.error);
                          else if (res.data.status === "failed") toast.error(t.inbox.sendFailed);
                        })}>
                        <RotateCw />{t.inbox.resend}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <footer className="border-t bg-card p-3">
          {credentialError && (
            <Alert variant="destructive" className="mb-2">
              <AlertCircle />
              <AlertDescription>{t.inbox.credentialError}</AlertDescription>
            </Alert>
          )}
          <div className="mb-2 flex gap-1.5">
            <Button size="xs" className="rounded-full" variant={mode === "reply" ? "secondary" : "ghost"} onClick={() => setMode("reply")}><Send className="rtl:-scale-x-100" />{t.inbox.reply}</Button>
            <Button size="xs" className="rounded-full" variant={mode === "note" ? "secondary" : "ghost"} onClick={() => setMode("note")}><StickyNote />{t.inbox.internalNote}</Button>
          </div>
          {mode === "reply" ? (
            composerBlocked ? (
              <Alert>
                <Lock />
                <AlertDescription>{composerBlocked}</AlertDescription>
              </Alert>
            ) : !windowOpen ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">{t.inbox.windowClosed}</p>
                <TemplateComposer conversationId={c.id} templates={templates} />
              </div>
            ) : (
              <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
                {!recording && <AttachButton conversationId={c.id} caption={body} disabled={pending} onSent={() => setBody("")} />}
                <Textarea
                  value={body}
                  onChange={(e) => { setBody(e.target.value); requestId.current = null; }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder={t.inbox.replyPlaceholder}
                  rows={2}
                  maxLength={4096}
                  dir="auto"
                  className={`rounded-2xl bg-[#f3f5f9] ${recording ? "hidden" : ""}`}
                  aria-label={t.inbox.reply}
                />
                {body.trim() ? (
                  <Button type="submit" size="icon-lg" className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90" disabled={pending} aria-label={t.inbox.send}>
                    <Send className="rtl:-scale-x-100" />
                  </Button>
                ) : (
                  <VoiceRecorder conversationId={c.id} disabled={pending} onSent={() => undefined} onRecordingChange={setRecording} />
                )}
              </form>
            )
          ) : (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const text = note.trim();
                if (!text) return;
                start(async () => {
                  const res = await addNote({ conversationId: c.id, body: text });
                  if (res.ok) setNote("");
                  else toast.error(res.error);
                });
              }}
            >
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.inbox.notePlaceholder}
                rows={2} maxLength={5000} className="rounded-2xl border-amber-300 bg-amber-50/50" aria-label={t.inbox.internalNote} />
              <Button type="submit" variant="outline" className="rounded-full" disabled={pending || !note.trim()}>{t.inbox.addNote}</Button>
            </form>
          )}
          {mode === "reply" && windowOpen && c.lastInboundAt && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {fmt(t.inbox.windowOpenUntil, { time: formatDateTime(new Date(Date.parse(c.lastInboundAt) + 24 * 3_600_000), timeZone, locale) })}
            </p>
          )}
        </footer>
      </div>

      {/* ------------------------------------------------------------------ customer details (lg and up) */}
      <aside className="hidden min-h-0 flex-col gap-4 overflow-y-auto rounded-2xl bg-card p-4 shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5 lg:flex" aria-label={c.contactName}>
        <div className="flex flex-col items-center gap-1 text-center">
          <Initials name={c.contactName} strong className="size-16 text-xl" />
          <p className="mt-1 break-words text-base font-semibold">{c.contactName}</p>
          <p className="text-xs text-muted-foreground">{c.phone && <><span className="ltr-nums">{c.phone}</span> · </>}{c.number}</p>
          <StatusBadge tone={toneFor(c.status)}>{t.enums.conversationStatus[c.status]}</StatusBadge>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {!lead && <ActionTile icon={Target} label={t.inbox.createLead} disabled={pending} onClick={createLeadAction} />}
          {moveTargets.length > 0 && <MoveDialog conversationId={c.id} targets={moveTargets} />}
          <ActionTile icon={StickyNote} label={t.inbox.addNote} onClick={() => setMode("note")} />
          {!canAssignOthers && c.ownerId === null && <ActionTile icon={UserCheck} label={t.inbox.claim} disabled={pending} onClick={() => assign(viewerId)} />}
          {!canAssignOthers && c.ownerId === viewerId && <ActionTile icon={UserMinus} label={t.inbox.release} disabled={pending} onClick={() => assign(null)} />}
        </div>
        <div className="-mx-4 border-y">
          {lead ? (
            <LeadPanel lead={lead} canAssign={canAssignOthers} assignees={assignees} />
          ) : (
            <p className="bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
              {c.ownerId === null && !canAssignOthers ? t.autoLeads.claimToQualify : t.autoLeads.noLead}
            </p>
          )}
        </div>
        <section className="flex flex-col gap-2" aria-label={t.inbox.internalNote}>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold"><StickyNote className="size-4 text-muted-foreground" />{t.inbox.internalNote}</h3>
          {noteCards.length ? noteCards : <p className="rounded-xl bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground">{t.inbox.notePlaceholder}</p>}
        </section>
      </aside>
    </div>
  );
}

/** Square action button of the details column (also the trigger of the move dialog). Props are spread so it works as a Radix trigger. */
function ActionTile({ icon: Icon, label, className, ...props }: { icon: React.ComponentType<{ className?: string }>; label: string } & React.ComponentProps<"button">) {
  return (
    <button type="button" {...props} className={cn(
      "flex flex-col items-center justify-center gap-1.5 rounded-xl bg-[#f3f5f9] px-2 py-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50",
      className,
    )}>
      <Icon className="size-5 text-primary" />
      <span className="text-center leading-tight">{label}</span>
    </button>
  );
}

function MoveDialog({ conversationId, targets }: { conversationId: string; targets: { value: string; label: string }[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [companyId, setCompanyId] = useState(targets[0]?.value ?? "");
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <ActionTile icon={ArrowLeftRight} label={t.inbox.moveCompany} />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.inbox.moveCompany}</DialogTitle>
          <DialogDescription>{t.inbox.moveHint}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Label htmlFor="move-company">{t.common.company}</Label>
          <Select value={companyId} onValueChange={setCompanyId}>
            <SelectTrigger id="move-company" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{targets.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
          <Label htmlFor="move-reason">{t.common.reason}</Label>
          <Textarea id="move-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} />
        </div>
        <DialogFooter>
          <Button disabled={pending || !reason.trim() || !companyId} onClick={() => start(async () => {
            const res = await moveConversationCompany({ conversationId, companyId, reason });
            if (res.ok) { setOpen(false); toast.success(t.common.saved); }
            else toast.error(res.error);
          })}>{t.inbox.moveCompany}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

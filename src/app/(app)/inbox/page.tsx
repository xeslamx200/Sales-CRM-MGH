import Link from "next/link";
import { ArrowRight, MessageCircle } from "lucide-react";
import { FilterBar } from "@/components/app/filter-bar";
import { Pagination } from "@/components/app/data-table";
import { EmptyState } from "@/components/app/states";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { ConversationThread, type ThreadMessage, type ThreadNote } from "@/components/inbox/thread";
import { Initials } from "@/components/inbox/initials";
import { InboxLive } from "@/components/inbox/live";
import type { LeadPanelData } from "@/components/inbox/lead-panel";
import { getViewer, isManagerOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { matchingContactIds } from "@/server/data/leads";
import { isWithinHours } from "@/server/crm";
import { listMembers, peopleOptions } from "@/server/data/members";
import { oneOf, page as pageParam, str, uuid } from "@/lib/search-params";
import { formatDateTime } from "@/lib/format.ts";
import { Constants, type Enums } from "@/types/database";
import { cn } from "@/lib/utils";

const LIST = "id, company_id, whatsapp_account_id, status, owner_id, last_message_at, last_inbound_at, unread_count, is_simulated, is_sandbox, customer_wa_id, customer_bsuid, contact:contacts!conversations_contact_id_fkey(id, full_name, phone_e164), account:whatsapp_accounts!conversations_whatsapp_account_id_fkey(id, display_name, provider), owner:profiles!conversations_owner_id_fkey(full_name)";

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const supabase = await createClient();
  const selectedId = uuid(sp, "c");
  const status = oneOf(sp, "status", [...Constants.public.Enums.conversation_status, "all"] as const) ?? "active";
  const assignedParam = str(sp, "assigned");
  const assigned = assignedParam === "mine" || assignedParam === "unassigned" ? assignedParam : null;
  const employee = uuid(sp, "assigned");   // a specific employee
  const interest = oneOf(sp, "interest", Constants.public.Enums.lead_interest);
  const offeringFilter = uuid(sp, "offering");
  const account = uuid(sp, "number");
  const q = str(sp, "q");
  const INBOX_PAGE = 100;   // conversations per page: a company can have thousands (imported history), so the list is paged
  const pageNo = pageParam(sp);
  const olderLink = (n: number) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "msgs") next.set(k, v);
    next.set("msgs", String(n));
    return `/inbox?${next.toString()}`;
  };
  const tz = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";

  // RLS decides which conversations exist for this user (number grants,
  // ownership, company role); the filters only narrow that set.
  let query = supabase.from("conversations").select(LIST, { count: "exact" }).in("company_id", viewer.scopeCompanyIds);
  if (status === "active") query = query.in("status", ["open", "pending"]);
  else if (status !== "all") query = query.eq("status", status);
  if (assigned === "mine") query = query.eq("owner_id", viewer.id);
  else if (assigned === "unassigned") query = query.is("owner_id", null);
  else if (employee) query = query.eq("owner_id", employee);
  if (account) query = query.eq("whatsapp_account_id", account);
  if (str(sp, "unread") === "1") query = query.gt("unread_count", 0);
  if (q) {
    const ids = await matchingContactIds(supabase, q);
    query = query.in("contact_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }
  // Interest / offering live on the lead behind each conversation (conversation_leads view; RLS applies).
  if (interest || offeringFilter) {
    let vq = supabase.from("conversation_leads").select("conversation_id").limit(1000);
    if (interest) vq = vq.eq("interest", interest);
    if (offeringFilter) vq = vq.eq("offering_id", offeringFilter);
    const { data: matches } = await vq;
    const ids = (matches ?? []).map((m) => m.conversation_id).filter((x): x is string => Boolean(x));
    query = query.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }
  const [{ data: list, error, count: listTotal }, { data: numbers }, scopeMembers, { data: offeringRows }] = await Promise.all([
    query.order("last_message_at", { ascending: false, nullsFirst: false }).order("id").range((pageNo - 1) * INBOX_PAGE, pageNo * INBOX_PAGE - 1),
    supabase.from("whatsapp_accounts").select("id, display_name").order("display_name"),
    listMembers(supabase, viewer.scopeCompanyIds, { activeOnly: true }),
    supabase.from("company_offerings").select("id, company_id, name, is_active").in("company_id", viewer.scopeCompanyIds)
      .order("is_active", { ascending: false }).order("name"),
  ]);
  if (error) throw error;
  const companyNames = new Map(viewer.companies.map((c) => [c.id, c.name]));
  const multiCompany = viewer.scopeCompanyIds.length > 1;
  const offeringName = new Map((offeringRows ?? []).map((o) => [o.id, o.name]));
  const { data: listLeads } = (list ?? []).length
    ? await supabase.from("conversation_leads").select("conversation_id, interest, offering_id").in("conversation_id", (list ?? []).map((c) => c.id))
    : { data: [] as { conversation_id: string | null; interest: Enums<"lead_interest"> | null; offering_id: string | null }[] };
  // The view's columns are typed nullable; every row has a conversation and an interest.
  const leadOfConversation = new Map((listLeads ?? []).flatMap((l) => (l.conversation_id && l.interest ? [[l.conversation_id, { interest: l.interest, offering_id: l.offering_id }] as const] : [])));

  let thread: React.ReactNode = <EmptyState icon={MessageCircle} title={t.inbox.pickConversation} className="h-full" />;
  let threadIsOpen = false;   // an open conversation draws its own cards; the empty / not-found states sit in one card
  if (selectedId) {
    const { data: conv } = await supabase.from("conversations").select(LIST).eq("id", selectedId).maybeSingle();
    if (!conv) {
      thread = <EmptyState title={t.common.notFoundTitle} description={t.common.notFoundBody} className="h-full" />;
    } else {
      // the latest 200 messages; a long history (imported chats) can be opened 400 more at a time, up to 3,000
      const msgLimit = Math.min(Math.max(Number(str(sp, "msgs")) || 200, 200), 3000);
      const [msgs, notes, grant, members, leadRow, templates, health, convOfferings] = await Promise.all([
        supabase.from("messages").select("id, direction, body, message_type, media, status, error_code, error_message, sent_by, sent_at, sender:profiles!messages_sent_by_fkey(full_name), cache:message_media_cache(mime_type)")
          .eq("conversation_id", conv.id).order("sent_at", { ascending: false }).limit(msgLimit),
        supabase.from("conversation_notes").select("id, body, created_at, author:profiles!conversation_notes_author_id_fkey(full_name)")
          .eq("conversation_id", conv.id).order("created_at", { ascending: true }),
        supabase.from("whatsapp_account_access").select("can_reply")
          .eq("whatsapp_account_id", conv.whatsapp_account_id).eq("user_id", viewer.id).maybeSingle(),
        listMembers(supabase, [conv.company_id], { activeOnly: true }),
        // The lead behind this conversation: its own open lead, else the company's open lead for the same customer.
        supabase.from("conversation_leads").select("lead_id").eq("conversation_id", conv.id).maybeSingle()
          .then(async ({ data: cl }) => {
            if (!cl?.lead_id) return null;
            const { data } = await supabase.from("leads")
              .select("id, title, status, interest, offering_id, offering_source, owner_id, auto_created, archived_at, owner:profiles!leads_owner_id_fkey(full_name)")
              .eq("id", cl.lead_id).maybeSingle();
            return data;
          }),
        supabase.from("whatsapp_templates").select("name, language, body_text, param_count")
          .eq("whatsapp_account_id", conv.whatsapp_account_id).eq("status", "APPROVED").eq("supported", true).order("name"),
        supabase.from("whatsapp_account_health").select("status").eq("whatsapp_account_id", conv.whatsapp_account_id).maybeSingle(),
        supabase.from("company_offerings").select("id, name, is_active").eq("company_id", conv.company_id).order("name"),
      ]);
      const lead: LeadPanelData | null = leadRow ? {
        id: leadRow.id, title: leadRow.title, status: leadRow.status, interest: leadRow.interest,
        offeringId: leadRow.offering_id, offeringSource: leadRow.offering_source as LeadPanelData["offeringSource"],
        ownerId: leadRow.owner_id, ownerName: leadRow.owner?.full_name ?? null, autoCreated: leadRow.auto_created,
        archived: Boolean(leadRow.archived_at),
        offerings: (convOfferings.data ?? []).map((o) => ({ value: o.id, label: o.name, active: o.is_active })),
      } : null;
      // Moving needs manager rights in both companies (enforced by the database).
      const moveTargets = isManagerOf(viewer, conv.company_id)
        ? viewer.companies.filter((x) => x.id !== conv.company_id && x.isSandbox === conv.is_sandbox && isManagerOf(viewer, x.id)).map((x) => ({ value: x.id, label: x.name }))
        : [];
      const companyTz = viewer.companies.find((c) => c.id === conv.company_id)?.timezone ?? tz;
      // Informational only: queue_outbound_message enforces the 24-hour rule.
      const windowOpen = isWithinHours(conv.last_inbound_at, 24);
      const manager = isManagerOf(viewer, conv.company_id);
      const canReply = viewer.isSuperAdmin || Boolean(grant.data?.can_reply);
      threadIsOpen = true;
      thread = (
        <ConversationThread
          key={conv.id}
          conversation={{
            id: conv.id, status: conv.status, ownerId: conv.owner_id, ownerName: conv.owner?.full_name ?? null,
            contactId: conv.contact?.id ?? null, contactName: conv.contact?.full_name ?? "—", phone: conv.contact?.phone_e164 ?? null,
            number: conv.account?.display_name ?? "", unread: conv.unread_count, simulated: conv.is_simulated, sandbox: conv.is_sandbox,
            lastInboundAt: conv.last_inbound_at, bsuidOnly: !conv.customer_wa_id && !(conv.customer_bsuid && conv.account?.provider === "kapso" && !conv.is_sandbox),
            companyName: viewer.companies.length > 1 ? companyNames.get(conv.company_id) ?? null : null,
          }}
          messages={(msgs.data ?? []).reverse().map((m): ThreadMessage => ({
            id: m.id, direction: m.direction, body: m.body, type: m.message_type, status: m.status,
            errorCode: m.error_code, errorMessage: m.error_message, sentAt: m.sent_at,
            sender: m.sender?.full_name ?? null, echo: m.direction === "outbound" && !m.sent_by,
            media: mediaInfo(m.media, m.cache?.mime_type ?? null),
          }))}
          notes={(notes.data ?? []).map((n): ThreadNote => ({ id: n.id, body: n.body, at: n.created_at, author: n.author?.full_name ?? "—" }))}
          viewerId={viewer.id}
          canReply={canReply}
          windowOpen={windowOpen}
          canAssignOthers={manager}
          assignees={peopleOptions(members, conv.company_id)}
          timeZone={companyTz}
          lead={lead}
          templates={(templates.data ?? []).map((x) => ({ name: x.name, language: x.language, body: x.body_text, params: x.param_count }))}
          credentialError={health.data?.status === "error"}
          olderHref={(msgs.data ?? []).length >= msgLimit && msgLimit < 3000 ? olderLink(msgLimit + 400) : null}
          moveTargets={moveTargets}
        />
      );
    }
  }

  // the list with the same filters, without the open conversation (the "back" link on phones)
  const listHref = (() => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "c" && k !== "msgs") next.set(k, v);
    const qs = next.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  })();
  const linkFor = (id: string) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "c") next.set(k, v);
    next.set("c", id);
    return `/inbox?${next.toString()}`;
  };

  // Status pills (MGH design). Each keeps every other filter; "open" is the default view (open + pending).
  const pillHref = (over: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "c") next.set(k, v);
    next.delete("page");   // a different filter starts again at the first page
    for (const [k, v] of Object.entries(over)) { if (v === null) next.delete(k); else next.set(k, v); }
    const qs = next.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  };
  const unassignedView = assigned === "unassigned";
  const pills: { key: string; label: string; href: string; on: boolean }[] = [
    { key: "all", label: t.common.all, href: pillHref({ status: "all", assigned: null }), on: !unassignedView && status === "all" },
    { key: "open", label: t.inbox.tabOpen, href: pillHref({ status: null, assigned: null }), on: !unassignedView && status === "active" },
    { key: "closed", label: t.inbox.tabClosed, href: pillHref({ status: "resolved", assigned: null }), on: !unassignedView && status === "resolved" },
    { key: "unassigned", label: t.common.unassigned, href: pillHref({ assigned: "unassigned" }), on: unassignedView },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* on a phone an open conversation gets the whole screen: the title, tabs and filters come back with "back to the list" */}
      <div className={cn("flex items-center gap-3", selectedId && "max-lg:hidden")}>
        <span className="flex size-10 items-center justify-center rounded-full bg-[#e8f6ec] text-success"><MessageCircle className="size-5" /></span>
        <div>
          <h1 className="text-xl font-semibold">{t.nav.inbox}</h1>
          <p className="text-xs text-muted-foreground">{t.inbox.subtitle}</p>
        </div>
        <div className="ms-auto"><InboxLive /></div>
      </div>
      <div className={cn("flex flex-wrap gap-2", selectedId && "max-lg:hidden")} role="tablist" aria-label={t.common.status}>
        {pills.map((p) => (
          <Link key={p.key} href={p.href} prefetch={false} role="tab" aria-selected={p.on}
            className={cn("rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
              p.on ? "bg-primary text-primary-foreground" : "bg-card text-foreground shadow-xs ring-1 ring-foreground/10 hover:bg-accent")}>
            {p.label}
          </Link>
        ))}
      </div>
      <div className={cn(selectedId && "max-lg:hidden")}><FilterBar filters={[
        { type: "search", name: "q", placeholder: t.inbox.search },
        { type: "select", name: "assigned", label: t.autoLeads.filterEmployee, options: [
          { value: "mine", label: t.common.me }, { value: "unassigned", label: t.common.unassigned },
          ...peopleOptions(scopeMembers),
        ] },
        { type: "select", name: "interest", label: t.autoLeads.filterInterest,
          options: Constants.public.Enums.lead_interest.map((i) => ({ value: i, label: t.enums.leadInterest[i] })) },
        { type: "select", name: "offering", label: t.autoLeads.filterOffering,
          options: (offeringRows ?? []).map((o) => ({ value: o.id, label: multiCompany ? `${o.name} · ${companyNames.get(o.company_id) ?? ""}` : o.name })) },
        { type: "select", name: "number", label: t.inbox.number, options: (numbers ?? []).map((n) => ({ value: n.id, label: n.display_name })) },
        { type: "select", name: "unread", label: t.inbox.unread, allLabel: t.common.all, options: [{ value: "1", label: t.inbox.unreadOnly }] },
      ]} /></div>
      <div className="grid min-h-[70vh] gap-3 lg:grid-cols-[22rem_1fr]">
        {/* Phones and tablets show one pane at a time, like WhatsApp: the list, or the open conversation with a way back to the list. */}
        <aside className={cn("overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5", selectedId && "max-lg:hidden")} aria-label={t.inbox.conversations}>
          {(list ?? []).length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{t.inbox.empty}</p>
          ) : (
            <ul className="max-h-[75vh] divide-y overflow-y-auto">
              {(list ?? []).map((c) => (
                <li key={c.id}>
                  <Link href={linkFor(c.id)} prefetch={false} aria-current={c.id === selectedId ? "page" : undefined}
                    className={cn("flex items-start gap-3 px-3 py-2.5 text-sm hover:bg-muted", c.id === selectedId && "bg-accent")}>
                    <Initials name={c.contact?.full_name ?? "?"} strong={c.id === selectedId} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("truncate", c.unread_count > 0 ? "font-semibold" : "font-medium")}>{c.contact?.full_name}</span>
                      {c.unread_count > 0 && (
                        <span className="ltr-nums rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{c.unread_count}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{c.account?.display_name}</span>
                      <span>·</span>
                      <span>{c.owner?.full_name ?? t.common.unassigned}</span>
                      <StatusBadge tone={toneFor(c.status)}>{t.enums.conversationStatus[c.status]}</StatusBadge>
                      {c.is_simulated && <StatusBadge tone="warning">{t.common.simulated}</StatusBadge>}
                      {c.is_sandbox && <StatusBadge tone="warning">{t.common.sandbox}</StatusBadge>}
                    </div>
                    {(() => {
                      const l = leadOfConversation.get(c.id);
                      if (!l || (l.interest === "unassessed" && !l.offering_id)) return null;
                      return (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          {l.interest !== "unassessed" && <StatusBadge tone={l.interest === "interested" ? "success" : l.interest === "not_interested" ? "neutral" : "warning"}>{t.enums.leadInterest[l.interest]}</StatusBadge>}
                          {l.offering_id && <span className="text-muted-foreground">{offeringName.get(l.offering_id) ?? t.autoLeads.unknownOffering}</span>}
                        </div>
                      );
                    })()}
                    {c.last_message_at && <span className="text-xs text-muted-foreground">{formatDateTime(c.last_message_at, tz, locale)}</span>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {(listTotal ?? 0) > INBOX_PAGE && (
            <div className="border-t p-3"><Pagination page={pageNo} pageSize={INBOX_PAGE} total={listTotal ?? 0} searchParams={sp} basePath="/inbox" t={t} /></div>
          )}
        </aside>
        <section className={cn("min-w-0", !threadIsOpen && "overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(11,31,68,0.06),0_4px_16px_rgba(11,31,68,0.04)] ring-1 ring-foreground/5", !selectedId && "max-lg:hidden")}>
          {selectedId && (
            <Link href={listHref} className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-sm font-medium shadow-xs ring-1 ring-foreground/10 hover:bg-accent lg:hidden" data-testid="back-to-list">
              <ArrowRight className="size-4 ltr:rotate-180" />{t.inbox.backToList}
            </Link>
          )}
          {thread}
        </section>
      </div>
    </div>
  );
}

/** Display-safe subset of a message's media JSON (no storage paths or Meta ids reach the browser). */
function mediaInfo(media: unknown, cachedMime: string | null) {
  if ((!media || typeof media !== "object") && !cachedMime) return null;
  // A file copied from the history has a cache row but no media JSON on the message
  const m = (media && typeof media === "object" ? media : {}) as {
    id?: string; storage_path?: string; mime_type?: string; mimeType?: string; filename?: string; template?: { name?: string };
    kind?: string; voice?: boolean; transcript?: string;
  };
  return {
    filename: typeof m.filename === "string" && m.filename ? m.filename : null,
    mimeType: cachedMime ?? m.mime_type ?? m.mimeType ?? null,
    template: m.template?.name ?? null,
    hasFile: Boolean(cachedMime || m.storage_path || m.id),
    kind: typeof m.kind === "string" ? m.kind : null,
    voice: m.voice === true,
    transcript: typeof m.transcript === "string" && m.transcript ? m.transcript : null,
  };
}

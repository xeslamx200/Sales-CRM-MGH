import Link from "next/link";
import { ReminderDialog } from "@/components/crm/reminder-dialog";
import { notFound } from "next/navigation";
import { CalendarPlus, NotebookPen, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DetailList, PageHeader, Section } from "@/components/app/page-header";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { ContactCompanyDialog, ContactEditDialog } from "@/components/crm/contact-forms";
import { ActivityDialog, TaskDialog } from "@/components/crm/record-actions";
import { getViewer, isManagerOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { listMembers, peopleOptions } from "@/server/data/members";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format.ts";

export default async function ContactPage({ params }: PageProps<"/contacts/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const supabase = await createClient();
  const { data: contact } = await supabase.from("contacts").select("*").eq("id", id).maybeSingle();
  if (!contact) notFound();

  // Everything below is company-specific and filtered by RLS: a user of
  // company A never sees company B's notes, leads or conversations.
  const [links, leads, convs] = await Promise.all([
    supabase.from("contact_companies").select("id, company_id, relationship, owner_id, notes, owner:profiles!contact_companies_owner_id_fkey(full_name)").eq("contact_id", id),
    supabase.from("leads").select("id, company_id, title, status, created_at").eq("contact_id", id).order("created_at", { ascending: false }),
    supabase.from("conversations").select("id, company_id, status, last_message_at, unread_count, account:whatsapp_accounts!conversations_whatsapp_account_id_fkey(display_name)").eq("contact_id", id),
  ]);
  // every booking this customer has (RLS shows what the viewer may see), with the workshop and group names
  const bookings = await supabase.from("workshop_bookings")
    .select("id, company_id, offering_id, group_id, booking_kind, session_date, final_price, currency, status, payment_mode, remind_on, created_at")
    .eq("contact_id", id).order("created_at", { ascending: false });
  const bks = bookings.data ?? [];
  const [bkOfferings, bkGroups] = await Promise.all([
    bks.length ? supabase.from("company_offerings").select("id, name").in("id", [...new Set(bks.map((x) => x.offering_id))]) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    bks.length ? supabase.from("workshop_groups").select("id, name").in("id", [...new Set(bks.map((x) => x.group_id))]) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const offeringName = new Map((bkOfferings.data ?? []).map((o) => [o.id, o.name]));
  const groupName = new Map((bkGroups.data ?? []).map((g) => [g.id, g.name]));
  const bt = t.bookings;
  const companyIds = [...new Set((links.data ?? []).map((l) => l.company_id))];
  const members = await listMembers(supabase, companyIds, { activeOnly: true });
  const companyName = new Map(viewer.companies.map((c) => [c.id, c.name]));
  const tzOf = (cid: string) => viewer.companies.find((c) => c.id === cid)?.timezone ?? "UTC";
  const firstCompany = (links.data ?? []).find((l) => viewer.scopeCompanyIds.includes(l.company_id))?.company_id ?? companyIds[0];

  return (
    <>
      <PageHeader
        title={contact.full_name}
        description={contact.phone_e164 ? <span className="ltr-nums">{contact.phone_e164}</span> : undefined}
        actions={!contact.merged_into_id && firstCompany && (
          <>
            <ActivityDialog companyId={firstCompany} contactId={contact.id}
              trigger={<Button variant="outline" size="sm"><NotebookPen />{t.records.logActivity}</Button>} />
            <ReminderDialog companyId={firstCompany} contactId={contact.id} name={contact.full_name} />
            <TaskDialog companyId={firstCompany} contactId={contact.id}
              assignees={Object.fromEntries(companyIds.map((cid) => [cid, peopleOptions(members, cid)]))} defaultAssignee={viewer.id}
              trigger={<Button variant="outline" size="sm"><CalendarPlus />{t.records.newTask}</Button>} />
          </>
        )}
      />
      {contact.merged_into_id && (
        <Alert>
          <AlertDescription>
            {t.contacts.mergedInto} <Link href={`/contacts/${contact.merged_into_id}`} className="text-primary underline">{t.common.view}</Link>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Section title={t.nav.leads}>
            {(leads.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{t.common.noResults}</p> : (
              <ul className="divide-y text-sm">
                {(leads.data ?? []).map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 py-2">
                    <Link href={`/leads/${l.id}`} className="text-primary hover:underline">{l.title}</Link>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {companyName.get(l.company_id)}
                      <StatusBadge tone={toneFor(l.status)}>{t.enums.leadStatus[l.status]}</StatusBadge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={t.contacts.bookingsTitle}>
            {bks.length === 0 ? <p className="text-sm text-muted-foreground">{t.common.noResults}</p> : (
              <ul className="divide-y text-sm" data-testid="contact-bookings">
                {bks.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <Link href={`/bookings/${k.id}`} className="text-primary hover:underline">{offeringName.get(k.offering_id) ?? "—"} · {groupName.get(k.group_id) ?? "—"}</Link>
                      <span className="block text-xs text-muted-foreground">
                        {k.booking_kind === "session" ? `${bt.kindSession}${k.session_date ? ` · ${formatDate(k.session_date, "UTC", locale)}` : ""}` : bt.kindFull}
                        {" · "}{k.payment_mode === "deposit" ? bt.payDeposit : bt.payFull}
                        {k.payment_mode === "deposit" && k.remind_on ? ` · ${bt.remindLabel}: ${formatDate(k.remind_on, "UTC", locale)}` : ""}
                        {" · "}{formatDate(k.created_at, tzOf(k.company_id), locale)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className="ltr-nums font-medium">{formatCurrency(Number(k.final_price), k.currency, locale)}</span>
                      <StatusBadge tone={toneFor(k.status)}>{bt.bookingStatus[k.status as keyof typeof bt.bookingStatus] ?? k.status}</StatusBadge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={t.contacts.conversations}>
            {(convs.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{t.common.noResults}</p> : (
              <ul className="divide-y text-sm">
                {(convs.data ?? []).map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                    <Link href={`/inbox?c=${c.id}`} className="text-primary hover:underline">{c.account?.display_name}</Link>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {c.last_message_at && formatDateTime(c.last_message_at, tzOf(c.company_id), locale)}
                      <StatusBadge tone={toneFor(c.status)}>{t.enums.conversationStatus[c.status]}</StatusBadge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="flex flex-col gap-4">
          <Section
            title={t.contacts.identity}
            actions={!contact.merged_into_id && (
              <ContactEditDialog
                contact={{ id: contact.id, fullName: contact.full_name, phone: contact.phone_e164, email: contact.email }}
                trigger={<Button variant="ghost" size="icon-sm" aria-label={t.common.edit}><Pencil /></Button>}
              />
            )}
          >
            <DetailList items={[
              { label: t.common.fullName, value: contact.full_name },
              { label: t.common.phone, value: contact.phone_e164 ? <span className="ltr-nums">{contact.phone_e164}</span> : null },
              { label: t.common.email, value: contact.email ? <span dir="ltr">{contact.email}</span> : null },
              { label: t.common.createdAt, value: formatDateTime(contact.created_at, tzOf(firstCompany ?? ""), locale) },
            ]} />
          </Section>
          {(links.data ?? []).map((l) => {
            const canEdit = isManagerOf(viewer, l.company_id) || l.owner_id === viewer.id;
            return (
              <Section
                key={l.id}
                title={companyName.get(l.company_id) ?? t.common.company}
                actions={canEdit && !contact.merged_into_id && (
                  <ContactCompanyDialog
                    link={{ id: l.id, relationship: l.relationship, ownerId: l.owner_id, notes: l.notes }}
                    owners={peopleOptions(members, l.company_id)}
                    companyName={companyName.get(l.company_id) ?? ""}
                    trigger={<Button variant="ghost" size="icon-sm" aria-label={t.common.edit}><Pencil /></Button>}
                  />
                )}
              >
                <DetailList items={[
                  { label: t.contacts.relationship, value: t.enums.relationship[l.relationship] },
                  { label: t.common.owner, value: l.owner?.full_name ?? t.common.unassigned },
                ]} />
                {l.notes && <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-2 text-sm">{l.notes}</p>}
              </Section>
            );
          })}
        </div>
      </div>
    </>
  );
}

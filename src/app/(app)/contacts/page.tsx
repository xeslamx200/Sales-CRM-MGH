import Link from "next/link";
import { Copy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { DataTable, Pagination } from "@/components/app/data-table";
import { FilterBar } from "@/components/app/filter-bar";
import { StatusBadge } from "@/components/app/status-badge";
import { ContactCreateDialog } from "@/components/crm/contact-forms";
import { getViewer, isAnyManager } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { matchingContactIds, PAGE_SIZE } from "@/server/data/leads";
import { oneOf, page as pageParam, str } from "@/lib/search-params";
import { formatDate } from "@/lib/format.ts";
import { Constants } from "@/types/database";

export default async function ContactsPage({ searchParams }: PageProps<"/contacts">) {
  const viewer = await getViewer();
  const { t, locale } = viewer;
  const sp = await searchParams;
  const supabase = await createClient();
  const page = pageParam(sp);
  const q = str(sp, "q");
  const relationship = oneOf(sp, "relationship", Constants.public.Enums.contact_relationship);
  const owner = str(sp, "owner");
  const tz = viewer.activeCompany?.timezone ?? viewer.companies[0]?.timezone ?? "UTC";

  // One row per (contact, company) relationship visible to the user (RLS).
  let query = supabase.from("contact_companies")
    .select("id, company_id, relationship, created_at, contact:contacts!contact_companies_contact_id_fkey!inner(id, full_name, phone_e164, email, merged_into_id), owner:profiles!contact_companies_owner_id_fkey(full_name)", { count: "exact" })
    .in("company_id", viewer.scopeCompanyIds)
    .is("contact.merged_into_id", null);
  if (relationship) query = query.eq("relationship", relationship);
  if (owner === "me") query = query.eq("owner_id", viewer.id);
  else if (owner === "unassigned") query = query.is("owner_id", null);
  if (q) {
    const ids = await matchingContactIds(supabase, q);
    const email = q.includes("@") ? q.toLowerCase() : null;
    if (email) {
      const { data: byEmail } = await supabase.from("contacts").select("id").eq("email", email).limit(50);
      ids.push(...(byEmail ?? []).map((c) => c.id));
    }
    query = query.in("contact_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }
  const { data, count, error } = await query.order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error) throw error;

  const companyName = new Map(viewer.companies.map((c) => [c.id, c.name]));
  const scopeCompanies = viewer.companies.filter((c) => viewer.scopeCompanyIds.includes(c.id));
  return (
    <>
      <PageHeader
        title={t.nav.contacts}
        actions={
          <>
            {isAnyManager(viewer) && (
              <Button variant="outline" asChild><Link href="/contacts/duplicates"><Copy />{t.nav.duplicates}</Link></Button>
            )}
            {scopeCompanies.length > 0 && (
              <ContactCreateDialog
                companies={scopeCompanies.map((c) => ({ value: c.id, label: c.name }))}
                defaultCompanyId={viewer.activeCompany?.id ?? scopeCompanies[0].id}
                trigger={<Button><Plus />{t.contacts.newContact}</Button>}
              />
            )}
          </>
        }
      />
      <FilterBar filters={[
        { type: "search", name: "q", placeholder: t.contacts.searchPlaceholder },
        { type: "select", name: "relationship", label: t.contacts.relationship,
          options: Constants.public.Enums.contact_relationship.map((r) => ({ value: r, label: t.enums.relationship[r] })) },
        { type: "select", name: "owner", label: t.common.owner, options: [
          { value: "me", label: t.common.me }, { value: "unassigned", label: t.common.unassigned },
        ] },
      ]} />
      <DataTable
        rows={data ?? []}
        rowKey={(r) => r.id}
        empty={{ title: t.contacts.empty }}
        columns={[
          { key: "name", header: t.common.name, cell: (r) => <Link href={`/contacts/${r.contact.id}`} className="font-medium text-primary hover:underline">{r.contact.full_name}</Link> },
          { key: "phone", header: t.common.phone, cell: (r) => r.contact.phone_e164 ? <span className="ltr-nums">{r.contact.phone_e164}</span> : "—" },
          { key: "email", header: t.common.email, cell: (r) => r.contact.email ? <span dir="ltr" className="text-xs">{r.contact.email}</span> : "—" },
          ...(viewer.scopeCompanyIds.length > 1 ? [{ key: "company", header: t.common.company, cell: (r: NonNullable<typeof data>[number]) => companyName.get(r.company_id) }] : []),
          { key: "rel", header: t.contacts.relationship, cell: (r) => <StatusBadge>{t.enums.relationship[r.relationship]}</StatusBadge> },
          { key: "owner", header: t.common.owner, cell: (r) => r.owner?.full_name ?? <span className="text-muted-foreground">{t.common.unassigned}</span> },
          { key: "created", header: t.common.createdAt, cell: (r) => <span className="text-xs">{formatDate(r.created_at, tz, locale)}</span> },
        ]}
      />
      <Pagination page={page} pageSize={PAGE_SIZE} total={count ?? 0} searchParams={sp} basePath="/contacts" t={t} />
    </>
  );
}

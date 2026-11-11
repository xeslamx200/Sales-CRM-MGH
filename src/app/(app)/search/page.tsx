import Link from "next/link";
import { Contact, SearchX, Target } from "lucide-react";
import { PageHeader, Section } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { StatusBadge, toneFor } from "@/components/app/status-badge";
import { entityHref } from "@/components/shell/entity-href";
import { getViewer } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { str } from "@/lib/search-params";
import { fmt } from "@/i18n";

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const viewer = await getViewer();
  const { t } = viewer;
  const q = str(await searchParams, "q") ?? "";
  const supabase = await createClient();
  // RLS-safe: the RPC runs as the user (security invoker).
  const { data, error } = q.length >= 2
    ? await supabase.rpc("global_search", { p_query: q, p_company_ids: viewer.scopeCompanyIds, p_limit: 20 })
    : { data: [], error: null };
  if (error) throw error;
  const rows = data ?? [];
  const companyName = new Map(viewer.companies.map((c) => [c.id, c.name]));
  const groups = [
    { type: "contact", title: t.nav.contacts, icon: Contact },
    { type: "lead", title: t.nav.leads, icon: Target },
  ] as const;

  return (
    <>
      <PageHeader title={t.search.title} description={q ? fmt(t.search.resultsFor, { q }) : undefined} />
      {rows.length === 0 ? (
        <EmptyState icon={SearchX} title={q.length < 2 ? t.search.tooShort : t.search.empty} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {groups.map((g) => {
            const items = rows.filter((r) => r.entity_type === g.type);
            return (
              <Section key={g.type} title={<span className="flex items-center gap-2"><g.icon className="size-4" />{g.title} <span className="ltr-nums text-muted-foreground">({items.length})</span></span>}>
                {items.length === 0 ? <p className="text-sm text-muted-foreground">{t.common.noResults}</p> : (
                  <ul className="divide-y text-sm">
                    {items.map((r) => (
                      <li key={r.entity_id} className="py-2">
                        <Link href={entityHref(r.entity_type, r.entity_id) ?? "#"} className="font-medium text-primary hover:underline">{r.title}</Link>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {r.subtitle && <span className={r.entity_type === "contact" ? "ltr-nums" : undefined}>{r.subtitle}</span>}
                          {r.company_id && viewer.scopeCompanyIds.length > 1 && <span>{companyName.get(r.company_id)}</span>}
                          {r.status && (
                            <StatusBadge tone={toneFor(r.status)}>
                              {t.enums.leadStatus[r.status as keyof typeof t.enums.leadStatus]}
                            </StatusBadge>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            );
          })}
        </div>
      )}
    </>
  );
}

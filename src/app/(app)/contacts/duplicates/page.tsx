import { notFound } from "next/navigation";
import { CopyCheck } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { DuplicateActions } from "@/components/crm/duplicate-actions";
import { getViewer, isAnyManager } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { formatDate } from "@/lib/format.ts";

export default async function DuplicatesPage() {
  const viewer = await getViewer();
  if (!isAnyManager(viewer)) notFound();
  const { t, locale } = viewer;
  const supabase = await createClient();
  // RLS: only reviews where both contacts are visible to the user.
  const { data, error } = await supabase.from("contact_duplicate_reviews")
    .select("id, reason, created_at, a:contacts!contact_duplicate_reviews_contact_a_id_fkey(id, full_name, phone_e164, email, created_at), b:contacts!contact_duplicate_reviews_contact_b_id_fkey(id, full_name, phone_e164, email, created_at)")
    .eq("status", "pending").order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  const tz = viewer.activeCompany?.timezone ?? "UTC";

  return (
    <>
      <PageHeader title={t.duplicates.title} description={t.duplicates.hint} />
      {(data ?? []).length === 0 ? (
        <EmptyState icon={CopyCheck} title={t.duplicates.empty} />
      ) : (
        <div className="flex flex-col gap-3">
          {(data ?? []).map((r) => (
            <section key={r.id} className="rounded-lg border bg-card p-4">
              <p className="mb-3 text-sm text-muted-foreground">
                {r.reason === "same_email" ? t.duplicates.sameEmail : t.duplicates.sameName} · {formatDate(r.created_at, tz, locale)}
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {[r.a, r.b].map((c) => c && (
                  <div key={c.id} className="rounded-md border p-3 text-sm">
                    <a href={`/contacts/${c.id}`} className="font-medium text-primary hover:underline">{c.full_name}</a>
                    <p className="ltr-nums text-muted-foreground">{c.phone_e164 ?? "—"}</p>
                    <p dir="ltr" className="text-start text-xs text-muted-foreground">{c.email ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{t.common.createdAt}: {formatDate(c.created_at, tz, locale)}</p>
                  </div>
                ))}
              </div>
              {r.a && r.b && (
                <DuplicateActions reviewId={r.id} a={{ id: r.a.id, name: r.a.full_name }} b={{ id: r.b.id, name: r.b.full_name }} />
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

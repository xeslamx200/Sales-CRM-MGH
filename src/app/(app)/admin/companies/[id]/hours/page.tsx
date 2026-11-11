import { notFound } from "next/navigation";
import { PageHeader, Section } from "@/components/app/page-header";
import { getViewer, isAdminOf } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { formatDate } from "@/lib/format.ts";
import { HolidayForm, HolidayRemoveButton, HoursEditor, type Interval } from "./hours-editor";

/** Company business hours and holidays (company admins). Used for business-hours response times. */
export default async function BusinessHoursPage({ params }: PageProps<"/admin/companies/[id]/hours">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const viewer = await getViewer();
  if (!isAdminOf(viewer, id)) notFound();
  const { t, locale } = viewer;
  const supabase = await createClient();
  const [company, hours, holidays] = await Promise.all([
    supabase.from("companies").select("id, name, timezone").eq("id", id).maybeSingle(),
    supabase.from("company_business_hours").select("weekday, opens, closes").eq("company_id", id).order("weekday").order("opens"),
    supabase.from("company_holidays").select("day, name").eq("company_id", id).order("day", { ascending: false }).limit(60),
  ]);
  if (!company.data) notFound();
  const intervals: Interval[] = (hours.data ?? []).map((h) => ({ weekday: h.weekday, opens: h.opens.slice(0, 5), closes: h.closes.slice(0, 5) }));

  return (
    <>
      <PageHeader title={`${t.hours.title} · ${company.data.name}`} description={t.hours.hint.replace("{tz}", company.data.timezone)} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title={t.hours.weekly} className="lg:col-span-2">
          <HoursEditor companyId={id} initial={intervals} />
        </Section>
        <Section title={t.hours.holidays}>
          <div className="flex flex-col gap-3">
            <HolidayForm companyId={id} />
            {(holidays.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{t.hours.noHolidays}</p> : (
              <ul className="flex flex-col divide-y text-sm">
                {(holidays.data ?? []).map((h) => (
                  <li key={h.day} className="flex items-center justify-between gap-2 py-1.5">
                    <div>
                      <p className="font-medium">{h.name}</p>
                      <p className="ltr-nums text-xs text-muted-foreground">{formatDate(`${h.day}T12:00:00Z`, "UTC", locale)}</p>
                    </div>
                    <HolidayRemoveButton companyId={id} day={h.day} name={h.name} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      </div>
    </>
  );
}

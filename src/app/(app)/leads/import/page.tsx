import { PageHeader } from "@/components/app/page-header";
import { getViewer } from "@/server/auth/viewer";
import { ImportWizard } from "./import-wizard";

export default async function ImportLeadsPage() {
  const viewer = await getViewer();
  const { t } = viewer;
  const companies = viewer.companies.filter((c) => viewer.scopeCompanyIds.includes(c.id));
  return (
    <>
      <PageHeader title={t.import.title} description={t.import.hint} />
      <ImportWizard
        companies={companies.map((c) => ({ value: c.id, label: c.name }))}
        defaultCompanyId={viewer.activeCompany?.id ?? companies[0]?.id ?? ""}
      />
    </>
  );
}

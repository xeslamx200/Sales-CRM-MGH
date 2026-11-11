import { notFound } from "next/navigation";
import { Plus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { getViewer, isAdminOf, isAnyAdmin } from "@/server/auth/viewer";
import { createClient } from "@/server/supabase/server";
import { NewPipelineDialog, PipelineActions, StageDialog, StageMoveButtons } from "./pipeline-forms";

export default async function PipelinesPage() {
  const viewer = await getViewer();
  if (!isAnyAdmin(viewer)) notFound();
  const { t } = viewer;
  const companies = viewer.companies.filter((c) => viewer.scopeCompanyIds.includes(c.id) && isAdminOf(viewer, c.id));
  const supabase = await createClient();
  const { data, error } = await supabase.from("pipelines")
    .select("id, company_id, name, kind, is_default, is_active, stages:pipeline_stages(id, name, position, stage_type, probability, is_active)")
    .in("company_id", companies.map((c) => c.id)).eq("kind", "lead").order("is_active", { ascending: false }).order("kind").order("name");
  if (error) throw error;
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  return (
    <>
      <PageHeader
        title={t.pipelines.title}
        description={t.pipelines.hint}
        actions={companies.length > 0 && (
          <NewPipelineDialog companies={companies.map((c) => ({ value: c.id, label: c.name }))}
            trigger={<Button><Plus />{t.pipelines.newPipeline}</Button>} />
        )}
      />
      {(data ?? []).length === 0 ? <EmptyState icon={Workflow} title={t.common.noResults} /> : (
        <div className="grid gap-4 xl:grid-cols-2">
          {(data ?? []).map((p) => {
            const stages = [...p.stages].sort((a, b) => a.position - b.position);
            return (
              <section key={p.id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="flex flex-wrap items-center gap-2 font-semibold">
                      {p.name}
                      <StatusBadge>{t.pipelines.kinds.lead}</StatusBadge>
                      {p.is_default && <StatusBadge tone="primary">{t.pipelines.default}</StatusBadge>}
                      {!p.is_active && <StatusBadge>{t.common.inactive}</StatusBadge>}
                    </h2>
                    {companies.length > 1 && <p className="text-xs text-muted-foreground">{companyName.get(p.company_id)}</p>}
                  </div>
                  <PipelineActions pipeline={{ id: p.id, name: p.name, isActive: p.is_active, isDefault: p.is_default }} />
                </div>
                <ol className="flex flex-col divide-y rounded-md border text-sm">
                  {stages.map((s, i) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="ltr-nums w-5 text-xs text-muted-foreground">{i + 1}</span>
                        <span className={s.is_active ? "font-medium" : "text-muted-foreground line-through"}>{s.name}</span>
                        <StatusBadge tone={s.stage_type === "won" ? "success" : s.stage_type === "lost" ? "danger" : "info"}>
                          {t.enums.stageType[s.stage_type]}
                        </StatusBadge>
                        {s.probability != null && <span className="ltr-nums text-xs text-muted-foreground">{s.probability}%</span>}
                      </div>
                      <div className="flex items-center gap-0.5">
                        <StageMoveButtons pipelineId={p.id} order={stages.map((x) => x.id)} index={i} />
                        <StageDialog pipelineId={p.id} companyId={p.company_id}
                          stage={{ id: s.id, name: s.name, stageType: s.stage_type, probability: s.probability, isActive: s.is_active }} />
                      </div>
                    </li>
                  ))}
                </ol>
                <div><StageDialog pipelineId={p.id} companyId={p.company_id} /></div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

"use client";
import { useTransition } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Star } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { DialogFooter } from "@/components/ui/dialog";
import { CheckboxField, FormError, SelectField, SubmitButton, TextField, type Option } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { FormDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { createPipeline, reorderStages, saveStage, setDefaultPipeline, updatePipeline } from "@/actions/pipelines";
import type { Enums } from "@/types/database";

const newSchema = z.object({ companyId: z.uuid(), name: z.string().trim().min(1).max(120), kind: z.enum(["lead"]) });
const editSchema = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120), isActive: z.boolean() });
const stageSchema = z.object({
  id: z.uuid().optional(), pipelineId: z.uuid(), companyId: z.uuid(), name: z.string().trim().min(1).max(120),
  stageType: z.enum(["open", "won", "lost"]), probability: z.coerce.number().int().min(0).max(100).nullable().optional(),
  isActive: z.boolean(),
});

type Pipeline = { id: string; name: string; isActive: boolean; isDefault: boolean };
type Stage = { id: string; name: string; stageType: Enums<"stage_type">; probability: number | null; isActive: boolean };

export function NewPipelineDialog({ companies, trigger }: { companies: Option[]; trigger: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <FormDialog trigger={trigger} title={t.pipelines.newPipeline} description={t.pipelines.newHint}>
      {(close) => <NewPipelineForm companies={companies} onDone={close} />}
    </FormDialog>
  );
}

function NewPipelineForm({ companies, onDone }: { companies: Option[]; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: newSchema,
    defaultValues: { companyId: companies[0]?.value ?? "", name: "", kind: "lead" },
    action: createPipeline, successMessage: t.common.saved, onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        {companies.length > 1 && <SelectField control={form.control} name="companyId" label={t.common.company} options={companies} />}
        <TextField control={form.control} name="name" label={t.common.name} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.create}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

export function PipelineActions({ pipeline }: { pipeline: Pipeline }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-1">
      {!pipeline.isDefault && pipeline.isActive && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
          const res = await setDefaultPipeline({ pipelineId: pipeline.id });
          if (res.ok) toast.success(t.common.saved);
          else toast.error(res.error);
        })}>
          <Star />{t.pipelines.makeDefault}
        </Button>
      )}
      <FormDialog trigger={<Button variant="ghost" size="icon-sm" aria-label={t.common.edit}><Pencil /></Button>} title={t.pipelines.editPipeline}>
        {(close) => <PipelineEditForm pipeline={pipeline} onDone={close} />}
      </FormDialog>
    </div>
  );
}

function PipelineEditForm({ pipeline, onDone }: { pipeline: Pipeline; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: editSchema,
    defaultValues: { id: pipeline.id, name: pipeline.name, isActive: pipeline.isActive },
    action: updatePipeline, successMessage: t.common.saved, onSuccess: onDone,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="name" label={t.common.name} />
        <CheckboxField control={form.control} name="isActive" label={t.common.active} disabled={pipeline.isDefault}
          description={pipeline.isDefault ? t.pipelines.defaultStaysActive : undefined} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

export function StageDialog({ pipelineId, companyId, stage }: { pipelineId: string; companyId: string; stage?: Stage }) {
  const { t } = useI18n();
  return (
    <FormDialog
      trigger={stage
        ? <Button variant="ghost" size="icon-xs" aria-label={t.common.edit}><Pencil /></Button>
        : <Button variant="outline" size="sm"><Plus />{t.pipelines.addStage}</Button>}
      title={stage ? t.pipelines.editStage : t.pipelines.addStage}
      description={t.pipelines.stageHint}
    >
      {(close) => <StageForm pipelineId={pipelineId} companyId={companyId} stage={stage} onDone={close} />}
    </FormDialog>
  );
}

function StageForm({
  pipelineId, companyId, stage, onDone,
}: { pipelineId: string; companyId: string; stage?: Stage; onDone: () => void }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: stageSchema,
    defaultValues: {
      id: stage?.id, pipelineId, companyId, name: stage?.name ?? "", stageType: stage?.stageType ?? "open",
      probability: stage?.probability ?? null, isActive: stage?.isActive ?? true,
    },
    action: saveStage, successMessage: t.common.saved, onSuccess: onDone,
  });
  const types = (["open"] as const).map((v) => ({ value: v, label: t.enums.stageType[v] }));
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="name" label={t.common.name} />
        <div className="grid grid-cols-2 gap-3">
          <SelectField control={form.control} name="stageType" label={t.pipelines.stageType} options={types} />
        </div>
        <CheckboxField control={form.control} name="isActive" label={t.common.active} />
        <DialogFooter><SubmitButton pending={pending}>{t.common.save}</SubmitButton></DialogFooter>
      </FieldGroup>
    </form>
  );
}

export function StageMoveButtons({ pipelineId, order, index }: { pipelineId: string; order: string[]; index: number }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const move = (delta: number) => start(async () => {
    const next = [...order];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    const res = await reorderStages({ pipelineId, stageIds: next });
    if (!res.ok) toast.error(res.error);
  });
  return (
    <>
      <Button variant="ghost" size="icon-xs" disabled={pending || index === 0} onClick={() => move(-1)} aria-label={t.pipelines.moveUp}><ArrowUp /></Button>
      <Button variant="ghost" size="icon-xs" disabled={pending || index === order.length - 1} onClick={() => move(1)} aria-label={t.pipelines.moveDown}><ArrowDown /></Button>
    </>
  );
}

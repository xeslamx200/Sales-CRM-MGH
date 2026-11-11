"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/server/supabase/server";
import { runAction, check, must, type ActionResult } from "@/server/action";
import { Constants } from "@/types/database";

// Company admins only — enforced by RLS (pipelines_write / stages_write) and
// app.guard_stage. These actions just validate input and call the database.

const done = () => {
  revalidatePath("/admin/pipelines");
};

const createSchema = z.object({ companyId: z.uuid(), name: z.string().trim().min(1).max(120), kind: z.enum(Constants.public.Enums.pipeline_kind) });
export async function createPipeline(input: z.input<typeof createSchema>): Promise<ActionResult<{ id: string }>> {
  return runAction(createSchema, input, async ({ companyId, name, kind }) => {
    const supabase = await createClient();
    const id = must(await supabase.rpc("create_pipeline", { p_company_id: companyId, p_name: name, p_kind: kind }));
    done();
    return { id };
  });
}

const pipelineSchema = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120), isActive: z.boolean() });
export async function updatePipeline(input: z.input<typeof pipelineSchema>): Promise<ActionResult<null>> {
  return runAction(pipelineSchema, input, async ({ id, name, isActive }) => {
    const supabase = await createClient();
    check(await supabase.from("pipelines").update({ name, is_active: isActive }).eq("id", id).select("id").single());
    done();
    return null;
  });
}

const stageSchema = z.object({
  id: z.uuid().optional(),
  pipelineId: z.uuid(),
  companyId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  stageType: z.enum(Constants.public.Enums.stage_type),
  probability: z.coerce.number().int().min(0).max(100).nullable().optional(),
  isActive: z.boolean(),
});
export async function saveStage(input: z.input<typeof stageSchema>): Promise<ActionResult<null>> {
  return runAction(stageSchema, input, async (d) => {
    const supabase = await createClient();
    const row = { name: d.name, stage_type: d.stageType, probability: d.probability ?? null, is_active: d.isActive };
    if (d.id) {
      check(await supabase.from("pipeline_stages").update(row).eq("id", d.id).select("id").single());
    } else {
      const { data: existing } = await supabase.from("pipeline_stages").select("id, position, stage_type").eq("pipeline_id", d.pipelineId)
        .order("position");
      const stages = existing ?? [];
      const id = must(await supabase.from("pipeline_stages")
        .insert({ ...row, pipeline_id: d.pipelineId, company_id: d.companyId, position: (stages.at(-1)?.position ?? -1) + 1 })
        .select("id").single()).id;
      // A new open stage goes before the first closed (won/lost) stage rather than after them.
      const firstClosed = stages.findIndex((s) => s.stage_type !== "open");
      if (d.stageType === "open" && firstClosed >= 0) {
        const order = stages.map((s) => s.id);
        order.splice(firstClosed, 0, id);
        check(await supabase.rpc("reorder_pipeline_stages", { p_pipeline_id: d.pipelineId, p_stage_ids: order }));
      }
    }
    done();
    return null;
  });
}

const orderSchema = z.object({ pipelineId: z.uuid(), stageIds: z.array(z.uuid()).min(1).max(50) });
export async function reorderStages(input: z.input<typeof orderSchema>): Promise<ActionResult<null>> {
  return runAction(orderSchema, input, async ({ pipelineId, stageIds }) => {
    const supabase = await createClient();
    check(await supabase.rpc("reorder_pipeline_stages", { p_pipeline_id: pipelineId, p_stage_ids: stageIds }));
    done();
    return null;
  });
}

const defaultSchema = z.object({ pipelineId: z.uuid() });
export async function setDefaultPipeline(input: z.input<typeof defaultSchema>): Promise<ActionResult<null>> {
  return runAction(defaultSchema, input, async ({ pipelineId }) => {
    const supabase = await createClient();
    check(await supabase.rpc("set_default_pipeline", { p_pipeline_id: pipelineId }));
    done();
    return null;
  });
}

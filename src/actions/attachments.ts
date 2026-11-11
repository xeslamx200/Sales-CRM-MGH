"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/server/action";
import { deleteAttachment, finalizeAttachment, prepareAttachmentUpload } from "@/server/attachments";
import { ATTACHMENT_ENTITY_TYPES } from "@/lib/attachments.ts";

const recordPath = (entityType: string, entityId: string) =>
  entityType === "lead" ? `/leads/${entityId}` : "/payments";

const prepareSchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.uuid(),
  mimeType: z.string().max(120),
  size: z.number().int().positive(),
});

/** One-time signed URL for uploading a file to a lead or payment (browser → private Storage). */
export async function prepareAttachment(input: z.input<typeof prepareSchema>): Promise<ActionResult<{ path: string; token: string }>> {
  return runAction(prepareSchema, input, (d) => prepareAttachmentUpload(d));
}

const finalizeSchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.uuid(),
  path: z.string().max(300),
  fileName: z.string().trim().min(1).max(400),
  mimeType: z.string().max(120),
});

export async function finalizeAttachmentUpload(input: z.input<typeof finalizeSchema>): Promise<ActionResult<{ id: string }>> {
  return runAction(finalizeSchema, input, async (d) => {
    const out = await finalizeAttachment(d);
    revalidatePath(recordPath(d.entityType, d.entityId));
    return out;
  });
}

const deleteSchema = z.object({ id: z.uuid() });
export async function removeAttachment(input: z.input<typeof deleteSchema>): Promise<ActionResult<null>> {
  return runAction(deleteSchema, input, async ({ id }) => {
    const { entityType, entityId } = await deleteAttachment(id);
    revalidatePath(recordPath(entityType, entityId));
    return null;
  });
}

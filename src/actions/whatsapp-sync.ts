"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { AppError, runAction, type ActionResult } from "@/server/action";
import { getViewer } from "@/server/auth/viewer";
import { startSync, syncStep, type SyncState } from "@/server/whatsapp/history-sync";
import { startOfDay } from "@/lib/kapso/history.ts";

// "Check and complete messages" on the WhatsApp numbers page. Super admin only (checked on every step, not only when the page renders).

const startSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

const progressSchema = z.object({
  pn: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), name: z.string().max(200), phase: z.enum(["messages", "media", "done"]),
  cursor: z.string().max(4000).nullable(),
  seen: z.number().int().min(0), alreadyThere: z.number().int().min(0), added: z.number().int().min(0), failed: z.number().int().min(0),
  skipped: z.number().int().min(0), filesSeen: z.number().int().min(0), filesCopied: z.number().int().min(0), filesFailed: z.number().int().min(0),
  crmMessages: z.number().int().min(0).optional(), crmConversations: z.number().int().min(0).optional(),
});
const stepSchema = z.object({
  state: z.object({
    from: z.number().int().positive(), fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), current: z.number().int().min(0).max(50), done: z.boolean(),
    rateLimited: z.boolean().optional(), numbers: z.array(progressSchema).max(50),
  }),
});

async function requireSuperAdmin() {
  const viewer = await getViewer();
  if (!viewer.isSuperAdmin) throw new AppError("auth.forbidden");
}

export async function startHistorySync(input: z.input<typeof startSchema>): Promise<ActionResult<SyncState>> {
  return runAction(startSchema, input, async ({ from }) => {
    await requireSuperAdmin();
    const ts = startOfDay(from);
    if (ts === null) throw new AppError("sync.invalid_date");
    return startSync(from, ts);
  });
}

export async function continueHistorySync(input: z.input<typeof stepSchema>): Promise<ActionResult<SyncState>> {
  return runAction(stepSchema, input, async ({ state }) => {
    await requireSuperAdmin();
    const next = await syncStep(state as SyncState);
    if (next.done) revalidatePath("/inbox");
    return next;
  });
}

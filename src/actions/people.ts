"use server";
import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/server/action";
import { createPerson, removePerson, resetPassword, updatePerson } from "@/server/auth/people";
import { createPersonSchema, removePersonSchema, resetPasswordSchema, updatePersonSchema } from "@/schemas/people";
import type { z } from "zod";

// Company settings -> People. The permission rules live in src/server/auth/people.ts (company admin of that company, or super admin).

export async function createPersonAction(input: z.input<typeof createPersonSchema>): Promise<ActionResult<{ createdAccount: boolean }>> {
  return runAction(createPersonSchema, input, async (d) => {
    const r = await createPerson(d);
    revalidatePath("/admin/settings");
    return r;
  });
}

export async function updatePersonAction(input: z.input<typeof updatePersonSchema>): Promise<ActionResult<null>> {
  return runAction(updatePersonSchema, input, async (d) => {
    await updatePerson(d);
    revalidatePath("/admin/settings");
    return null;
  });
}

export async function resetPasswordAction(input: z.input<typeof resetPasswordSchema>): Promise<ActionResult<null>> {
  return runAction(resetPasswordSchema, input, async (d) => {
    await resetPassword(d);
    return null;
  });
}

export async function removePersonAction(input: z.input<typeof removePersonSchema>): Promise<ActionResult<null>> {
  return runAction(removePersonSchema, input, async (d) => {
    await removePerson(d);
    revalidatePath("/admin/settings");
    return null;
  });
}

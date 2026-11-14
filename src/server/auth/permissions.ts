import "server-only";
import { AppError } from "@/server/action";
import { can, getViewer } from "@/server/auth/viewer";
import type { PermissionKey } from "@/lib/permissions";

/** Refuse the action when the person's custom role in that company turns the switch off (admins are never restricted). */
export async function requirePermission(companyId: string | null | undefined, key: PermissionKey): Promise<void> {
  if (!can(await getViewer(), companyId, key)) throw new AppError("permission.denied");
}

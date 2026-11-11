import "server-only";
import type { NextRequest } from "next/server";
import { isBearerAuthorized } from "@/lib/cron-auth.ts";
import { serverEnv } from "@/server/env";

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Compared in
 * constant time (src/lib/cron-auth.ts); a missing CRON_SECRET disables every
 * cron route.
 */
export function isAuthorizedCron(request: NextRequest): boolean {
  let secret: string;
  try {
    secret = serverEnv("cron").CRON_SECRET;
  } catch {
    return false;
  }
  return isBearerAuthorized(request.headers.get("authorization"), secret);
}

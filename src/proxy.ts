import type { NextRequest } from "next/server";
import { updateSession } from "@/server/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and machine endpoints that authenticate
    // themselves (WhatsApp webhook signature, cron secret).
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/cron|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

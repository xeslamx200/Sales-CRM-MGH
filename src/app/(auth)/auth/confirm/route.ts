import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/server/supabase/server";

/**
 * Landing point for links in Supabase Auth e-mails (invite, password
 * recovery). The templates in supabase/templates link here with a one-time
 * token hash; verifying it creates the session in this browser.
 */
const DESTINATIONS: Partial<Record<EmailOtpType, string>> = {
  invite: "/auth/accept-invite",
  recovery: "/auth/reset-password",
  signup: "/",
  email: "/",
  email_change: "/profile",
};

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const destination = type ? DESTINATIONS[type] : undefined;

  if (tokenHash && type && destination) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(destination, origin));
  }
  return NextResponse.redirect(new URL("/login?error=link", origin));
}

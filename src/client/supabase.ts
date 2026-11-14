"use client";
import type { Database } from "@/types/database";

/**
 * Browser client (anon key + the user's session cookie). Subject to RLS like every user request. Never import server modules or the
 * service-role key here. Loaded ON DEMAND: the Supabase client is ~60 KB of JavaScript that only the file-upload code needs, so it is
 * fetched when someone attaches a file instead of with every page.
 */
export async function createBrowserSupabase() {
  const { createBrowserClient } = await import("@supabase/ssr");
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

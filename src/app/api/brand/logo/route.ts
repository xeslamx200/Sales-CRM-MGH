import { NextResponse } from "next/server";
import { createClient } from "@/server/supabase/server";

/** The company logo for the signed-in members of the company (the database refuses everyone else). Versioned by the `v` parameter, so it can be cached. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("c") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse(null, { status: 404 });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("company_logo", { p_company_id: id });
  const row = data?.[0];
  if (error || !row?.logo || !["image/png", "image/jpeg", "image/webp"].includes(row.logo_type)) return new NextResponse(null, { status: 404 });
  // bytea comes back as "\x<hex>"
  const bytes = Buffer.from(row.logo.replace(/^\\x/, ""), "hex");
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": row.logo_type,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

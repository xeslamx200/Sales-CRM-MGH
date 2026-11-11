// Used only by src/proxy.ts (no `server-only` import: proxy bundles are not
// compiled with the react-server condition).
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/env";
import type { Database } from "@/types/database";

/** Routes reachable without a session. Everything else requires sign-in. */
const PUBLIC_PATHS = ["/login", "/forgot-password", "/auth/confirm", "/auth/error"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * Refresh the Supabase session cookie on every request and redirect
 * unauthenticated users to /login. Authorization itself is enforced by RLS;
 * this only decides where to send people without a session.
 */
export async function updateSession(request: NextRequest) {
  const env = publicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Do not run code between createServerClient and getClaims(): it refreshes
  // the session and must see the request cookies first.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  if (!signedIn && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return redirectWithCookies(url, response);
  }
  // The application sent this person to /login with a reason (for example their account was closed). Their token is still
  // cryptographically valid, so without this the next rule would send them back to "/" and the app back to /login, forever.
  // End the session here (the proxy may write cookies; a page may not) and show the sign-in page with its message.
  if (signedIn && pathname === "/login" && request.nextUrl.searchParams.has("error")) {
    await supabase.auth.signOut({ scope: "local" });
    return response;
  }
  if (signedIn && (pathname === "/login" || pathname === "/forgot-password")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return redirectWithCookies(url, response);
  }
  return response;
}

/** Keep refreshed session cookies when redirecting. */
function redirectWithCookies(url: URL, from: NextResponse) {
  const res = NextResponse.redirect(url);
  for (const c of from.cookies.getAll()) res.cookies.set(c);
  return res;
}

import createIntlMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { routing } from "@/i18n/routing";

const handleIntl = createIntlMiddleware(routing);

const PUBLIC_PATHS = ["/login", "/auth", "/"];

function isPublicPath(pathname: string): boolean {
  // Strip locale prefix: /fr/login -> /login, /fr -> /
  const stripped =
    pathname.replace(/^\/(fr|ar|nl)(\/|$)/, "/").replace(/\/+$/, "") || "/";
  return PUBLIC_PATHS.some(
    (p) => stripped === p || stripped.startsWith(p + "/"),
  );
}

export async function middleware(request: NextRequest) {
  // ── Step 1: Supabase session refresh ──────────────────────────────────────
  //
  // Follow the official @supabase/ssr middleware pattern exactly:
  // setAll must ALSO update request.cookies so that getUser() sees the
  // refreshed token within the same middleware execution.
  //
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // 1. Update the in-flight request so downstream code reads fresh tokens
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value, options),
          );
          // 2. Recreate supabaseResponse with the mutated request so Next.js
          //    propagates the refreshed cookies to the browser.
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Always call getUser() — never trust cookies client-side.
  // This also triggers the token-refresh path when the access token is stale.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Step 2: Auth guard ────────────────────────────────────────────────────
  const path = request.nextUrl.pathname;

  if (!user && !isPublicPath(path)) {
    const locale =
      (path.match(/^\/(fr|ar|nl)/)?.[1] as string | undefined) ??
      routing.defaultLocale;
    const loginUrl = new URL(`/${locale}/login`, request.url);
    const authRedirect = NextResponse.redirect(loginUrl);
    // Carry refreshed cookies so the browser doesn't lose the stale session
    // (important when Supabase just issued new tokens before the guard ran)
    supabaseResponse.cookies
      .getAll()
      .forEach((c) => authRedirect.cookies.set(c.name, c.value, c));
    return authRedirect;
  }

  // ── Step 3: next-intl locale routing ─────────────────────────────────────
  //
  // Run intl middleware AFTER auth so locale redirects (/ -> /fr) don't
  // interfere with the Supabase cookie handling above.
  // Copy the refreshed Supabase cookies onto whatever response intl returns.
  //
  const intlResponse = handleIntl(request);
  supabaseResponse.cookies
    .getAll()
    .forEach((c) => intlResponse.cookies.set(c.name, c.value, c));

  return intlResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

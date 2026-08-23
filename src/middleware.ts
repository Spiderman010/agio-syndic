import createIntlMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { routing } from "@/i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

const PUBLIC_PATHS = ["/login", "/auth", "/"];

function isPublicPath(pathname: string): boolean {
  // Strip locale prefix (/fr, /ar, /nl) before checking
  const stripped = pathname.replace(/^\/(fr|ar|nl)/, "") || "/";
  return PUBLIC_PATHS.some(
    (p) => stripped === p || stripped.startsWith(p + "/"),
  );
}

export async function middleware(request: NextRequest) {
  // 1. next-intl runs first — handles locale detection and redirects
  const intlResponse = intlMiddleware(request);

  // 2. Build the response Supabase will use (intl response if available)
  const response = intlResponse ?? NextResponse.next({ request });

  // 3. Supabase session refresh — writes cookies into the same response
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // 4. Auth guard: not logged in + protected route → /[locale]/login
  if (!user && !isPublicPath(path)) {
    const locale =
      (path.match(/^\/(fr|ar|nl)/)?.[1] as string | undefined) ??
      routing.defaultLocale;
    const loginUrl = new URL(`/${locale}/login`, request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

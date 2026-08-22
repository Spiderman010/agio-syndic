import { createBrowserClient } from "@supabase/ssr";

// Browser-client (client components). Sleutels komen uit env (.env.local / Vercel).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

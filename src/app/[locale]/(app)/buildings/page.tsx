import { createClient } from "@/lib/supabase/server";
import type { Building } from "@/lib/types";
import BuildingsClient from "./BuildingsClient";

export default async function BuildingsPage() {
  // De organisatie wordt door de schil-layout opgehaald en bewaakt
  // (`requireOrg` in (app)/layout.tsx); hier is alleen de lijst nodig.
  const supabase = await createClient();
  const { data } = await supabase
    .from("buildings")
    .select("*")
    .order("created_at", { ascending: false });

  return <BuildingsClient buildings={(data ?? []) as Building[]} />;
}

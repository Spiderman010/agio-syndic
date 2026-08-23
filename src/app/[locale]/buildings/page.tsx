import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import type { Building } from "@/lib/types";
import BuildingsClient from "./BuildingsClient";

export default async function BuildingsPage() {
  const { org } = await requireOrg();
  const supabase = await createClient();
  const { data } = await supabase
    .from("buildings")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <BuildingsClient
      orgName={org.name}
      buildings={(data ?? []) as Building[]}
    />
  );
}

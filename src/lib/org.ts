import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { OrgRole, Organization } from "@/lib/types";

export type ActiveOrg = { role: OrgRole; org: Organization };

// Haalt de (eerste) organisatie van de ingelogde gebruiker op.
export async function getActiveOrg(): Promise<ActiveOrg | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("memberships")
    .select("role, organizations(id, name, created_at)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data || !data.organizations) return null;
  const org = data.organizations as unknown as Organization;
  return { role: data.role as OrgRole, org };
}

// Vereist een organisatie; stuurt anders naar onboarding.
export async function requireOrg(): Promise<ActiveOrg> {
  const active = await getActiveOrg();
  if (!active) redirect("/onboarding");
  return active;
}

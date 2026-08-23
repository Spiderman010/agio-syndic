"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { redirect } from "@/navigation";
import type { SyndicTier, AppLanguage } from "@/lib/types";

export async function createBuilding(formData: FormData) {
  const { org } = await requireOrg();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Naam verplicht." };
  const address = String(formData.get("address") ?? "").trim() || null;
  const tier = (String(formData.get("tier") ?? "klein")) as SyndicTier;
  const total_tantiemes = Number(formData.get("total_tantiemes") ?? 1000) || 1000;
  const default_language = String(formData.get("default_language") ?? "fr") as AppLanguage;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("buildings")
    .insert({ organization_id: org.id, name, address, tier, total_tantiemes, default_language })
    .select("id")
    .single();

  if (error || !data) return { error: error?.message ?? "Aanmaken mislukt." };
  revalidatePath("/buildings");
  redirect(`/buildings/${data.id}`);
}

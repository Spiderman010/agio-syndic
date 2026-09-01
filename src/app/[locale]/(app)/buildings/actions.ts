"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { localeRedirect } from "@/lib/redirect";
import { buildingSchema, parseForm } from "@/lib/validation";
import { toUserError } from "@/lib/errors";

export async function createBuilding(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(buildingSchema, formData);
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("buildings")
    .insert({ organization_id: org.id, ...parsed.data })
    .select("id")
    .single();

  if (error || !data) {
    return { error: toUserError(error, "Aanmaken van het gebouw is mislukt.") };
  }

  revalidatePath("/buildings");
  return localeRedirect(`/buildings/${data.id}`);
}

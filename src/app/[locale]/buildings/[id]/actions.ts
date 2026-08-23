"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { redirect } from "@/navigation";
import type { UnitType } from "@/lib/types";

export async function createUnit(formData: FormData) {
  await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const unit_type = String(formData.get("unit_type") ?? "appartement") as UnitType;
  const tantiemes = Number(formData.get("tantiemes") ?? 0) || 0;

  if (!buildingId || !label) return { error: "Label is verplicht." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("units")
    .insert({ building_id: buildingId, label, unit_type, tantiemes });

  if (error) return { error: error.message };
  revalidatePath(`/buildings/${buildingId}`);
  redirect(`/buildings/${buildingId}`);
}

export async function createOwner(formData: FormData) {
  const { org } = await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const full_name = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const is_mre = formData.get("is_mre") === "on";

  if (!full_name) return { error: "Naam eigenaar is verplicht." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("owners")
    .insert({ organization_id: org.id, full_name, email, is_mre });

  if (error) return { error: error.message };
  revalidatePath(`/buildings/${buildingId}`);
  redirect(`/buildings/${buildingId}`);
}

export async function assignOwner(formData: FormData) {
  await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const unitId = String(formData.get("unit_id") ?? "");
  const ownerId = String(formData.get("owner_id") ?? "");

  if (!unitId || !ownerId) redirect(`/buildings/${buildingId}`);

  const supabase = await createClient();
  const { error } = await supabase
    .from("ownership")
    .insert({ unit_id: unitId, owner_id: ownerId });

  if (error) return { error: error.message };
  revalidatePath(`/buildings/${buildingId}`);
  redirect(`/buildings/${buildingId}`);
}

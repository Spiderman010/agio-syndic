"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SyndicTier, UnitType, AppLanguage } from "@/lib/types";

export async function createBuilding(formData: FormData) {
  const { org } = await requireOrg();
  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim() || null;
  const tier = (String(formData.get("tier") ?? "klein") as SyndicTier) || "klein";
  const total_tantiemes = Number(formData.get("total_tantiemes") ?? 1000) || 1000;
  const default_language = (String(formData.get("default_language") ?? "fr") as AppLanguage) || "fr";

  if (!name) redirect(`/buildings?error=${encodeURIComponent("Naam is verplicht")}`);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("buildings")
    .insert({ organization_id: org.id, name, address, tier, total_tantiemes, default_language })
    .select("id")
    .single();

  if (error) redirect(`/buildings?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/buildings");
  redirect(`/buildings/${data!.id}`);
}

export async function createUnit(formData: FormData) {
  await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const unit_type = (String(formData.get("unit_type") ?? "appartement") as UnitType) || "appartement";
  const tantiemes = Number(formData.get("tantiemes") ?? 0) || 0;

  if (!buildingId || !label) redirect(`/buildings/${buildingId}?error=${encodeURIComponent("Label is verplicht")}`);

  const supabase = await createClient();
  const { error } = await supabase
    .from("units")
    .insert({ building_id: buildingId, label, unit_type, tantiemes });

  if (error) redirect(`/buildings/${buildingId}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/buildings/${buildingId}`);
  redirect(`/buildings/${buildingId}`);
}

export async function createOwner(formData: FormData) {
  const { org } = await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const full_name = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim() || null;
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const is_mre = formData.get("is_mre") === "on";

  if (!full_name) redirect(`/buildings/${buildingId}?error=${encodeURIComponent("Naam eigenaar is verplicht")}`);

  const supabase = await createClient();
  const { error } = await supabase
    .from("owners")
    .insert({ organization_id: org.id, full_name, email, phone, is_mre });

  if (error) redirect(`/buildings/${buildingId}?error=${encodeURIComponent(error.message)}`);

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

  if (error) redirect(`/buildings/${buildingId}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/buildings/${buildingId}`);
  redirect(`/buildings/${buildingId}`);
}

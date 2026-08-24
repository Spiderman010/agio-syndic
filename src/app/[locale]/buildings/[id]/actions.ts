"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { redirect } from "@/navigation";
import {
  assignOwnerSchema,
  bankInfoSchema,
  ownerSchema,
  parseForm,
  unitSchema,
} from "@/lib/validation";
import { assertInOrg, assertUnitInOrg } from "@/lib/guard";
import { toUserError } from "@/lib/errors";

export async function createUnit(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(unitSchema, formData);
  if (parsed.error) return { error: parsed.error };
  const { building_id, ...unit } = parsed.data;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (guard) return { error: guard };

  const { error } = await supabase.from("units").insert({ building_id, ...unit });
  if (error) return { error: toUserError(error, "Toevoegen van de unit is mislukt.") };

  revalidatePath(`/buildings/${building_id}`);
  redirect(`/buildings/${building_id}`);
}

export async function createOwner(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(ownerSchema, formData, {
    is_mre: formData.get("is_mre") === "on",
  });
  if (parsed.error) return { error: parsed.error };
  const { building_id, ...owner } = parsed.data;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (guard) return { error: guard };

  const { error } = await supabase
    .from("owners")
    .insert({ organization_id: org.id, ...owner });
  if (error) return { error: toUserError(error, "Toevoegen van de eigenaar is mislukt.") };

  revalidatePath(`/buildings/${building_id}`);
  redirect(`/buildings/${building_id}`);
}

/**
 * Koppelt een eigenaar aan een unit.
 *
 * P0-4: unit_id én owner_id komen beide uit het formulier en worden allebei
 * expliciet tegen de actieve organisatie gecontroleerd. De database dwingt
 * dezelfde invariant nogmaals af via trig_00_ownership_tenant_guard en de
 * ownership-RLS-policy.
 */
export async function assignOwner(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(assignOwnerSchema, formData);
  if (parsed.error) return { error: parsed.error };
  const { building_id, unit_id, owner_id } = parsed.data;

  const supabase = await createClient();

  const buildingGuard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (buildingGuard) return { error: buildingGuard };

  const unitGuard = await assertUnitInOrg(supabase, unit_id, org.id);
  if (unitGuard) return { error: unitGuard };

  const ownerGuard = await assertInOrg(supabase, "owners", owner_id, org.id, "Eigenaar");
  if (ownerGuard) return { error: ownerGuard };

  const { error } = await supabase.from("ownership").insert({ unit_id, owner_id });
  if (error) return { error: toUserError(error, "Koppelen van de eigenaar is mislukt.") };

  revalidatePath(`/buildings/${building_id}`);
  redirect(`/buildings/${building_id}`);
}

export async function updateBankInfo(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(bankInfoSchema, formData);
  if (parsed.error) return { error: parsed.error };
  const { building_id, bank_name, bank_rib } = parsed.data;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (guard) return { error: guard };

  const { error } = await supabase
    .from("buildings")
    .update({ bank_name, bank_rib })
    .eq("id", building_id);

  if (error) return { error: toUserError(error, "Opslaan van de bankgegevens is mislukt.") };

  revalidatePath(`/buildings/${building_id}`);
  redirect(`/buildings/${building_id}`);
}

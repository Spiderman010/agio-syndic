"use server";

import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { canWrite } from "@/lib/roles";
import { revalidatePath } from "next/cache";
import { localeRedirect } from "@/lib/redirect";
import {
  assignOwnerSchema,
  bankInfoSchema,
  ownerSchema,
  parseForm,
  unitSchema,
} from "@/lib/validation";
import { assertInOrg, assertUnitInOrg } from "@/lib/guard";
import { toUserError } from "@/lib/errors";
import { ownershipErrorKey } from "@/lib/ownership";

export async function createUnit(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(unitSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, ...unit } = parsed.data;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (guard) return { error: guard };

  const { error } = await supabase.from("units").insert({ building_id, ...unit });
  if (error) return { error: toUserError(error, "Toevoegen van de unit is mislukt.") };

  revalidatePath(`/buildings/${building_id}`);
  return localeRedirect(`/buildings/${building_id}`);
}

export async function createOwner(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(ownerSchema, formData, {
    is_mre: formData.get("is_mre") === "on",
  });
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, ...owner } = parsed.data;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (guard) return { error: guard };

  const { error } = await supabase
    .from("owners")
    .insert({ organization_id: org.id, ...owner });
  if (error) return { error: toUserError(error, "Toevoegen van de eigenaar is mislukt.") };

  revalidatePath(`/buildings/${building_id}`);
  return localeRedirect(`/buildings/${building_id}`);
}

/**
 * Koppelt een EERSTE eigenaar aan een nog ongekoppeld lot.
 *
 * Sinds m30 loopt dit uitsluitend via `link_first_owner`. Een directe insert in
 * `ownership` bestaat niet meer als pad: `authenticated` heeft er alleen nog
 * SELECT en de write-policies zijn verwijderd. Er is bewust GEEN terugval op
 * tabel-DML — die zou worden geweigerd, en een fallback zou suggereren dat er
 * een tweede route is.
 *
 * unit_id én owner_id komen uit het formulier en worden allebei expliciet tegen
 * de actieve organisatie gecontroleerd; de RPC doet dat daarna nog eens op basis
 * van `auth.uid()`.
 */
export async function assignOwner(formData: FormData) {
  const { org, role } = await requireOrg();
  const t = await getTranslations("owners.errors");
  if (!canWrite(role)) return { error: t("forbidden") };

  const parsed = parseForm(assignOwnerSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, unit_id, owner_id } = parsed.data;

  const supabase = await createClient();

  const buildingGuard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (buildingGuard) return { error: t("forbidden") };

  // Het lot moet bij DIT gebouw horen, niet alleen bij de organisatie; anders
  // kan een gemanipuleerd formulier building_id van gebouw A combineren met
  // unit_id van gebouw B en zo gebouw B muteren terwijl de actie gebouw A
  // revalideert en daarheen redirect.
  const unitGuard = await assertUnitInOrg(supabase, unit_id, org.id, building_id);
  if (unitGuard) return { error: t("forbidden") };

  const ownerGuard = await assertInOrg(supabase, "owners", owner_id, org.id, "Eigenaar");
  if (ownerGuard) return { error: t("ownerInvalid") };

  // De ingangsdatum is vandaag: dit scherm kent geen datumveld, en de database
  // weigert een datum in de toekomst.
  const { error } = await supabase.rpc("link_first_owner", {
    p_unit_id: unit_id,
    p_owner_id: owner_id,
    p_start_date: new Date().toISOString().slice(0, 10),
  });
  if (error) return { error: t(ownershipErrorKey(error.message)) };

  revalidatePath(`/buildings/${building_id}`);
  revalidatePath(`/buildings/${building_id}/lots`);
  return localeRedirect(`/buildings/${building_id}`);
}

export async function updateBankInfo(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(bankInfoSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
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
  return localeRedirect(`/buildings/${building_id}`);
}

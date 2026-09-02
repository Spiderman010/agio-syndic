"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { canWrite } from "@/lib/roles";
import { localeRedirect } from "@/lib/redirect";
import { assertInOrg, assertUnitInOrg } from "@/lib/guard";
import {
  linkFirstOwnerSchema,
  lotCreateSchema,
  lotUpdateSchema,
  parseForm,
  transferOwnershipSchema,
} from "@/lib/validation";
import { ownershipErrorKey } from "@/lib/ownership";

/**
 * Server actions voor lots en eigendom binnen één gebouw.
 *
 * ── EIGENDOM LOOPT UITSLUITEND VIA DE RPC'S ────────────────────────────────
 *
 * `link_first_owner` en `transfer_ownership` zijn sinds m30 de ENIGE manier
 * waarop deze applicatie in `ownership` kan schrijven. Dat is geen afspraak maar
 * een databasegrens: `authenticated` heeft er alleen nog SELECT, en de
 * write-policies bestaan niet meer. Er is daarom bewust GEEN terugval op directe
 * tabel-DML — die zou toch worden geweigerd, en een fallback zou de indruk
 * wekken dat er een tweede pad is.
 *
 * De RPC's dragen hun eigen autorisatie (`auth.uid()` plus `can_write`),
 * tenantcontrole en datumregels. De guards hieronder zijn de tweede laag: ze
 * voorkomen een aanroep waarvan we al weten dat hij faalt, en ze houden de
 * gebouwscope uit de URL gescheiden van de id's uit het formulier.
 */

async function foutTekst(message: string | null | undefined): Promise<string> {
  const t = await getTranslations("owners.errors");
  return t(ownershipErrorKey(message));
}

/** Vandaag in ISO, zonder tijdzoneverschuiving; gelijk aan `CURRENT_DATE`. */
function vandaag(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function createLot(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const parsed = parseForm(lotCreateSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, ...lot } = parsed.data;

  const supabase = await createClient();
  const guard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (guard) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const { error } = await supabase.from("units").insert({ building_id, ...lot });
  if (error) return { error: await foutTekst(error.message) };

  revalidatePath(`/buildings/${building_id}/lots`);
  return localeRedirect(`/buildings/${building_id}/lots`);
}

export async function updateLot(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const parsed = parseForm(lotUpdateSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, unit_id, ...lot } = parsed.data;

  const supabase = await createClient();

  const buildingGuard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (buildingGuard) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  // Het lot moet niet alleen bij de organisatie horen maar ook bij DIT gebouw;
  // anders kan een gemanipuleerd formulier een lot uit een ander gebouw wijzigen.
  const unitGuard = await assertUnitInOrg(supabase, unit_id, org.id);
  if (unitGuard) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const { error } = await supabase
    .from("units")
    .update(lot)
    .eq("id", unit_id)
    .eq("building_id", building_id);

  if (error) return { error: await foutTekst(error.message) };

  revalidatePath(`/buildings/${building_id}/lots`);
  return localeRedirect(`/buildings/${building_id}/lots`);
}

/**
 * Eerste koppeling van een nog ongekoppeld lot.
 *
 * De ingangsdatum komt uit het formulier maar wordt op vandaag begrensd: de
 * database weigert een toekomstige datum sowieso, en een gebruiker die er een
 * invoert hoort een begrijpelijke melding te krijgen in plaats van een
 * mislukte RPC.
 */
export async function linkFirstOwner(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const parsed = parseForm(linkFirstOwnerSchema, formData, {
    start_date: formData.get("start_date") || vandaag(),
  });
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, unit_id, owner_id, start_date } = parsed.data;

  const supabase = await createClient();

  const buildingGuard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (buildingGuard) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };
  const unitGuard = await assertUnitInOrg(supabase, unit_id, org.id);
  if (unitGuard) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };
  const ownerGuard = await assertInOrg(supabase, "owners", owner_id, org.id, "Eigenaar");
  if (ownerGuard) return { error: await foutTekst("OWNERSHIP_OWNER_INVALID") };

  const { error } = await supabase.rpc("link_first_owner", {
    p_unit_id: unit_id,
    p_owner_id: owner_id,
    p_start_date: start_date,
  });
  if (error) return { error: await foutTekst(error.message) };

  revalidatePath(`/buildings/${building_id}/lots`);
  revalidatePath("/owners");
  return localeRedirect(`/buildings/${building_id}/lots`);
}

/**
 * Eigendomsoverdracht.
 *
 * `expected_ownership_id` komt uit de gerenderde pagina en gaat ongewijzigd mee
 * naar de RPC. Wijkt de actuele rij daarvan af — omdat een andere beheerder
 * intussen heeft overgedragen — dan gebeurt er niets en volgt `OWNERSHIP_STALE`,
 * dat de UI vertaalt naar een verzoek om te verversen.
 */
export async function transferOwnership(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const parsed = parseForm(transferOwnershipSchema, formData, {
    transfer_date: formData.get("transfer_date") || vandaag(),
  });
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, unit_id, expected_ownership_id, new_owner_id, transfer_date } =
    parsed.data;

  const supabase = await createClient();

  const buildingGuard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (buildingGuard) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };
  const unitGuard = await assertUnitInOrg(supabase, unit_id, org.id);
  if (unitGuard) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };
  const ownerGuard = await assertInOrg(supabase, "owners", new_owner_id, org.id, "Eigenaar");
  if (ownerGuard) return { error: await foutTekst("OWNERSHIP_OWNER_INVALID") };

  const { error } = await supabase.rpc("transfer_ownership", {
    p_unit_id: unit_id,
    p_expected_current_ownership_id: expected_ownership_id,
    p_new_owner_id: new_owner_id,
    p_transfer_date: transfer_date,
  });
  if (error) return { error: await foutTekst(error.message) };

  revalidatePath(`/buildings/${building_id}/lots`);
  revalidatePath("/owners");
  return localeRedirect(`/buildings/${building_id}/lots`);
}

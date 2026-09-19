"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { canWrite } from "@/lib/roles";
import { localeRedirect } from "@/lib/redirect";
import { assertInOrg } from "@/lib/guard";
import { ownerCreateSchema, ownerDeleteSchema, ownerUpdateSchema, parseForm } from "@/lib/validation";
import { ownershipErrorKey } from "@/lib/ownership";
import { deleteErrorFingerprint, deleteErrorKey } from "@/lib/deleteErrors";

/**
 * Server actions voor organisatiebrede eigenaren.
 *
 * Drie regels die overal gelden:
 *
 *  1. `requireOrg()` bepaalt de organisatie; die komt NOOIT uit het formulier.
 *  2. Elk route-id uit het formulier wordt server-side tegen die organisatie
 *     gecontroleerd voordat er iets wordt geschreven. De database dwingt
 *     dezelfde grens nogmaals af via RLS; beide lagen zijn verplicht omdat de
 *     anon-key rechtstreeks tegen PostgREST bruikbaar is.
 *  3. Foutmeldingen komen uit de vertaalbestanden, nooit uit de database. Er
 *     gaan geen providerobjecten, rijwaarden of persoonsgegevens naar een log.
 *
 * De rolcontrole hier spiegelt `can_write` en voorkomt een mutatie waarvan we
 * weten dat de database hem weigert; hij vervangt die grens niet.
 */

/** Vertaalt een databasefout naar een vaste, veilige gebruikerszin. */
async function foutTekst(message: string | null | undefined): Promise<string> {
  const t = await getTranslations("owners.errors");
  return t(ownershipErrorKey(message));
}

export async function createOwner(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const parsed = parseForm(ownerCreateSchema, formData, {
    is_company: formData.get("is_company") === "on",
    is_mre: formData.get("is_mre") === "on",
  });
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("owners")
    .insert({ organization_id: org.id, ...parsed.data })
    .select("id")
    .single();

  if (error || !data) return { error: await foutTekst(error?.message) };

  revalidatePath("/owners");
  return localeRedirect(`/owners/${data.id}`);
}

export async function updateOwner(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const parsed = parseForm(ownerUpdateSchema, formData, {
    is_company: formData.get("is_company") === "on",
    is_mre: formData.get("is_mre") === "on",
  });
  if (!parsed.ok) return { error: parsed.error };
  const { owner_id, ...velden } = parsed.data;

  const supabase = await createClient();

  // Een vreemd of onbekend owner-id mag nooit tot een organisatiebrede update
  // leiden; de guard controleert bestaan én eigendom in één keer.
  const guard = await assertInOrg(supabase, "owners", owner_id, org.id, "Eigenaar");
  if (guard) return { error: await foutTekst("OWNERSHIP_OWNER_INVALID") };

  const { error } = await supabase
    .from("owners")
    .update(velden)
    .eq("id", owner_id)
    .eq("organization_id", org.id);

  if (error) return { error: await foutTekst(error.message) };

  revalidatePath("/owners");
  revalidatePath(`/owners/${owner_id}`);
  return localeRedirect(`/owners/${owner_id}`);
}

/**
 * Een eigenaar verwijderen.
 *
 * ── DE DATABASE BEPAALT OF HET MAG ─────────────────────────────────────────
 *
 * `trig_00_owner_delete_history` weigert met `ALLOC_OWNER_HAS_HISTORY` zodra er
 * vorderingen op deze eigenaar staan, en met `ALLOC_OWNER_HAS_PAYMENTS` zodra er
 * betalingen zijn. Beide zijn 23514. Deze actie probeert het dus gewoon en
 * vertaalt de weigering; hij gaat NIET zelf in `charge_allocations` en
 * `payments` kijken. Dat zou een tweede, eigen definitie van "heeft historie"
 * opleveren die stilletjes uiteen kan lopen met de trigger — en dan zou de UI
 * iets beloven wat de database weerlegt.
 *
 * WAT ER MEEVERDWIJNT: de `ownership`-rijen van deze eigenaar (ON DELETE
 * CASCADE). Een eigendomskoppeling is geen financiële historie; een vordering
 * of een betaling is dat wel, en die maakt verwijderen onmogelijk.
 */
export async function deleteOwner(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return { error: await foutTekst("OWNERSHIP_FORBIDDEN") };

  const parsed = parseForm(ownerDeleteSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { owner_id } = parsed.data;

  const supabase = await createClient();

  // Dezelfde tenantcontrole als bij bijwerken: een vreemd of onbekend id mag
  // nooit tot een verwijdering leiden.
  const guard = await assertInOrg(supabase, "owners", owner_id, org.id, "Eigenaar");
  if (guard) return { error: await foutTekst("OWNERSHIP_OWNER_INVALID") };

  const { error } = await supabase
    .from("owners")
    .delete()
    .eq("id", owner_id)
    .eq("organization_id", org.id);

  if (error) {
    console.error(`[owners] delete-owner ${deleteErrorFingerprint(error)}`);
    const t = await getTranslations("owners.errors");
    return { error: t(deleteErrorKey(error)) };
  }

  revalidatePath("/owners");
  // Ook de detailpagina van de verdwenen eigenaar: een gecachete versie zou
  // gegevens tonen die niet meer bestaan.
  revalidatePath(`/owners/${owner_id}`);
  return localeRedirect("/owners");
}

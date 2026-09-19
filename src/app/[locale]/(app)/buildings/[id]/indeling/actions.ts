"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { canWrite } from "@/lib/roles";
import { localeRedirect } from "@/lib/redirect";
import { assertInOrg, assertUnitInOrg } from "@/lib/guard";
import { blockErrorFingerprint, blockErrorKey } from "@/lib/blockErrors";
import { deleteErrorFingerprint, deleteErrorKey } from "@/lib/deleteErrors";
import {
  blockArchiveSchema,
  blockCreateSchema,
  blockUpdateSchema,
  bulkLotsSchema,
  lotDeleteSchema,
  lotLayoutUpdateSchema,
  parseForm,
} from "@/lib/validation";

/**
 * Mutaties op de INDELING van een gebouw: blokken en lots.
 *
 * ── DRIE LAGEN, EN DE DATABASE HEEFT HET LAATSTE WOORD ─────────────────────
 *
 *   1. het formulier toont niets wat zeker faalt;
 *   2. deze acties controleren rol en tenantscope vóór elke mutatie;
 *   3. RLS en de constraints van m12 weigeren onafhankelijk.
 *
 * Laag 1 en 2 bestaan om een begrijpelijke melding te kunnen geven, niet om
 * de grens te trekken. Die ligt in de database. `canWrite` spiegelt `can_write`
 * en is uitdrukkelijk GEEN security boundary — zie `lib/roles.ts`.
 *
 * ── LOTS VERWIJDEREN ZIT HIER WEL BIJ, BLOKKEN NIET ────────────────────────
 *
 * Een lot verwijderen mag, want de database heeft er een vangrail voor:
 * `fn_guard_unit_delete_history` weigert zodra het lot in een vastgelegde
 * lastenoproep voorkomt. Schoon mag weg, mét historie is onmogelijk — dat is
 * geen keuze van dit bestand.
 *
 * Een BLOK verwijderen blijft er bewust buiten: dat heeft geen guard en kan in
 * `charge_calls.alloc_block_id` en `allocation_rules.scope_block_id` staan.
 * Archiveren is daar het antwoord, en dat bestaat al.
 *
 * ── ARCHIVEREN NULT `block_id` NIET ────────────────────────────────────────
 *
 * Een gearchiveerd blok verdwijnt uit de keuzelijst, maar zijn lots houden hun
 * `block_id`. Die komen op het indelingsscherm in de groep "onbereikbaar"
 * terecht. Dat is opzet: een lot mag nooit stilzwijgend uit beeld raken.
 */

async function fout(error: unknown): Promise<{ error: string }> {
  const t = await getTranslations("indeling.errors");
  return { error: t(blockErrorKey(error as { code?: string; message?: string })) };
}

async function verboden(): Promise<{ error: string }> {
  const t = await getTranslations("indeling.errors");
  return { error: t("forbidden") };
}

/**
 * Wat er in het serverlog terechtkomt. Alleen SQLSTATE en een constraintnaam
 * die we zelf al kenden; nooit de databasemelding, want daar kan een botsende
 * blokcode of lotnaam in staan.
 */
function logFout(actie: string, error: unknown) {
  console.error(
    `[indeling] ${actie} ${blockErrorFingerprint(error as { code?: string; message?: string })}`,
  );
}

/**
 * Hoort dit blok bij DIT gebouw én deze organisatie?
 *
 * `assertInOrg` dekt de organisatie. De gebouwscope komt daar bovenop, want
 * zonder die controle kan een gemanipuleerd formulier een blok uit een ander
 * gebouw van dezelfde organisatie hernoemen of archiveren.
 */
async function blokInGebouw(
  supabase: Awaited<ReturnType<typeof createClient>>,
  blockId: string,
  orgId: string,
  buildingId: string,
): Promise<boolean> {
  // Alle drie de voorwaarden in ÉÉN query. `assertInOrg` kent `blocks` niet
  // en die union uitbreiden zou `guard.ts` raken; bovendien scheelt dit een
  // tweede rondgang. FAIL-CLOSED: een mislukte controle is geen toestemming.
  const { data, error } = await supabase
    .from("blocks")
    .select("id")
    .eq("id", blockId)
    .eq("building_id", buildingId)
    .eq("organization_id", orgId)
    .maybeSingle();

  return !error && data !== null;
}

function terug(buildingId: string) {
  revalidatePath(`/buildings/${buildingId}/indeling`);
  revalidatePath(`/buildings/${buildingId}/lots`);
  return localeRedirect(`/buildings/${buildingId}/indeling`);
}

// ── blokken ─────────────────────────────────────────────────────────────────

export async function createBlock(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return verboden();

  const parsed = parseForm(blockCreateSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, code, name, sort_order } = parsed.data;

  const supabase = await createClient();
  if (await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw")) {
    return verboden();
  }

  // `organization_id` gaat expliciet mee: de composite FK naar
  // buildings(id, organization_id) eist dat hij bij het gebouw past, en dat
  // maakt een blok in een vreemde organisatie onmogelijk.
  const { error } = await supabase
    .from("blocks")
    .insert({ building_id, organization_id: org.id, code, name, sort_order });

  if (error) {
    logFout("create-block", error);
    return fout(error);
  }
  return terug(building_id);
}

export async function updateBlock(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return verboden();

  const parsed = parseForm(blockUpdateSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, block_id, code, name, sort_order } = parsed.data;

  const supabase = await createClient();
  if (await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw")) {
    return verboden();
  }
  if (!(await blokInGebouw(supabase, block_id, org.id, building_id))) return verboden();

  const { error } = await supabase
    .from("blocks")
    .update({ code, name, sort_order })
    .eq("id", block_id)
    .eq("building_id", building_id);

  if (error) {
    logFout("update-block", error);
    return fout(error);
  }
  return terug(building_id);
}

export async function setBlockArchived(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return verboden();

  const parsed = parseForm(blockArchiveSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, block_id, archived } = parsed.data;

  const supabase = await createClient();
  if (await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw")) {
    return verboden();
  }
  if (!(await blokInGebouw(supabase, block_id, org.id, building_id))) return verboden();

  const { error } = await supabase
    .from("blocks")
    .update({ archived_at: archived === "true" ? new Date().toISOString() : null })
    .eq("id", block_id)
    .eq("building_id", building_id);

  if (error) {
    logFout("archive-block", error);
    return fout(error);
  }
  return terug(building_id);
}

// ── lots ────────────────────────────────────────────────────────────────────

/**
 * De rijen uit het bulkformulier.
 *
 * Het formulier post geïndexeerde velden (`label_0`, `unit_type_0`, …) in
 * plaats van één JSON-blob: zo blijft elk veld een gewoon formulierveld dat de
 * browser zelf valideert, en is er geen parse-stap die stilletjes kan mislukken.
 *
 * Rijen die VOLLEDIG leeg zijn worden overgeslagen — een gebruiker die drie
 * regels opent en er twee invult, bedoelt twee lots. Een half ingevulde rij
 * wordt NIET overgeslagen maar afgekeurd; anders zou een vergeten label
 * stilzwijgend een lot minder opleveren.
 */
function leesRijen(formData: FormData): { ok: true; rijen: unknown[] } | { ok: false } {
  const aantal = Number(formData.get("rows") ?? 0);
  if (!Number.isInteger(aantal) || aantal < 0 || aantal > 200) return { ok: false };

  const rijen: unknown[] = [];
  for (let i = 0; i < aantal; i += 1) {
    const label = String(formData.get(`label_${i}`) ?? "").trim();
    const tantiemes = String(formData.get(`tantiemes_${i}`) ?? "").trim();
    const unitType = String(formData.get(`unit_type_${i}`) ?? "").trim();
    if (label === "" && tantiemes === "" && unitType === "") continue;
    rijen.push({ label, unit_type: unitType || undefined, tantiemes: tantiemes || "0" });
  }
  return { ok: true, rijen };
}

export async function createLotsBulk(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return verboden();

  const gelezen = leesRijen(formData);
  if (!gelezen.ok) {
    const t = await getTranslations("indeling.errors");
    return { error: t("generic") };
  }

  const parsed = bulkLotsSchema.safeParse({
    building_id: formData.get("building_id"),
    block_id: formData.get("block_id"),
    rows: gelezen.rijen,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Ongeldige invoer." };
  }
  const { building_id, block_id, rows } = parsed.data;

  const supabase = await createClient();
  if (await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw")) {
    return verboden();
  }
  if (block_id !== null && !(await blokInGebouw(supabase, block_id, org.id, building_id))) {
    return verboden();
  }

  // ÉÉN insert met alle rijen. PostgREST stuurt dat als één INSERT-statement,
  // dus één schending laat de hele set mislukken — alles of niets, zonder dat
  // daar een RPC of expliciete transactie voor nodig is.
  const { error } = await supabase.from("units").insert(
    rows.map((rij) => ({
      building_id,
      block_id,
      label: rij.label,
      unit_type: rij.unit_type,
      tantiemes: rij.tantiemes,
    })),
  );

  if (error) {
    logFout("bulk-create-lots", error);
    return fout(error);
  }
  return terug(building_id);
}

export async function updateLotLayout(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return verboden();

  const parsed = parseForm(lotLayoutUpdateSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, unit_id, label, unit_type, tantiemes, block_id } = parsed.data;

  const supabase = await createClient();
  if (await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw")) {
    return verboden();
  }
  // Het lot moet bij DIT gebouw horen, niet alleen bij de organisatie.
  if (await assertUnitInOrg(supabase, unit_id, org.id, building_id)) return verboden();
  // En het doelblok ook. De composite FK weigert dit ook, maar dan met een
  // databasefout in plaats van een begrijpelijke melding.
  if (block_id !== null && !(await blokInGebouw(supabase, block_id, org.id, building_id))) {
    return verboden();
  }

  const { error } = await supabase
    .from("units")
    .update({ label, unit_type, tantiemes, block_id })
    .eq("id", unit_id)
    .eq("building_id", building_id);

  if (error) {
    logFout("update-lot", error);
    return fout(error);
  }
  return terug(building_id);
}

/**
 * Een lot verwijderen.
 *
 * ── VIER LAGEN, EN DE LAATSTE IS DE ENIGE HARDE ────────────────────────────
 *
 *   1. de knop staat er alleen voor een schrijfrol;
 *   2. er is een bevestigingspaneel, geen knop die meteen vernietigt;
 *   3. deze actie controleert rol, bevestiging en gebouwscope;
 *   4. `trig_00_unit_delete_history` weigert onafhankelijk zodra het lot in
 *      `charge_allocations` voorkomt.
 *
 * Laag 4 is de reden dat dit veilig is. De rest bestaat om een begrijpelijke
 * melding te kunnen geven in plaats van een databasefout.
 *
 * WAT ER MEEVERDWIJNT: de `ownership`-rijen van dit lot (ON DELETE CASCADE) en
 * zijn lidmaatschap van verdeelregels. Dat is inrichting, geen financiële
 * historie — die maakt verwijderen juist onmogelijk.
 */
export async function deleteLot(formData: FormData) {
  const { org, role } = await requireOrg();
  if (!canWrite(role)) return verboden();

  const parsed = parseForm(lotDeleteSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, unit_id } = parsed.data;

  const supabase = await createClient();
  if (await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw")) {
    return verboden();
  }
  // Het lot moet bij DIT gebouw én deze organisatie horen. Zonder deze controle
  // zou een gemanipuleerd formulier een lot uit een ander gebouw verwijderen.
  if (await assertUnitInOrg(supabase, unit_id, org.id, building_id)) return verboden();

  const { error } = await supabase
    .from("units")
    .delete()
    .eq("id", unit_id)
    .eq("building_id", building_id);

  if (error) {
    logVerwijderFout("delete-lot", error);
    return verwijderFout(error);
  }
  return terug(building_id);
}

/** De melding bij een mislukte verwijdering: altijd een sleutel, nooit DB-tekst. */
async function verwijderFout(error: unknown): Promise<{ error: string }> {
  const t = await getTranslations("indeling.errors");
  return { error: t(deleteErrorKey(error as { code?: string; message?: string })) };
}

function logVerwijderFout(actie: string, error: unknown) {
  console.error(
    `[indeling] ${actie} ${deleteErrorFingerprint(error as { code?: string; message?: string })}`,
  );
}

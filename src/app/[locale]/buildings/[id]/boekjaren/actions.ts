"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { localeRedirect } from "@/lib/redirect";
import {
  chargeCallSchema,
  fiscalYearSchema,
  parseForm,
  paymentSchema,
} from "@/lib/validation";
import { assertFiscalYearWritable, assertInOrg } from "@/lib/guard";
import { isDuplicateYear, toUserError } from "@/lib/errors";

export async function createFiscalYear(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(fiscalYearSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, year, start_date, end_date } = parsed.data;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (guard) return { error: guard };

  const { data, error } = await supabase
    .from("fiscal_years")
    .insert({
      organization_id: org.id, // P1-1: was ontbrekend -> NOT NULL-violatie
      building_id,
      year,
      start_date,
      end_date,
      status: "open",
    })
    .select("id")
    .single();

  if (error || !data) {
    if (isDuplicateYear(error)) return { error: `__duplicate_year__${year}` };
    return { error: toUserError(error, "Aanmaken van het boekjaar is mislukt.") };
  }

  revalidatePath(`/buildings/${building_id}/boekjaren`);
  return localeRedirect(`/buildings/${building_id}/boekjaren/${data.id}`);
}

/**
 * Leest de handmatige bedragen uit het formulier.
 *
 * Velden heten `manual_<unit_id>` en bevatten een bedrag in MAD. Lege velden
 * tellen als 0,00 en worden dus wél meegestuurd: bij een handmatige verdeling
 * moet elk deelnemend lot een bedrag hebben, en een stilzwijgend weggelaten lot
 * zou precies de fout zijn die deze engine uitsluit.
 */
type ManualLine = { unit_id: string; amount_cents: number };

function collectManualLines(
  formData: FormData,
): { invalid: true } | { invalid: false; lines: ManualLine[] | null } {
  const lines: ManualLine[] = [];
  let ingevuld = false;

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("manual_")) continue;
    const unitId = key.slice("manual_".length);
    const raw = String(value).trim().replace(",", ".");
    if (raw !== "") ingevuld = true;
    const mad = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(mad)) return { invalid: true };
    lines.push({ unit_id: unitId, amount_cents: Math.round(mad * 100) });
  }

  // Het rooster staat altijd in het formulier; is er niets ingevuld, dan is dit
  // geen handmatige verdeling en sturen we niets mee.
  return { invalid: false, lines: ingevuld ? lines : null };
}

/**
 * Legt een lastenoproep vast via de atomische database-RPC.
 *
 * De RPC doet regelvalidatie, scope- en eigenaarsresolutie, de snapshot, de
 * centverdeling, de somcontrole en de journaalpost in één transactie. Er is geen
 * tweede schrijfpad: rechtstreeks invoegen op `charge_calls` is voor
 * `authenticated` geblokkeerd, zodat de snapshotkop nooit door de client kan
 * worden gevuld en dus nooit iets anders kan zeggen dan de gebruikte regel.
 */
export async function createChargeCall(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(chargeCallSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { fiscal_year_id, allocation_rule_id, ...call } = parsed.data;

  const manual = collectManualLines(formData);
  if (manual.invalid) {
    return { error: "Een van de handmatige bedragen is geen geldig getal." };
  }

  const supabase = await createClient();

  // Deze lookup is nodig voor de redirect én is de eerste tenant-controle; de
  // RPC controleert organisatie, rechten en boekjaarstatus daarna zelf opnieuw.
  const { data: fy, error: fyError } = await supabase
    .from("fiscal_years")
    .select("organization_id, building_id, status")
    .eq("id", fiscal_year_id)
    .maybeSingle();

  if (fyError || !fy || fy.organization_id !== org.id) {
    return { error: "Boekjaar bestaat niet binnen deze organisatie." };
  }
  if (fy.status === "closed") {
    return { error: "Dit boekjaar is afgesloten en kan niet meer worden gewijzigd." };
  }

  const { error } = await supabase.rpc("create_charge_call", {
    p_fiscal_year_id: fiscal_year_id,
    p_type: call.type,
    p_total_amount: call.total_amount,
    p_call_date: call.call_date,
    p_due_date: call.due_date,
    p_period: call.period,
    p_label: call.label,
    p_resolution_ref: null,
    p_allocation_rule_id: allocation_rule_id,
    p_manual_lines: manual.lines,
  });

  if (error) return { error: toUserError(error, "Aanmaken van de lastenoproep is mislukt.") };

  revalidatePath(`/buildings/${fy.building_id}/boekjaren/${fiscal_year_id}`);
  return localeRedirect(`/buildings/${fy.building_id}/boekjaren/${fiscal_year_id}`);
}

export async function createPayment(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(paymentSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, fiscal_year_id, owner_id, ...payment } = parsed.data;

  const supabase = await createClient();

  const buildingGuard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (buildingGuard) return { error: buildingGuard };

  const fyGuard = await assertFiscalYearWritable(supabase, fiscal_year_id, org.id, building_id);
  if (fyGuard) return { error: fyGuard };

  const ownerGuard = await assertInOrg(supabase, "owners", owner_id, org.id, "Eigenaar");
  if (ownerGuard) return { error: ownerGuard };

  // FIFO-toewijzing, journaalpost en verwerking van een eventuele overbetaling
  // gebeuren deterministisch in database-triggers binnen dezelfde transactie.
  const { error } = await supabase.from("payments").insert({
    organization_id: org.id, // P1-1: was ontbrekend
    building_id,
    owner_id,
    ...payment,
  });

  if (error) return { error: toUserError(error, "Registreren van de betaling is mislukt.") };

  revalidatePath(`/buildings/${building_id}/boekjaren/${fiscal_year_id}`);
  return localeRedirect(`/buildings/${building_id}/boekjaren/${fiscal_year_id}`);
}

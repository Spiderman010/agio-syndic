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

export async function createChargeCall(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(chargeCallSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { fiscal_year_id, ...call } = parsed.data;

  const supabase = await createClient();

  // Eén lookup die zowel de tenant-check, de statuscheck als het gebouw levert;
  // een tweede query zou bij een lege uitkomst een /buildings/undefined-redirect
  // opleveren.
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

  const { error } = await supabase.from("charge_calls").insert({
    organization_id: org.id, // P1-1: was ontbrekend
    fiscal_year_id,
    ...call,
    // building_id bestaat NIET op charge_calls; de keten loopt via fiscal_year_id.
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

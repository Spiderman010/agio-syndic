"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { redirect } from "@/navigation";
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
  if (parsed.error) return { error: parsed.error };
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
  redirect(`/buildings/${building_id}/boekjaren/${data.id}`);
}

export async function createChargeCall(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(chargeCallSchema, formData);
  if (parsed.error) return { error: parsed.error };
  const { fiscal_year_id, ...call } = parsed.data;

  const supabase = await createClient();

  // Boekjaar moet bij de organisatie horen én open zijn.
  const guard = await assertFiscalYearWritable(supabase, fiscal_year_id, org.id);
  if (guard) return { error: guard };

  const { data: fy } = await supabase
    .from("fiscal_years")
    .select("building_id")
    .eq("id", fiscal_year_id)
    .single();

  const { error } = await supabase.from("charge_calls").insert({
    organization_id: org.id, // P1-1: was ontbrekend
    fiscal_year_id,
    ...call,
    // building_id bestaat NIET op charge_calls; de keten loopt via fiscal_year_id.
  });

  if (error) return { error: toUserError(error, "Aanmaken van de lastenoproep is mislukt.") };

  revalidatePath(`/buildings/${fy?.building_id}/boekjaren/${fiscal_year_id}`);
  redirect(`/buildings/${fy?.building_id}/boekjaren/${fiscal_year_id}`);
}

export async function createPayment(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(paymentSchema, formData);
  if (parsed.error) return { error: parsed.error };
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
  redirect(`/buildings/${building_id}/boekjaren/${fiscal_year_id}`);
}

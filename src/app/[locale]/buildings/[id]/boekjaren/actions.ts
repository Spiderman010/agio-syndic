"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { redirect } from "@/navigation";

export async function createFiscalYear(formData: FormData) {
  await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const year = parseInt(String(formData.get("year") ?? ""), 10);
  const start_date = String(formData.get("start_date") ?? "");
  const end_date = String(formData.get("end_date") ?? "");

  if (!buildingId || !year || !start_date || !end_date) return { error: "Alle velden verplicht." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fiscal_years")
    .insert({ building_id: buildingId, year, start_date, end_date, status: "open" })
    .select("id")
    .single();

  if (error || !data) return { error: error?.message ?? "Aanmaken mislukt." };
  revalidatePath(`/buildings/${buildingId}/boekjaren`);
  redirect(`/buildings/${buildingId}/boekjaren/${data.id}`);
}

export async function createChargeCall(formData: FormData) {
  await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const fiscalYearId = String(formData.get("fiscal_year_id") ?? "");
  const type = String(formData.get("type") ?? "regulier");
  const period = String(formData.get("period") ?? "").trim() || null;
  const label = String(formData.get("label") ?? "").trim() || null;
  const total_amount = parseFloat(String(formData.get("total_amount") ?? "").replace(",", "."));
  const call_date = String(formData.get("call_date") ?? "");
  const due_date = String(formData.get("due_date") ?? "").trim() || null;

  if (!fiscalYearId || isNaN(total_amount) || !call_date) return { error: "Bedrag en datum zijn verplicht." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("charge_calls")
    .insert({ building_id: buildingId, fiscal_year_id: fiscalYearId, type, period, label, total_amount, call_date, due_date });

  if (error) return { error: error.message };
  revalidatePath(`/buildings/${buildingId}/boekjaren/${fiscalYearId}`);
  redirect(`/buildings/${buildingId}/boekjaren/${fiscalYearId}`);
}

export async function createPayment(formData: FormData) {
  await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const fiscalYearId = String(formData.get("fiscal_year_id") ?? "");
  const ownerId = String(formData.get("owner_id") ?? "");
  const amount = parseFloat(String(formData.get("amount") ?? "").replace(",", "."));
  const value_date = String(formData.get("value_date") ?? "");
  const method = String(formData.get("method") ?? "virement");
  const reference = String(formData.get("reference") ?? "").trim() || null;

  if (!ownerId || isNaN(amount) || !value_date) return { error: "Eigenaar, bedrag en datum zijn verplicht." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("payments")
    .insert({ building_id: buildingId, owner_id: ownerId, amount, value_date, method, reference });

  if (error) return { error: error.message };
  revalidatePath(`/buildings/${buildingId}/boekjaren/${fiscalYearId}`);
  redirect(`/buildings/${buildingId}/boekjaren/${fiscalYearId}`);
}

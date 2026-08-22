"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ChargeCallType, PaymentMethod } from "@/lib/types";

export async function createFiscalYear(formData: FormData) {
  const { org } = await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "").trim();
  const year       = Number(formData.get("year") ?? 0);
  const start_date = String(formData.get("start_date") ?? "").trim();
  const end_date   = String(formData.get("end_date") ?? "").trim();

  if (!buildingId || !year || !start_date || !end_date)
    redirect(`/buildings/${buildingId}/boekjaren?error=${encodeURIComponent("Vul alle velden in")}`);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fiscal_years")
    .insert({ organization_id: org.id, building_id: buildingId, year, start_date, end_date })
    .select("id")
    .single();

  if (error)
    redirect(`/buildings/${buildingId}/boekjaren?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/buildings/${buildingId}/boekjaren`);
  redirect(`/buildings/${buildingId}/boekjaren/${data!.id}`);
}

export async function createChargeCall(formData: FormData) {
  await requireOrg();
  const buildingId   = String(formData.get("building_id") ?? "").trim();
  const fyId         = String(formData.get("fiscal_year_id") ?? "").trim();
  const type         = (String(formData.get("type") ?? "regulier") as ChargeCallType);
  const period       = String(formData.get("period") ?? "").trim() || null;
  const label        = String(formData.get("label") ?? "").trim() || null;
  const total_amount = parseFloat(String(formData.get("total_amount") ?? "0").replace(",", "."));
  const call_date    = String(formData.get("call_date") ?? "").trim();
  const due_date     = String(formData.get("due_date") ?? "").trim() || null;

  if (!fyId || !total_amount || !call_date)
    redirect(`/buildings/${buildingId}/boekjaren/${fyId}?error=${encodeURIComponent("Bedrag en datum zijn verplicht")}`);

  const supabase = await createClient();

  // Haal organization_id op via fiscal_year
  const { data: fy } = await supabase
    .from("fiscal_years")
    .select("organization_id")
    .eq("id", fyId)
    .single();

  const { error } = await supabase
    .from("charge_calls")
    .insert({
      organization_id: fy?.organization_id,
      fiscal_year_id: fyId,
      type,
      period,
      label,
      total_amount,
      call_date,
      due_date,
    });

  if (error)
    redirect(`/buildings/${buildingId}/boekjaren/${fyId}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/buildings/${buildingId}/boekjaren/${fyId}`);
  redirect(`/buildings/${buildingId}/boekjaren/${fyId}`);
}

export async function createPayment(formData: FormData) {
  const { org } = await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "").trim();
  const fyId       = String(formData.get("fiscal_year_id") ?? "").trim();
  const owner_id   = String(formData.get("owner_id") ?? "").trim();
  const amount     = parseFloat(String(formData.get("amount") ?? "0").replace(",", "."));
  const method     = (String(formData.get("method") ?? "virement") as PaymentMethod);
  const value_date = String(formData.get("value_date") ?? "").trim();
  const reference  = String(formData.get("reference") ?? "").trim() || null;

  if (!buildingId || !owner_id || !amount || !value_date)
    redirect(`/buildings/${buildingId}/boekjaren/${fyId}?error=${encodeURIComponent("Vul alle betalingsvelden in")}`);

  const supabase = await createClient();
  const { error } = await supabase
    .from("payments")
    .insert({ organization_id: org.id, building_id: buildingId, owner_id, amount, method, value_date, reference });

  if (error)
    redirect(`/buildings/${buildingId}/boekjaren/${fyId}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/buildings/${buildingId}/boekjaren/${fyId}`);
  redirect(`/buildings/${buildingId}/boekjaren/${fyId}#betalingen`);
}

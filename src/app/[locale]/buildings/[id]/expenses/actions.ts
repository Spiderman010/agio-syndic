"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { redirect } from "@/navigation";

export async function createExpenseCategory(formData: FormData) {
  const { org } = await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  if (!name) return { error: "Naam is verplicht." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("expense_categories")
    .insert({ organization_id: org.id, name });

  if (error) return { error: error.message };
  revalidatePath(`/buildings/${buildingId}/expenses`);
  redirect(`/buildings/${buildingId}/expenses`);
}

export async function createExpense(formData: FormData) {
  const { org } = await requireOrg();
  const buildingId = String(formData.get("building_id") ?? "");
  const fiscalYearId = String(formData.get("fiscal_year_id") ?? "").trim() || null;
  const categoryId = String(formData.get("category_id") ?? "").trim() || null;
  const supplier = String(formData.get("supplier") ?? "").trim() || null;
  const description = String(formData.get("description") ?? "").trim() || null;
  const amount = parseFloat(String(formData.get("amount") ?? "").replace(",", "."));
  const expense_date = String(formData.get("expense_date") ?? "");

  if (!buildingId || isNaN(amount) || amount <= 0 || !expense_date) {
    return { error: "Montant et date sont obligatoires." };
  }

  const supabase = await createClient();

  let receipt_url: string | null = null;
  const receiptFile = formData.get("receipt") as File | null;
  if (receiptFile && receiptFile.size > 0) {
    const ext = receiptFile.name.split(".").pop()?.toLowerCase() ?? "bin";
    const safeDate = expense_date.replace(/-/g, "");
    const path = `${org.id}/${buildingId}/${safeDate}_${Date.now()}.${ext}`;
    const buffer = Buffer.from(await receiptFile.arrayBuffer());
    const { error: uploadErr } = await supabase.storage
      .from("receipts")
      .upload(path, buffer, { contentType: receiptFile.type, upsert: false });
    if (!uploadErr) {
      const { data: signed } = await supabase.storage
        .from("receipts")
        .createSignedUrl(path, 315360000); // 10 ans
      receipt_url = signed?.signedUrl ?? null;
    }
  }

  const { error } = await supabase.from("expenses").insert({
    organization_id: org.id,
    building_id: buildingId,
    fiscal_year_id: fiscalYearId,
    category_id: categoryId,
    supplier,
    description,
    amount,
    expense_date,
    receipt_url,
  });

  if (error) return { error: error.message };
  revalidatePath(`/buildings/${buildingId}/expenses`);
  redirect(`/buildings/${buildingId}/expenses`);
}

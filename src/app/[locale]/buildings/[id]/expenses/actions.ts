"use server";

import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { localeRedirect } from "@/lib/redirect";
import { expenseCategorySchema, expenseSchema, parseForm } from "@/lib/validation";
import { assertFiscalYearWritable, assertInOrg, assertInOrgOptional } from "@/lib/guard";
import { toUserError } from "@/lib/errors";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/**
 * Toegestane bewijsstuktypen. Het MIME-type wordt uit de EXTENSIE afgeleid en
 * niet uit de door de client aangeleverde `File.type`, die vervalsbaar is.
 */
const RECEIPT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
};

export async function createExpenseCategory(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(expenseCategorySchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, name } = parsed.data;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (guard) return { error: guard };

  const { error } = await supabase
    .from("expense_categories")
    .insert({ organization_id: org.id, name });

  if (error) return { error: toUserError(error, "Toevoegen van de categorie is mislukt.") };

  revalidatePath(`/buildings/${building_id}/expenses`);
  return localeRedirect(`/buildings/${building_id}/expenses`);
}

export async function createExpense(formData: FormData) {
  const { org } = await requireOrg();

  const parsed = parseForm(expenseSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { building_id, fiscal_year_id, category_id, ...expense } = parsed.data;

  const supabase = await createClient();

  // P1-6: elke aangeleverde UUID expliciet tegen de actieve organisatie toetsen.
  const buildingGuard = await assertInOrg(supabase, "buildings", building_id, org.id, "Gebouw");
  if (buildingGuard) return { error: buildingGuard };

  const categoryGuard = await assertInOrgOptional(
    supabase,
    "expense_categories",
    category_id,
    org.id,
    "Categorie",
  );
  if (categoryGuard) return { error: categoryGuard };

  if (fiscal_year_id !== null) {
    const fyGuard = await assertFiscalYearWritable(supabase, fiscal_year_id, org.id, building_id);
    if (fyGuard) return { error: fyGuard };
  }

  // ---- Bewijsstuk ---------------------------------------------------------
  // P1-7: een mislukte upload mag nooit stil worden genegeerd.
  // P0-3: we bewaren het OBJECTPAD, niet een langlevende signed URL.
  let receipt_path: string | null = null;
  const file = formData.get("receipt");

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RECEIPT_BYTES) {
      return { error: "Het bewijsstuk is groter dan 10 MB." };
    }

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const contentType = RECEIPT_TYPES[ext];
    if (!contentType) {
      return { error: "Alleen JPG, PNG, WEBP, HEIC of PDF is toegestaan als bewijsstuk." };
    }

    const path = `${org.id}/${building_id}/${randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("receipts")
      .upload(path, buffer, { contentType, upsert: false });

    if (uploadError) {
      return {
        error: `Het bewijsstuk kon niet worden opgeslagen: ${uploadError.message}. De uitgave is niet geregistreerd.`,
      };
    }
    receipt_path = path;
  }

  const { error } = await supabase.from("expenses").insert({
    organization_id: org.id,
    building_id,
    fiscal_year_id,
    category_id,
    receipt_path,
    ...expense,
  });

  if (error) {
    // Geen weesbestand achterlaten wanneer de boeking faalt.
    if (receipt_path) {
      await supabase.storage.from("receipts").remove([receipt_path]);
    }
    return { error: toUserError(error, "Registreren van de uitgave is mislukt.") };
  }

  revalidatePath(`/buildings/${building_id}/expenses`);
  return localeRedirect(`/buildings/${building_id}/expenses`);
}

/**
 * P0-3: genereert een kortlevende signed URL voor één bewijsstuk.
 *
 * De URL wordt pas op het moment van opvragen aangemaakt, na controle dat de
 * uitgave tot de actieve organisatie behoort, en verloopt na 60 seconden.
 * Er wordt niets langlevends in de database bewaard.
 */
export async function getReceiptUrl(expenseId: string): Promise<{ url?: string; error?: string }> {
  const { org } = await requireOrg();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("expenses")
    .select("organization_id, receipt_path, receipt_url")
    .eq("id", expenseId)
    .maybeSingle();

  if (error || !data) return { error: "Bewijsstuk niet gevonden." };
  if (data.organization_id !== org.id) return { error: "Bewijsstuk niet gevonden." };

  // Terugval voor uitgaven van vóór de migratie naar receipt_path.
  const path = data.receipt_path ?? extractLegacyPath(data.receipt_url);
  if (!path) return { error: "Bij deze uitgave hoort geen bewijsstuk." };

  const { data: signed, error: signError } = await supabase.storage
    .from("receipts")
    .createSignedUrl(path, 60);

  if (signError || !signed?.signedUrl) {
    return { error: "Het bewijsstuk kon niet worden geopend." };
  }
  return { url: signed.signedUrl };
}

function extractLegacyPath(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/object\/(?:sign|public)\/receipts\/([^?]+)/);
  return match?.[1] ?? null;
}

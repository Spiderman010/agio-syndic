"use server";

import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { getActiveOrg, requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { localeRedirect } from "@/lib/redirect";
import {
  correctExpenseSchema,
  expenseCategorySchema,
  expenseSchema,
  parseForm,
  reversalValidationKey,
  reverseExpenseSchema,
} from "@/lib/validation";
import { assertFiscalYearWritable, assertInOrg, assertInOrgOptional } from "@/lib/guard";
import { toUserError } from "@/lib/errors";
import { getLocale, getTranslations } from "next-intl/server";
import { reversalErrorFingerprint, reversalErrorKey } from "@/lib/reversalErrors";

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

// ---------------------------------------------------------------------------
// Financial Reversal Engine — uitgaven (m24–m28)
// ---------------------------------------------------------------------------
//
// Zelfde vorm als bij betalingen: valideren, tenant controleren, één RPC. De
// storno spiegelt de HISTORISCHE journaalregels, dus een intussen gewijzigde
// standaardrekening van een categorie kan de tegenboeking niet verplaatsen.
// Dat gebeurt volledig in de database en wordt hier niet nagerekend.

type ExpenseReversalResult = { error?: string };

/** Sessie, vertalingen en de uitgave zelf; incl. tenantcontrole. */
async function prepareExpenseReversal(expenseId: string) {
  const t = await getTranslations("reversal");

  const active = await getActiveOrg();
  if (!active) return { error: t("errors.notAuthenticated") } as const;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "expenses", expenseId, active.org.id, "Uitgave");
  if (guard) return { error: t("errors.notFound") } as const;

  const { data, error } = await supabase
    .from("expenses")
    .select("id, building_id, account_id, receipt_path")
    .eq("id", expenseId)
    .maybeSingle();

  if (error || !data) return { error: t("errors.notFound") } as const;

  return {
    ok: true as const,
    t,
    supabase,
    org: active.org,
    buildingId: data.building_id as string,
    accountId: (data.account_id as string | null) ?? null,
    receiptPath: (data.receipt_path as string | null) ?? null,
  };
}

function mapExpenseReversalError(
  error: { code?: string | null; message?: string | null } | null,
  t: Awaited<ReturnType<typeof getTranslations<"reversal">>>,
  context: string,
): string {
  const key = reversalErrorKey(error);
  if (key === "unknown") {
    console.error(`[reversal] ${context} ${reversalErrorFingerprint(error)}`);
  }
  return t(`errors.${key}` as Parameters<typeof t>[0]);
}

export async function reverseExpense(formData: FormData): Promise<ExpenseReversalResult> {
  // formData.get() geeft de EERSTE waarde van een herhaalde sleutel, parseForm()
  // de LAATSTE. Zonder override zou de tenantcontrole op de ene uitgave draaien
  // en de RPC op de andere. De gecontroleerde id wint.
  const rawId = formData.get("expense_id");
  const expenseId = typeof rawId === "string" ? rawId : "";
  const prep = await prepareExpenseReversal(expenseId);
  if ("error" in prep) return prep;
  const { t, supabase, buildingId } = prep;

  const parsed = parseForm(reverseExpenseSchema, formData, { expense_id: expenseId });
  if (!parsed.ok) {
    return { error: t(`errors.${reversalValidationKey(parsed.error)}` as Parameters<typeof t>[0]) };
  }

  const { error } = await supabase.rpc("reverse_expense", {
    p_expense_id: parsed.data.expense_id,
    p_reason: parsed.data.reason,
  });

  if (error) return { error: mapExpenseReversalError(error, t, "reverse_expense") };

  // Met de locale erbij: localePrefix staat op "always", dus zonder /fr komt het
  // pad met geen enkele gerenderde route overeen.
  revalidatePath(`/${await getLocale()}/buildings/${buildingId}/expenses`);
  return {};
}

export async function correctExpense(formData: FormData): Promise<ExpenseReversalResult> {
  // Zie reverseExpense: de gecontroleerde id wint van een herhaalde formulierwaarde.
  // Dit is hier extra belangrijk omdat accountId en receiptPath van DEZE rij
  // worden overgenomen; zonder override zouden ze bij een andere uitgave belanden.
  const rawId = formData.get("expense_id");
  const expenseId = typeof rawId === "string" ? rawId : "";
  const prep = await prepareExpenseReversal(expenseId);
  if ("error" in prep) return prep;
  const { t, supabase, org, buildingId, accountId, receiptPath } = prep;

  const parsed = parseForm(correctExpenseSchema, formData, { expense_id: expenseId });
  if (!parsed.ok) {
    return { error: t(`errors.${reversalValidationKey(parsed.error)}` as Parameters<typeof t>[0]) };
  }
  const { expense_id, amount, expense_date, category_id, supplier, description, reason } =
    parsed.data;

  const categoryGuard = await assertInOrgOptional(
    supabase,
    "expense_categories",
    category_id,
    org.id,
    "Categorie",
  );
  if (categoryGuard) return { error: t("errors.notFound") };

  // Bewijsstuk. Wordt er een nieuw bestand meegestuurd, dan gaat dat door
  // exact dezelfde controles als bij createExpense — extensie bepaalt het
  // MIME-type, niet de door de client aangeleverde File.type. Zonder nieuw
  // bestand erft de correctie het pad van het origineel, zodat het
  // justificatief niet verdwijnt. Er wordt hier GEEN nieuwe uploadarchitectuur
  // gebouwd; dit is dezelfde bucket, hetzelfde padpatroon.
  let nieuwPad: string | null = null;
  const file = formData.get("receipt");

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RECEIPT_BYTES) {
      return { error: t("errors.receiptTooLarge") };
    }
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const contentType = RECEIPT_TYPES[ext];
    if (!contentType) {
      return { error: t("errors.receiptTypeInvalid") };
    }

    const path = `${org.id}/${buildingId}/${randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await supabase.storage
      .from("receipts")
      .upload(path, buffer, { contentType, upsert: false });

    if (uploadError) {
      return { error: t("errors.unknown") };
    }
    nieuwPad = path;
  }

  const { error } = await supabase.rpc("correct_expense", {
    p_expense_id: expense_id,
    p_amount: amount,
    p_expense_date: expense_date,
    // De grootboekrekening komt van de ORIGINELE uitgave en niet van de client:
    // de invoerflow laat hem ook niet kiezen, en zo kan er geen vreemde rekening
    // worden meegesmokkeld. De composite FK zou dat sowieso weigeren.
    p_account_id: accountId,
    p_category_id: category_id,
    p_supplier: supplier,
    p_description: description,
    p_receipt_path: nieuwPad ?? receiptPath,
    p_reason: reason,
  });

  if (error) {
    // Geen weesbestand achterlaten wanneer de correctie faalt.
    if (nieuwPad) await supabase.storage.from("receipts").remove([nieuwPad]);
    return { error: mapExpenseReversalError(error, t, "correct_expense") };
  }

  revalidatePath(`/${await getLocale()}/buildings/${buildingId}/expenses`);
  return {};
}

"use server";

import { createClient } from "@/lib/supabase/server";
import { getActiveOrg, requireOrg } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { getLocale, getTranslations } from "next-intl/server";
import { localeRedirect } from "@/lib/redirect";
import {
  chargeCallSchema,
  correctPaymentSchema,
  fiscalYearSchema,
  parseForm,
  paymentSchema,
  reversalValidationKey,
  reversePaymentSchema,
} from "@/lib/validation";
import { assertFiscalYearWritable, assertInOrg } from "@/lib/guard";
import { isDuplicateYear, toUserError } from "@/lib/errors";
import { reversalErrorFingerprint, reversalErrorKey } from "@/lib/reversalErrors";

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

// ---------------------------------------------------------------------------
// Financial Reversal Engine — betalingen (m24–m28)
// ---------------------------------------------------------------------------
//
// Deze twee actions bevatten GEEN financiële logica. Ze valideren de invoer,
// controleren dat de betaling tot de actieve organisatie hoort, en roepen dan
// exact één RPC aan. Storno, neutralisatie van de toewijzingen, de gespiegelde
// journaalpost, FIFO op de vervangende betaling en de boekjaarkeuze gebeuren
// atomair in de database. Wordt dat hier gedupliceerd, dan bestaan er twee
// waarheden — en dat is precies wat de engine uitsluit.
//
// organization_id komt NOOIT uit FormData: hij wordt uit de actieve sessie
// gelezen. Een meegestuurde organization_id zou stilzwijgend worden genegeerd.

type ReversalResult = { error?: string };

/**
 * Gemeenschappelijke voorbereiding: sessie, vertalingen en de betaling zelf.
 *
 * Retourneert een foutmelding wanneer er geen sessie is (S1), wanneer het id
 * ongeldig is, of wanneer de betaling niet bij de actieve organisatie hoort.
 * Die laatste controle is de applicatielaag; RLS en `fn_reversal_authorize`
 * doen hem onafhankelijk nog een keer.
 */
async function preparePaymentReversal(paymentId: string) {
  const t = await getTranslations("reversal");

  const active = await getActiveOrg();
  if (!active) return { error: t("errors.notAuthenticated") } as const;

  const supabase = await createClient();

  const guard = await assertInOrg(supabase, "payments", paymentId, active.org.id, "Betaling");
  if (guard) return { error: t("errors.notFound") } as const;

  const { data, error } = await supabase
    .from("payments")
    .select("id, building_id")
    .eq("id", paymentId)
    .maybeSingle();

  if (error || !data) return { error: t("errors.notFound") } as const;

  return { ok: true as const, t, supabase, buildingId: data.building_id as string };
}

/**
 * Vertaalt het resultaat van een reversal-RPC naar een stabiele appfout.
 *
 * Onbekende fouten worden serverside gelogd met alleen een vingerafdruk —
 * SQLSTATE en engine-code. Bedragen, namen en de opgegeven reden zijn
 * financiële persoonsgegevens en horen niet in een log.
 */
function mapReversalError(
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

/**
 * Pad dat na een storno of correctie opnieuw moet worden opgehaald.
 *
 * De LOCALE hoort erbij. next-intl draait met localePrefix "always", dus de
 * werkelijke route is /fr/buildings/... — een pad zonder dat voorvoegsel komt
 * met geen enkele gerenderde route overeen en laat de client-routercache van de
 * gebruiker ongemoeid. Het gevolg zou een verouderde pagina zijn direct na een
 * storno, precies wanneer het bedrag ertoe doet.
 */
async function revalidateAfterReversal(buildingId: string, fiscalYearId: string | null) {
  const locale = await getLocale();
  if (fiscalYearId) {
    revalidatePath(`/${locale}/buildings/${buildingId}/boekjaren/${fiscalYearId}`);
  }
  revalidatePath(`/${locale}/buildings/${buildingId}/boekjaren`);
}

/** Het boekjaar waar de gebruiker vandaan komt; alleen voor revalidatie. */
function redirectFiscalYear(formData: FormData): string | null {
  const raw = formData.get("fy_id");
  if (typeof raw !== "string") return null;
  return /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;
}

export async function reversePayment(formData: FormData): Promise<ReversalResult> {
  // formData.get() geeft de EERSTE waarde van een herhaalde sleutel, terwijl
  // parseForm() over entries() loopt en dus de LAATSTE overhoudt. Bij een
  // dubbel meegestuurde payment_id zouden dat twee verschillende id's zijn: de
  // tenantcontrole zou de ene rij goedkeuren en de RPC op de andere losgaan.
  // De gecontroleerde id wordt daarom als override doorgegeven en is de enige
  // waarde die telt.
  const rawId = formData.get("payment_id");
  const paymentId = typeof rawId === "string" ? rawId : "";
  const prep = await preparePaymentReversal(paymentId);
  if ("error" in prep) return prep;
  const { t, supabase, buildingId } = prep;

  const parsed = parseForm(reversePaymentSchema, formData, { payment_id: paymentId });
  if (!parsed.ok) {
    return { error: t(`errors.${reversalValidationKey(parsed.error)}` as Parameters<typeof t>[0]) };
  }

  const { error } = await supabase.rpc("reverse_payment", {
    p_payment_id: parsed.data.payment_id,
    p_reason: parsed.data.reason,
  });

  if (error) return { error: mapReversalError(error, t, "reverse_payment") };

  await revalidateAfterReversal(buildingId, redirectFiscalYear(formData));
  return {};
}

export async function correctPayment(formData: FormData): Promise<ReversalResult> {
  // Zie reversePayment: de gecontroleerde id wint van een herhaalde formulierwaarde.
  const rawId = formData.get("payment_id");
  const paymentId = typeof rawId === "string" ? rawId : "";
  const prep = await preparePaymentReversal(paymentId);
  if ("error" in prep) return prep;
  const { t, supabase, buildingId } = prep;

  const parsed = parseForm(correctPaymentSchema, formData, { payment_id: paymentId });
  if (!parsed.ok) {
    return { error: t(`errors.${reversalValidationKey(parsed.error)}` as Parameters<typeof t>[0]) };
  }
  const { payment_id, amount, value_date, method, reference, reason } = parsed.data;

  // De database doet dit atomair: storno, neutralisatie, gespiegelde
  // journaalpost, nieuwe betaling, FIFO en journaal. Faalt er iets, dan rolt
  // alles terug en bestaat er geen halve correctie.
  const { error } = await supabase.rpc("correct_payment", {
    p_payment_id: payment_id,
    p_amount: amount,
    p_value_date: value_date,
    p_method: method,
    p_reference: reference,
    p_reason: reason,
  });

  if (error) return { error: mapReversalError(error, t, "correct_payment") };

  await revalidateAfterReversal(buildingId, redirectFiscalYear(formData));
  return {};
}

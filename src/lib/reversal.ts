import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Leeslaag voor de Financial Reversal Engine (m24–m28).
 *
 * BRUTO VERSUS NETTO — de kern van dit bestand.
 *
 * `payments.amount` en `expenses.amount` zijn onveranderlijke feiten: een storno
 * verlaagt ze niet en een correctie overschrijft ze niet. Een correctie van
 * 1000 naar 800 laat dus DRIE rijen achter waarvan de bruto som 1800 is, terwijl
 * de economische positie 800 is.
 *
 * Beide getallen zijn geldig, maar voor verschillende vragen:
 *
 *   BRUTO (klasse A)  "wat is er allemaal gebeurd" — lijsten, audit, historie.
 *                     Hier blijft ELKE rij zichtbaar, gemarkeerd als
 *                     gestorneerd of als correctie. Niets wordt weggefilterd.
 *   NETTO (klasse B)  "wat is de financiële positie" — totalen en dashboards.
 *                     Hier tellen gestorneerde brontransacties niet mee.
 *
 * Netto is hier GEEN `WHERE reversed = false` over de hele pagina; dat zou de
 * historie wissen. Het is uitsluitend een andere OPTELLING over exact dezelfde
 * rijenverzameling. De lijst blijft compleet.
 *
 * WAAROM DIT KAN ZONDER NIEUWE DATABASE-VIEW
 * `financial_reversals` is al leesbaar voor `authenticated` (RLS
 * `is_org_member` plus GRANT SELECT), en `v_financial_reversals` levert
 * daarbovenop de afgeleide vlaggen. De database blijft de bron van waarheid;
 * hier wordt niets herberekend, alleen gegroepeerd.
 *
 * De openstaande positie per eigenaar heeft dit NIET nodig: die volgt uit
 * `charge_allocations.amount - settled_amount`, en de engine herstelt
 * `settled_amount` bij een storno. Die berekening corrigeert zichzelf.
 */

export type ReversalSourceType = "payment" | "expense";

export type ReversalInfo = {
  reversalId: string;
  sourceType: ReversalSourceType;
  /** De originele transactie die is gestorneerd. */
  sourceId: string;
  /** De vervangende transactie bij een correctie, anders null. */
  correctionSourceId: string | null;
  reason: string;
  effectiveDate: string;
  /** True bij een correctie (storno + vervangende rij), false bij een kale storno. */
  isCorrection: boolean;
  /** True wanneer de storno in een ander boekjaar is geboekt dan het origineel. */
  isPriorYearCorrection: boolean;
};

/** Ruwe rij zoals `v_financial_reversals` hem teruggeeft. */
export type ReversalViewRow = {
  reversal_id: string;
  source_type: string;
  source_id: string;
  correction_source_id: string | null;
  reason: string | null;
  effective_date: string | null;
  is_correctie: boolean | null;
  is_correctie_vorig_boekjaar: boolean | null;
};

export type ReversalIndex = {
  /** origineel-id -> de storno die het neutraliseert. */
  bySource: Map<string, ReversalInfo>;
  /** vervangende-id -> de storno waar het de correctie van is. */
  byCorrection: Map<string, ReversalInfo>;
};

export const emptyReversalIndex = (): ReversalIndex => ({
  bySource: new Map(),
  byCorrection: new Map(),
});

/**
 * Bouwt de index uit ruwe view-rijen. Pure functie: geen database, geen I/O,
 * volledig unit-testbaar.
 */
export function buildReversalIndex(rows: readonly ReversalViewRow[]): ReversalIndex {
  const index = emptyReversalIndex();

  for (const row of rows) {
    if (row.source_type !== "payment" && row.source_type !== "expense") continue;

    const info: ReversalInfo = {
      reversalId: row.reversal_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      correctionSourceId: row.correction_source_id,
      reason: row.reason ?? "",
      effectiveDate: row.effective_date ?? "",
      isCorrection: row.is_correctie === true,
      isPriorYearCorrection: row.is_correctie_vorig_boekjaar === true,
    };

    index.bySource.set(info.sourceId, info);
    if (info.correctionSourceId) {
      index.byCorrection.set(info.correctionSourceId, info);
    }
  }

  return index;
}

/** Is deze transactie gestorneerd (al dan niet met vervangende rij)? */
export function isReversed(index: ReversalIndex, id: string): boolean {
  return index.bySource.has(id);
}

/** De storno die deze transactie neutraliseert, of null. */
export function reversalOf(index: ReversalIndex, id: string): ReversalInfo | null {
  return index.bySource.get(id) ?? null;
}

/** De storno waarvan deze transactie de VERVANGENDE rij is, of null. */
export function correctionOf(index: ReversalIndex, id: string): ReversalInfo | null {
  return index.byCorrection.get(id) ?? null;
}

/**
 * NETTO totaal (klasse B): som van alle bedragen, met uitzondering van
 * transacties die zijn gestorneerd.
 *
 * Een correctie van 1000 naar 800 levert 800: de originele 1000 is gestorneerd
 * en telt niet mee, de vervangende 800 is een gewone transactie en telt wel mee.
 * Een volledige storno levert 0. Een gewone transactie levert haar eigen bedrag.
 *
 * Werkt op EXACT dezelfde rijenverzameling als de lijst; er wordt niets
 * verborgen, alleen anders opgeteld.
 */
export function netTotal(
  rows: readonly { id: string; amount: number | string }[],
  index: ReversalIndex,
): number {
  let total = 0;
  for (const row of rows) {
    if (isReversed(index, row.id)) continue;
    total += Number(row.amount);
  }
  // Afronden op centen: de optelling van numeric(14,2)-waarden die via JSON als
  // float binnenkomen kan anders 0,000000001 afwijken.
  return Math.round(total * 100) / 100;
}

/** BRUTO totaal (klasse A): alles, ongeacht storno. Voor audit en historie. */
export function grossTotal(rows: readonly { amount: number | string }[]): number {
  let total = 0;
  for (const row of rows) total += Number(row.amount);
  return Math.round(total * 100) / 100;
}

/** Uitkomst van het ophalen, met de foutstatus expliciet erbij. */
export type ReversalIndexResult = {
  index: ReversalIndex;
  /**
   * `null` betekent: de query is GESLAAGD. Een geslaagde query met nul rijen
   * levert dus `{ index: <leeg>, error: null }` en is een geldige, betrouwbare
   * lege index. Is dit veld gevuld, dan is `index` betekenisloos en mag er
   * niets over de stornostatus worden beweerd.
   */
  error: unknown;
};

/**
 * Haalt de storno's op en geeft de FOUTSTATUS mee terug.
 *
 * Dit is de strikte variant en de enige die op een financieel scherm hoort.
 * Het verschil tussen "niets gestorneerd" en "we weten het niet" is hier geen
 * detail: wie een mislukte query als lege index leest, toont een gestorneerde
 * betaling als actief en zet er een stornoknop bij die de database zeker
 * weigert.
 *
 * Nul bron-id's is GEEN fout: er valt dan niets op te halen en de lege index
 * is dan de juiste, betrouwbare uitkomst.
 *
 * De autorisatie zit in RLS; een lid ziet alleen de eigen organisatie.
 */
export async function fetchReversalIndexResult(
  supabase: SupabaseClient,
  sourceType: ReversalSourceType,
  sourceIds: readonly string[],
): Promise<ReversalIndexResult> {
  if (sourceIds.length === 0) return { index: emptyReversalIndex(), error: null };

  const { data, error } = await supabase
    .from("v_financial_reversals")
    .select(
      "reversal_id, source_type, source_id, correction_source_id, reason, effective_date, is_correctie, is_correctie_vorig_boekjaar",
    )
    .eq("source_type", sourceType)
    .or(
      `source_id.in.(${sourceIds.join(",")}),correction_source_id.in.(${sourceIds.join(",")})`,
    );

  // `data === null` zonder error komt bij PostgREST niet voor op een lijstquery,
  // maar als het gebeurt weten we evenmin iets - dan is het ook een fout.
  if (error) return { index: emptyReversalIndex(), error };
  if (!data) return { index: emptyReversalIndex(), error: new Error("REVERSAL_NO_DATA") };

  return { index: buildReversalIndex(data as unknown as ReversalViewRow[]), error: null };
}

/**
 * Fail-open variant: bij een leesfout een LEGE index in plaats van een fout.
 *
 * LET OP - dit verzwijgt het verschil tussen "niets gestorneerd" en "de query
 * faalde". Op een scherm waar de stornostatus een bewering over geld is, of
 * waar er een storno- of correctieknop uit volgt, is dat onjuist; gebruik daar
 * `fetchReversalIndexResult()`.
 *
 * Sinds de fail-closed reparatie van het uitgavenscherm heeft deze variant GEEN
 * aanroeper meer in `src/`. Hij blijft alleen staan omdat verwijderen buiten de
 * scope van die hotfix viel; nieuwe aanroepers horen zonder uitzondering de
 * strikte variant te nemen.
 */
export async function fetchReversalIndex(
  supabase: SupabaseClient,
  sourceType: ReversalSourceType,
  sourceIds: readonly string[],
): Promise<ReversalIndex> {
  const { index } = await fetchReversalIndexResult(supabase, sourceType, sourceIds);
  return index;
}

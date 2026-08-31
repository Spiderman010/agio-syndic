import { engineErrorCode, type DbError } from "@/lib/errors";

/**
 * Vertaalslag van de STABIELE foutcodes van de reversal-engine (m24–m28) naar
 * next-intl-sleutels onder `reversal.errors`.
 *
 * De engine werpt zijn meldingen als `CODE: Nederlandse uitleg`. Die codes zijn
 * het contract; de Nederlandse tekst erachter is voor de ontwikkelaar en mag
 * NOOIT in de UI belanden — de app is Frans. `engineErrorCode()` uit
 * `lib/errors.ts` haalt de code eruit; hier wordt hij op een sleutel gemapt.
 *
 * Onbekende codes vallen bewust terug op één generieke melding. Een gebruiker
 * die "SETTLEMENT_NOT_DERIVED: settled_amount mag alleen volgen uit..." te zien
 * krijgt, leert daar niets van en het lekt schema-informatie.
 */

const KEYS: Record<string, string> = {
  // --- al gestorneerd -------------------------------------------------------
  ALREADY_REVERSED: "alreadyReversed",

  // --- niet gevonden --------------------------------------------------------
  PAYMENT_NOT_FOUND: "notFound",
  EXPENSE_NOT_FOUND: "notFound",

  // --- autorisatie ----------------------------------------------------------
  REVERSAL_FORBIDDEN: "forbidden",
  REVERSAL_FORBIDDEN_CLOSED_FY: "forbiddenClosedFy",

  // --- boekjaar -------------------------------------------------------------
  REVERSAL_NO_OPEN_FISCAL_YEAR: "noOpenFiscalYear",

  // --- niet gejournaliseerd -------------------------------------------------
  PAYMENT_NOT_JOURNALED: "paymentNotJournaled",
  EXPENSE_NOT_JOURNALED: "expenseNotJournaled",

  // --- invoer ---------------------------------------------------------------
  REVERSAL_REASON_REQUIRED: "reasonRequired",
  CORRECTION_AMOUNT_INVALID: "amountInvalid",
  CORRECTION_VALUE_DATE_REQUIRED: "valueDateRequired",
  CORRECTION_METHOD_REQUIRED: "methodRequired",
  CORRECTION_EXPENSE_DATE_REQUIRED: "expenseDateRequired",

  // --- integriteit ----------------------------------------------------------
  // Allemaal "de database heeft de bewerking geweigerd omdat de administratie
  // anders niet meer zou kloppen". Voor de gebruiker is dat één uitkomst; het
  // onderscheid is voor de logs.
  REVERSAL_ALLOCATION_MISMATCH: "integrity",
  REVERSAL_ORIGINAL_ENTRY_MISSING: "integrity",
  REVERSAL_ORIGINAL_ENTRY_INCOMPLETE: "integrity",
  REVERSAL_ENTRY_IMMUTABLE: "integrity",
  PAYMENT_AMBIGUOUS_JOURNAL: "integrity",
  EXPENSE_AMBIGUOUS_JOURNAL: "integrity",
  SETTLEMENT_NOT_DERIVED: "integrity",
  ALLOCATION_EXCEEDS_PAYMENT: "integrity",
  ALLOCATION_UNKNOWN_PAYMENT: "integrity",
  ALLOCATION_REVERSAL_PARTIAL: "integrity",
  ALLOCATION_REVERSAL_MISLINKED: "integrity",
  ALLOCATION_REVERSAL_UNKNOWN_ALLOCATION: "integrity",
  ALLOCATION_REVERSAL_IMMUTABLE: "integrity",
  FINANCIAL_REVERSAL_IMMUTABLE: "integrity",
  CORRECTION_SOURCE_MISSING: "integrity",

  // --- onveranderlijkheid van de bronrij ------------------------------------
  PAYMENT_IMMUTABLE: "immutable",
  EXPENSE_IMMUTABLE: "immutable",

  // --- guards uit m22/m23 die hier kunnen opduiken --------------------------
  PAYMENT_HAS_FINANCIAL_HISTORY: "hasHistory",
  EXPENSE_HAS_FINANCIAL_HISTORY: "hasHistory",
};

/** De sleutel onder `reversal.errors`, of `"unknown"`. */
export function reversalErrorKey(error: DbError): string {
  if (!error) return "unknown";

  const code = engineErrorCode(error);
  if (code && KEYS[code]) return KEYS[code];

  // Geen engine-prefix: val terug op de SQLSTATE.
  const sqlstate = error.code ?? "";
  if (sqlstate === "42501") return "forbidden";
  if (sqlstate === "23505") return "alreadyReversed";

  return "unknown";
}

/**
 * Wat er in het serverlog terechtkomt bij een onbekende fout.
 *
 * Bewust GEEN payload, geen bedragen, geen eigenaarsnamen en geen reden — dat
 * zijn financiële persoonsgegevens. Alleen de SQLSTATE en de engine-code, want
 * die zijn nodig om te zien of er een nieuwe foutklasse bijkomt.
 */
export function reversalErrorFingerprint(error: DbError): string {
  const sqlstate = error?.code ?? "?";
  const code = engineErrorCode(error) ?? "?";
  return `sqlstate=${sqlstate} engine=${code}`;
}

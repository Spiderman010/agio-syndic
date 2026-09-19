/**
 * Databasefouten van het VERWIJDEREN van een lot of een eigenaar.
 *
 * ── DE DATABASE BESLIST, NIET DIT BESTAND ──────────────────────────────────
 *
 * Twee BEFORE DELETE-triggers weigeren onafhankelijk van welke UI er ook praat:
 *
 *   trig_00_unit_delete_history  → ALLOC_UNIT_HAS_HISTORY   als het lot in
 *                                  `charge_allocations` voorkomt.
 *   trig_00_owner_delete_history → ALLOC_OWNER_HAS_HISTORY  bij vorderingen,
 *                                  ALLOC_OWNER_HAS_PAYMENTS bij betalingen.
 *
 * Alle drie komen als SQLSTATE 23514 met een melding van de vorm
 * `CODE: Nederlandse zin`. Die zin is databasetekst en gaat NOOIT naar de
 * client: dit bestand leest alleen de code aan het begin en geeft een eigen
 * vertaalsleutel terug. Dezelfde lijn als `ownershipErrorKey` en
 * `blockErrorKey`; onbekend blijft `generic`, want een fout die we niet kennen
 * is geen reden om Postgres-proza te tonen.
 *
 * ── WAT WÉL WEGVALT ────────────────────────────────────────────────────────
 *
 * Empirisch nagemeten op een wegwerpdatabase met exact deze constraints en
 * triggers, niet aangenomen:
 *
 *   • Een SCHONE eigenaar verdwijnt inclusief zijn `ownership`-rijen. Er staan
 *     twee FK's van `ownership` naar `owners`: `ownership_owner_id_fkey`
 *     (ON DELETE CASCADE) en `ownership_owner_org_fk` (NO ACTION). De cascade
 *     wint — de NO ACTION-controle draait ná de cascade en vindt dan niets meer
 *     om over te klagen. De delete slaagt dus; hij blijft niet hangen op de
 *     composite FK.
 *   • Een SCHOON lot verdwijnt eveneens inclusief zijn `ownership`-rijen.
 *
 * Eigendomskoppelingen zijn geen financiële historie; vorderingen en betalingen
 * zijn dat wel, en die maken verwijderen onmogelijk in plaats van riskant.
 */

type DbFout = { code?: string | null; message?: string | null } | null | undefined;

/** Codes die we kennen. Alleen deze mogen in een log verschijnen. */
const BEKENDE_CODES = [
  "ALLOC_UNIT_HAS_HISTORY",
  "ALLOC_OWNER_HAS_HISTORY",
  "ALLOC_OWNER_HAS_PAYMENTS",
] as const;

const PER_CODE: Record<string, string> = {
  ALLOC_UNIT_HAS_HISTORY: "lotHasHistory",
  ALLOC_OWNER_HAS_HISTORY: "ownerHasHistory",
  ALLOC_OWNER_HAS_PAYMENTS: "ownerHasPayments",
};

/**
 * De code aan het BEGIN van de melding, maar alleen als we hem kennen.
 *
 * Bewust geankerd op het begin, net als `ownershipErrorKey`: een code die
 * ergens midden in een melding opduikt is geen gestructureerde fout maar tekst,
 * en tekst vertrouwen we hier niet.
 */
export function bekendeDeleteCode(error: DbFout): string | null {
  const code = /^([A-Z][A-Z0-9_]{4,})\b/.exec((error?.message ?? "").trim())?.[1];
  if (!code) return null;
  return (BEKENDE_CODES as readonly string[]).includes(code) ? code : null;
}

/**
 * Vertaalsleutel voor een mislukte verwijdering, of `"generic"`.
 *
 * `23503` (foreign key violation) krijgt bewust GEEN eigen sleutel: als er ooit
 * een verwijzing bijkomt zonder cascade en zonder guard, dan is een vage
 * "kon niet worden verwijderd" eerlijker dan een zin die een reden verzint die
 * we niet hebben nagemeten.
 */
export function deleteErrorKey(error: DbFout): string {
  const code = bekendeDeleteCode(error);
  return code ? PER_CODE[code] : "generic";
}

/** True als de database het onmogelijk maakt — niet "het ging even mis". */
export function isBlokkerendeHistorie(error: DbFout): boolean {
  return bekendeDeleteCode(error) !== null;
}

/**
 * Wat er in het SERVERLOG mag: SQLSTATE en een code die we zelf al kenden.
 * Nooit de melding — die bevat een Nederlandse zin uit de database, en bij een
 * andere fout mogelijk een lotlabel of een eigenaarsnaam.
 */
export function deleteErrorFingerprint(error: DbFout): string {
  return `sqlstate=${error?.code ?? "?"} code=${bekendeDeleteCode(error) ?? "?"}`;
}

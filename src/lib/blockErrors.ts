/**
 * Databasefouten van blok- en lotmutaties, vertaald naar een sleutel.
 *
 * ── WAAROM DIT NIET DE DATABASETEKST DOORGEEFT ─────────────────────────────
 *
 * PostgREST geeft bij een schending de volledige Postgres-melding terug, en
 * die bevat de constraintnaam, vaak de tabelnaam en soms de botsende WAARDE.
 * Dat is interne structuur en in het laatste geval klantgegevens. De gebruiker
 * krijgt daarom nooit die tekst, alleen een sleutel uit deze tabel.
 *
 * Dezelfde lijn als `ownershipErrorKey`: matchen op wat de database zegt, maar
 * uitsluitend een eigen sleutel teruggeven. Onbekend blijft `generic` — een
 * fout die we niet kennen is geen reden om Postgres-proza te tonen.
 *
 * ── DE CONSTRAINTS DIE ERTOE DOEN ──────────────────────────────────────────
 *
 *   blocks_building_code_ci_idx   uniek per gebouw op lower(btrim(code)).
 *                                 "A" naast "a" kan dus niet.
 *   blocks_code_not_blank         CHECK btrim(code) <> ''
 *   units_block_building_fk       units(block_id, building_id) ->
 *                                 blocks(id, building_id): een lot kan alleen
 *                                 naar een blok van HETZELFDE gebouw wijzen.
 */

type DbFout = { code?: string | null; message?: string | null } | null | undefined;

/** Constraintnamen die we herkennen. Alleen deze mogen in een log verschijnen. */
const BEKENDE_CONSTRAINTS = [
  "blocks_building_code_ci_idx",
  "blocks_code_not_blank",
  "units_block_building_fk",
  "blocks_building_org_fk",
] as const;

const PER_CONSTRAINT: Record<string, string> = {
  blocks_building_code_ci_idx: "duplicateCode",
  blocks_code_not_blank: "blankCode",
  units_block_building_fk: "blockNotInBuilding",
  blocks_building_org_fk: "forbidden",
};

/**
 * SQLSTATE als terugval wanneer de constraintnaam ontbreekt. Grover, maar nog
 * altijd beter dan `generic`: 23505 op dit scherm kán alleen de blokcode zijn.
 */
const PER_SQLSTATE: Record<string, string> = {
  "23505": "duplicateCode",
  "23514": "blankCode",
  "23503": "blockNotInBuilding",
};

/** De constraintnaam uit de melding, maar alleen als we hem kennen. */
export function bekendeConstraint(error: DbFout): string | null {
  const tekst = error?.message ?? "";
  return BEKENDE_CONSTRAINTS.find((naam) => tekst.includes(naam)) ?? null;
}

/**
 * Vertaalsleutel binnen `indeling.errors`, of `"generic"`.
 *
 * De constraintnaam wint van de SQLSTATE: hij is specifieker, en bij een
 * toekomstige tweede unique index op deze tabellen zou SQLSTATE alleen de
 * verkeerde melding opleveren.
 */
export function blockErrorKey(error: DbFout): string {
  if (!error) return "generic";
  const constraint = bekendeConstraint(error);
  if (constraint) return PER_CONSTRAINT[constraint] ?? "generic";
  const sqlstate = error.code ?? "";
  return PER_SQLSTATE[sqlstate] ?? "generic";
}

/**
 * Wat er in het SERVERLOG mag. Alleen SQLSTATE en een constraintnaam die we
 * zelf al kenden — nooit de melding, want daar kan een botsende waarde in
 * staan, en dat is een gebouw- of lotnaam van een klant.
 */
export function blockErrorFingerprint(error: DbFout): string {
  const sqlstate = error?.code ?? "?";
  return `sqlstate=${sqlstate} constraint=${bekendeConstraint(error) ?? "?"}`;
}

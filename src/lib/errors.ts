/**
 * Vertaalt PostgreSQL-/PostgREST-fouten naar leesbare meldingen.
 *
 * Rauwe databasetekst hoort nooit in de UI terecht te komen. Uitzondering:
 * onze eigen trigger-excepties (23514) dragen al een bewust geformuleerde
 * Nederlandse boodschap; die wordt doorgegeven.
 */

export type DbError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
} | null;

/** Herkenningspunten voor unieke constraints met een eigen boodschap. */
const UNIQUE_MESSAGES: Record<string, string> = {
  fiscal_years_building_id_year_key: "__duplicate_year__",
  accounts_org_code_key: "Deze grootboekrekening bestaat al.",
};

export function toUserError(error: DbError, fallback: string): string {
  if (!error) return fallback;

  const code = error.code ?? "";
  const message = error.message ?? "";

  // Row Level Security geweigerd -> onvoldoende rechten voor deze rol.
  if (code === "42501" || message.includes("row-level security")) {
    return "Je hebt niet de juiste rechten voor deze actie.";
  }

  // Unieke constraint.
  if (code === "23505") {
    for (const [needle, text] of Object.entries(UNIQUE_MESSAGES)) {
      if (message.includes(needle)) return text;
    }
    return "Dit record bestaat al.";
  }

  // Foreign key: verwijzing naar iets dat niet (meer) bestaat of niet mag.
  if (code === "23503") {
    if (message.includes("_org_fk")) {
      return "De gekozen gegevens horen niet bij deze organisatie.";
    }
    return "Verwijzing naar een record dat niet bestaat.";
  }

  // NOT NULL.
  if (code === "23502") {
    return "Er ontbreekt een verplicht veld.";
  }

  // CHECK-constraint of onze eigen RAISE EXCEPTION: boodschap is al Nederlands.
  if (code === "23514") {
    return message || fallback;
  }

  return fallback;
}

/** True wanneer de fout een dubbel boekjaar voor hetzelfde gebouw betreft. */
export function isDuplicateYear(error: DbError): boolean {
  return (
    error?.code === "23505" &&
    (error.message ?? "").includes("fiscal_years_building_id_year_key")
  );
}

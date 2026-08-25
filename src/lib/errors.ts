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

/**
 * Unieke constraints met een eigen boodschap.
 *
 * fiscal_years_building_id_year_key staat hier bewust NIET in: die wordt door
 * de aanroeper met isDuplicateYear() afgevangen om het jaartal in de vertaalde
 * melding te kunnen invullen.
 */
const UNIQUE_MESSAGES: Record<string, string> = {
  accounts_org_code_key: "Deze grootboekrekening bestaat al.",
  memberships_organization_id_user_id_key:
    "Deze gebruiker is al lid van de organisatie.",
  fiscal_years_building_id_year_key:
    "Er bestaat al een boekjaar voor dit jaar en gebouw.",
};

export function toUserError(error: DbError, fallback: string): string {
  if (!error) return fallback;

  const code = error.code ?? "";
  const message = error.message ?? "";

  // 42501 komt uit twee bronnen:
  //  - RLS weigert de rij; die melding van Postgres is technisch van aard;
  //  - onze eigen guard-triggers (bv. heropenen van een boekjaar), die al een
  //    bewust geformuleerde Nederlandse boodschap dragen.
  if (code === "42501" || message.includes("row-level security")) {
    if (!message || message.includes("row-level security") ||
        message.includes("permission denied")) {
      return "Je hebt niet de juiste rechten voor deze actie.";
    }
    return message;
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

  // 23514 dekt twee dingen:
  //  - onze eigen RAISE EXCEPTION uit de guard-triggers; die dragen al een
  //    bewust geformuleerde Nederlandse boodschap en gaan door;
  //  - een kale CHECK-constraint van Postgres, met een constraintnaam erin.
  //    Die tekst hoort niet in de UI.
  if (code === "23514") {
    if (!message || /violates check constraint|check constraint "/i.test(message)) {
      return fallback;
    }
    return message;
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

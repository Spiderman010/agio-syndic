import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tenant-guards.
 *
 * Elke UUID die uit een formulier komt wordt hier expliciet tegen de ACTIEVE
 * organisatie gecontroleerd voordat er iets wordt weggeschreven. Dit is de
 * applicatielaag; de database dwingt dezelfde invarianten nogmaals af via RLS
 * en samengestelde foreign keys. Beide lagen zijn verplicht: de anon-key is
 * rechtstreeks bruikbaar, dus de applicatiecheck alleen is nooit voldoende.
 */

type Client = SupabaseClient;

/** Tabellen met een eigen organization_id-kolom. */
type OrgScopedTable =
  | "buildings"
  | "owners"
  | "fiscal_years"
  | "charge_calls"
  | "expense_categories"
  | "accounts"
  | "payments"
  | "expenses";

/**
 * Controleert dat `id` bestaat én toebehoort aan `orgId`.
 * Retourneert null bij succes, anders een leesbare foutmelding.
 */
export async function assertInOrg(
  supabase: Client,
  table: OrgScopedTable,
  id: string,
  orgId: string,
  label: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from(table)
    .select("organization_id")
    .eq("id", id)
    .maybeSingle();

  if (error) return `${label} kon niet worden gecontroleerd.`;
  if (!data || data.organization_id !== orgId) {
    return `${label} bestaat niet binnen deze organisatie.`;
  }
  return null;
}

/** Idem, maar overslaan wanneer de waarde null is (optionele relatie). */
export async function assertInOrgOptional(
  supabase: Client,
  table: OrgScopedTable,
  id: string | null,
  orgId: string,
  label: string,
): Promise<string | null> {
  if (id === null) return null;
  return assertInOrg(supabase, table, id, orgId, label);
}

/**
 * Units hebben geen eigen organization_id; de keten loopt via het gebouw.
 *
 * `buildingId` is optioneel voor achterwaartse compatibiliteit, maar elke
 * caller die ook over een `building_id` uit het formulier beschikt hoort die
 * hier mee te geven. Zonder die check bewijst deze functie alleen dat de unit
 * ÉRGENS in de organisatie staat, niet dat hij bij het gebouw uit de URL
 * hoort — een gemanipuleerd formulier kan dan `building_id` van gebouw A met
 * `unit_id` van gebouw B combineren en zo gebouw B muteren terwijl de actie
 * gebouw A revalideert en daarheen redirect. Bij een mismatch geeft deze
 * functie dezelfde generieke melding terug als bij een unit uit een andere
 * organisatie, zodat er niets wordt prijsgegeven over het bestaan van de unit.
 */
export async function assertUnitInOrg(
  supabase: Client,
  unitId: string,
  orgId: string,
  buildingId?: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("units")
    .select("id, building_id, buildings!inner(organization_id)")
    .eq("id", unitId)
    .maybeSingle();

  if (error) return "Unit kon niet worden gecontroleerd.";
  if (!data) return "Unit bestaat niet binnen deze organisatie.";

  const raw = (data as { buildings: { organization_id: string } | { organization_id: string }[] })
    .buildings;
  const building = Array.isArray(raw) ? raw[0] : raw;

  if (!building || building.organization_id !== orgId) {
    return "Unit bestaat niet binnen deze organisatie.";
  }
  if (buildingId && data.building_id !== buildingId) {
    return "Unit bestaat niet binnen deze organisatie.";
  }
  return null;
}

/**
 * Controleert dat een boekjaar bij de organisatie én bij het gebouw hoort,
 * en dat het nog open is. Retourneert de foutmelding of null.
 */
export async function assertFiscalYearWritable(
  supabase: Client,
  fiscalYearId: string,
  orgId: string,
  buildingId?: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("fiscal_years")
    .select("organization_id, building_id, status")
    .eq("id", fiscalYearId)
    .maybeSingle();

  if (error) return "Boekjaar kon niet worden gecontroleerd.";
  if (!data || data.organization_id !== orgId) {
    return "Boekjaar bestaat niet binnen deze organisatie.";
  }
  if (buildingId && data.building_id !== buildingId) {
    return "Boekjaar hoort niet bij dit gebouw.";
  }
  if (data.status === "closed") {
    return "Dit boekjaar is afgesloten en kan niet meer worden gewijzigd.";
  }
  return null;
}

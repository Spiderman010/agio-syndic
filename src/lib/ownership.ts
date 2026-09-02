/**
 * Domeinkern van eigenaren, lots en eigendom.
 *
 * Geen React, geen databasetoegang: pure functies over rijen die de pagina al
 * heeft opgehaald. Dat is bewust. De vraag "wie is op deze datum de eigenaar"
 * bepaalt aan wie een lastenoproep wordt toegerekend, en die semantiek hoort op
 * exact één plek te staan waar hij zonder database te testen is.
 *
 * ── DATUMSEMANTIEK ─────────────────────────────────────────────────────────
 *
 * Beide grenzen zijn INCLUSIEF. Niet gekozen maar overgenomen uit de
 * verdeelmotor `fn_alloc_resolve_owner`:
 *
 *     start_date <= d AND (end_date IS NULL OR end_date >= d)
 *
 * `end_date` is dus de LAATSTE eigendomsdag. Wijkt deze module daarvan af, dan
 * toont het scherm een andere eigenaar dan degene die de vordering krijgt — de
 * duurste soort inconsistentie in dit product.
 *
 * Datums zijn ISO-strings (`YYYY-MM-DD`). Die zijn lexicografisch
 * vergelijkbaar, dus er komt geen `Date` aan te pas: een `Date` introduceert een
 * tijdzone en daarmee een verschuiving van een dag rond middernacht.
 *
 * ── ACTUEEL versus ACTIEF ──────────────────────────────────────────────────
 *
 * "Actueel" is `end_date === null`; "actief op datum d" is de formule hierboven.
 * Sinds m30 vallen die samen, omdat de database geen enkele eigendomsrij met een
 * datum in de toekomst meer toelaat. Beide begrippen staan hier los, zodat de
 * tests kunnen vastleggen dát ze samenvallen in plaats van het aan te nemen.
 */

export type OwnershipRow = {
  id: string;
  unit_id: string;
  owner_id: string;
  share: number | string;
  start_date: string;
  /** `null` = lopende periode. */
  end_date: string | null;
  is_primary_debtor: boolean;
};

export type UnitRow = {
  id: string;
  building_id: string;
  label: string;
  unit_type: string;
  tantiemes: number;
  floor: string | null;
  area_m2: number | string | null;
};

export type OwnerRow = {
  id: string;
  full_name: string;
  is_company: boolean;
  email: string | null;
  phone: string | null;
  language: string;
  is_mre: boolean;
};

function num(value: number | string | null): number {
  if (value === null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ── Periodes ────────────────────────────────────────────────────────────────

/** Exact de formule uit `fn_alloc_resolve_owner`; beide grenzen inclusief. */
export function isActiveOn(row: OwnershipRow, date: string): boolean {
  return row.start_date <= date && (row.end_date === null || row.end_date >= date);
}

/** Een lopende periode: nog niet afgesloten. */
export function isCurrent(row: OwnershipRow): boolean {
  return row.end_date === null;
}

/**
 * Overlappen twee perioden elkaar? Inclusieve grenzen, dus een periode die op
 * dag D eindigt en een die op dag D begint OVERLAPPEN — precies één dag. Dat is
 * de fout die een overdracht op D-1/D voorkomt.
 */
export function periodsOverlap(a: OwnershipRow, b: OwnershipRow): boolean {
  const aEnd = a.end_date;
  const bEnd = b.end_date;
  if (aEnd !== null && aEnd < b.start_date) return false;
  if (bEnd !== null && bEnd < a.start_date) return false;
  return true;
}

/**
 * De actuele eigendomsrij van één lot, of null.
 *
 * `null` betekent hier "geen actuele eigenaar", NIET "onbekend". Een mislukte
 * query hoort de rijen nooit tot hier te laten komen; zie `assembleOwnership`.
 * Zijn er meerdere actuele rijen (mede-eigendom), dan wint de aangewezen
 * debiteur — dezelfde volgorde als de verdeelmotor, inclusief de totale
 * tie-break op id, zodat het scherm nooit een andere eigenaar toont dan degene
 * die de vordering krijgt.
 */
export function currentOwnership(rows: readonly OwnershipRow[]): OwnershipRow | null {
  const lopend = rows.filter(isCurrent);
  if (lopend.length === 0) return null;
  const gesorteerd = [...lopend].sort(
    (a, b) =>
      Number(b.is_primary_debtor) - Number(a.is_primary_debtor) ||
      num(b.share) - num(a.share) ||
      (a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0) ||
      a.id.localeCompare(b.id),
  );
  return gesorteerd[0];
}

/** Alle actuele rijen van een lot; meer dan één betekent mede-eigendom. */
export function currentOwnerships(rows: readonly OwnershipRow[]): OwnershipRow[] {
  return rows.filter(isCurrent);
}

/**
 * Historie, nieuwste eerst. Lopende perioden staan bovenaan omdat ze nog geen
 * einde hebben; daarna aflopend op startdatum, met een totale tie-break zodat
 * de volgorde deterministisch is.
 */
export function sortHistory(rows: readonly OwnershipRow[]): OwnershipRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(isCurrent(b)) - Number(isCurrent(a)) ||
      (a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0) ||
      a.id.localeCompare(b.id),
  );
}

// ── Groeperen ───────────────────────────────────────────────────────────────

export type OwnerScope = {
  /** Aantal lots dat deze eigenaar NU bezit. */
  lotCount: number;
  /** Gebouw-id's waarin die lots liggen, ontdubbeld en gesorteerd op naam. */
  buildingIds: string[];
};

/**
 * Actuele lots en gebouwen per eigenaar.
 *
 * Een eigenaar is ORGANISATIEBREED en kan lots in meerdere gebouwen hebben. Hij
 * verschijnt daarom precies ÉÉN keer met een lijst gebouwen, niet één keer per
 * gebouw. De ontdubbeling gebeurt hier en niet in de query, omdat PostgREST
 * geen `DISTINCT ON` kent en een tweede query alleen maar een tweede waarheid
 * zou opleveren.
 */
export function ownerScopes(
  ownership: readonly OwnershipRow[],
  unitBuilding: ReadonlyMap<string, string>,
  buildingOrder: ReadonlyMap<string, string>,
): Map<string, OwnerScope> {
  const perOwner = new Map<string, { lots: Set<string>; buildings: Set<string> }>();

  for (const rij of ownership) {
    if (!isCurrent(rij)) continue;
    const buildingId = unitBuilding.get(rij.unit_id);
    // Een lot dat niet in de opgehaalde scope zit telt niet mee; anders zou een
    // eigenaar lots krijgen toegerekend uit een gebouw dat we niet lieten zien.
    if (!buildingId) continue;
    let entry = perOwner.get(rij.owner_id);
    if (!entry) {
      entry = { lots: new Set(), buildings: new Set() };
      perOwner.set(rij.owner_id, entry);
    }
    entry.lots.add(rij.unit_id);
    entry.buildings.add(buildingId);
  }

  const uit = new Map<string, OwnerScope>();
  for (const [ownerId, entry] of perOwner) {
    const buildingIds = [...entry.buildings].sort((a, b) =>
      (buildingOrder.get(a) ?? "").localeCompare(buildingOrder.get(b) ?? ""),
    );
    uit.set(ownerId, { lotCount: entry.lots.size, buildingIds });
  }
  return uit;
}

// ── Zoeken ──────────────────────────────────────────────────────────────────

/**
 * Zoekt op naam, e-mail en telefoon.
 *
 * Diakrietongevoelig via `normalize("NFD")`, zodat "Belkacem" ook op "Belkacém"
 * matcht; in een Marokkaanse ledenadministratie staan Franse accenten er soms
 * wel en soms niet in. Bij een telefoonnummer worden spaties, streepjes en
 * haakjes genegeerd: gebruikers typen "0612 34" voor "06-1234...".
 */
function normaliseer(waarde: string): string {
  return waarde
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function alleenCijfers(waarde: string): string {
  return waarde.replace(/[^0-9+]/g, "");
}

export function matchesSearch(owner: OwnerRow, term: string): boolean {
  const zoek = normaliseer(term);
  if (zoek === "") return true;

  if (normaliseer(owner.full_name).includes(zoek)) return true;
  if (owner.email && normaliseer(owner.email).includes(zoek)) return true;
  if (owner.phone) {
    if (normaliseer(owner.phone).includes(zoek)) return true;
    const cijfers = alleenCijfers(term);
    if (cijfers.length > 0 && alleenCijfers(owner.phone).includes(cijfers)) return true;
  }
  return false;
}

/** Zoekt binnen lots op label, verdieping en type. */
export function matchesUnitSearch(unit: UnitRow, term: string): boolean {
  const zoek = normaliseer(term);
  if (zoek === "") return true;
  return (
    normaliseer(unit.label).includes(zoek) ||
    normaliseer(unit.unit_type).includes(zoek) ||
    (unit.floor !== null && normaliseer(unit.floor).includes(zoek))
  );
}

// ── Volledigheid ────────────────────────────────────────────────────────────

export type LotStatus =
  /** Precies één actuele eigenaar en een tantième groter dan nul. */
  | "compleet"
  /** Geen actuele eigenaar: een lastenoproep zou hier hard falen. */
  | "zonderEigenaar"
  /** Meerdere actuele eigenaars; de aangewezen debiteur bepaalt de toerekening. */
  | "medeEigendom"
  /** Tantième nul: dit lot deelt niet mee in de verdeling. */
  | "zonderTantieme";

/**
 * De volledigheidsstatus van één lot.
 *
 * De volgorde is niet willekeurig: "geen eigenaar" is ernstiger dan "geen
 * tantième", want zonder eigenaar faalt `create_charge_call` volledig
 * (`ALLOC_NO_OWNER`), terwijl een tantième van nul alleen betekent dat het lot
 * niet meedeelt.
 */
export function lotStatus(unit: UnitRow, ownership: readonly OwnershipRow[]): LotStatus {
  const lopend = currentOwnerships(ownership);
  if (lopend.length === 0) return "zonderEigenaar";
  if (lopend.length > 1) return "medeEigendom";
  if (unit.tantiemes <= 0) return "zonderTantieme";
  return "compleet";
}

export type TantiemeOverzicht = {
  /** Som van de tantièmes van alle lots in het gebouw. */
  toegekend: number;
  /** De declaratieve controlewaarde uit `buildings.total_tantiemes`. */
  verklaard: number;
  /** Verschil; negatief betekent dat er minder is toegekend dan verklaard. */
  verschil: number;
  /** Aantal lots zonder actuele eigenaar. */
  zonderEigenaar: number;
  /** Aantal lots met meerdere actuele eigenaars. */
  medeEigendom: number;
  /** Aantal lots met tantième nul. */
  zonderTantieme: number;
  /**
   * Kan er veilig een lastenoproep worden gedaan? Alleen wanneer élk lot een
   * eenduidige debiteur heeft én de toegekende tantièmes het verklaarde totaal
   * halen. Dit is een WAARSCHUWING, geen blokkade: de database beslist.
   */
  oproepVeilig: boolean;
};

export function tantiemeOverzicht(
  units: readonly UnitRow[],
  ownershipPerUnit: ReadonlyMap<string, OwnershipRow[]>,
  verklaard: number,
): TantiemeOverzicht {
  let toegekend = 0;
  let zonderEigenaar = 0;
  let medeEigendom = 0;
  let zonderTantieme = 0;

  for (const unit of units) {
    toegekend += unit.tantiemes;
    const status = lotStatus(unit, ownershipPerUnit.get(unit.id) ?? []);
    if (status === "zonderEigenaar") zonderEigenaar += 1;
    else if (status === "medeEigendom") medeEigendom += 1;
    else if (status === "zonderTantieme") zonderTantieme += 1;
  }

  return {
    toegekend,
    verklaard,
    verschil: toegekend - verklaard,
    zonderEigenaar,
    medeEigendom,
    zonderTantieme,
    oproepVeilig:
      units.length > 0 && zonderEigenaar === 0 && medeEigendom === 0 && toegekend === verklaard,
  };
}

/** Groepeert eigendomsrijen per lot. */
export function groupByUnit(rows: readonly OwnershipRow[]): Map<string, OwnershipRow[]> {
  const perUnit = new Map<string, OwnershipRow[]>();
  for (const rij of rows) {
    const lijst = perUnit.get(rij.unit_id);
    if (lijst) lijst.push(rij);
    else perUnit.set(rij.unit_id, [rij]);
  }
  return perUnit;
}

// ── Fail-closed samenstelling ───────────────────────────────────────────────

/**
 * `null` betekent: deze query is MISLUKT.
 *
 * Het onderscheid tussen "leeg" en "mislukt" is het hele punt. Een mislukte
 * eigendomsquery mag NOOIT als "dit lot heeft geen eigenaar" op het scherm
 * komen: dat is precies het signaal waarop een syndic zou handelen door een
 * eigenaar te koppelen die er al is.
 */
export type OwnershipSources<U, O> = {
  units: readonly U[] | null;
  ownership: readonly OwnershipRow[] | null;
  owners: readonly O[] | null;
};

export type OwnershipResult<U, O> =
  | { status: "error"; failed: string[] }
  | {
      status: "ok";
      units: readonly U[];
      ownership: readonly OwnershipRow[];
      owners: readonly O[];
    };

/**
 * Zet de opgehaalde bronnen om, of weigert dat.
 *
 * Ondeelbaar: faalt één bron, dan wordt er niets getoond. De succesvariant geeft
 * de rijen terug, zodat de pagina niet per ongeluk een eigen, afwijkende
 * nullcontrole gaat voeren — zij krijgt haar rijen hiervandaan.
 */
export function assembleOwnership<U, O>(
  sources: OwnershipSources<U, O>,
): OwnershipResult<U, O> {
  const failed: string[] = [];
  if (sources.units === null) failed.push("units");
  if (sources.ownership === null) failed.push("ownership");
  if (sources.owners === null) failed.push("owners");

  if (
    failed.length > 0 ||
    sources.units === null ||
    sources.ownership === null ||
    sources.owners === null
  ) {
    return { status: "error", failed };
  }
  return {
    status: "ok",
    units: sources.units,
    ownership: sources.ownership,
    owners: sources.owners,
  };
}

// ── Foutcodes uit de database ───────────────────────────────────────────────

/**
 * De vaste foutcodes van `link_first_owner` en `transfer_ownership`.
 *
 * De RPC's werpen een kale code zonder dubbele punt (`OWNERSHIP_STALE`), anders
 * dan de allocation engine die `CODE: tekst` gebruikt. `engineErrorCode()` uit
 * `@/lib/errors` matcht daarom niet; deze functie wel. De codes dragen bewust
 * geen namen, UUID's of rijwaarden, zodat er niets uit de database naar de
 * client lekt wat er niet hoort.
 */
const OWNERSHIP_ERROR_KEYS: Record<string, string> = {
  OWNERSHIP_UNAUTHENTICATED: "forbidden",
  OWNERSHIP_FORBIDDEN: "forbidden",
  OWNERSHIP_OWNER_INVALID: "ownerInvalid",
  OWNERSHIP_DATE_INVALID: "dateInvalid",
  OWNERSHIP_DATE_FUTURE: "dateFuture",
  OWNERSHIP_HISTORY_EXISTS: "historyExists",
  OWNERSHIP_NO_CURRENT: "noCurrent",
  OWNERSHIP_COOWNED: "coowned",
  OWNERSHIP_STALE: "stale",
  OWNERSHIP_NOT_PRIMARY: "notPrimary",
  OWNERSHIP_NOT_FULL: "notFull",
  OWNERSHIP_SAME_OWNER: "sameOwner",
  OWNERSHIP_DATE_NOT_AFTER_START: "dateNotAfterStart",
  OWNERSHIP_OVERLAP: "overlap",
  OWNERSHIP_DELETE_FORBIDDEN: "deleteForbidden",
};

/**
 * Vertaalsleutel binnen `owners.errors` voor een databasefout, of `"generic"`.
 *
 * Valt bewust terug op `generic` in plaats van de databasetekst door te geven:
 * een onbekende fout is geen reden om Postgres-proza aan een gebruiker te tonen.
 */
export function ownershipErrorKey(message: string | null | undefined): string {
  if (!message) return "generic";
  const code = /^([A-Z][A-Z0-9_]{4,})\b/.exec(message.trim())?.[1];
  if (!code) return "generic";
  return OWNERSHIP_ERROR_KEYS[code] ?? "generic";
}

/** True wanneer de gebruiker de pagina moet verversen voordat hij het opnieuw probeert. */
export function requiresRefresh(message: string | null | undefined): boolean {
  return ownershipErrorKey(message) === "stale";
}

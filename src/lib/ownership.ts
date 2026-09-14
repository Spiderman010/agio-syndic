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

/**
 * Alle actuele rijen van een lot.
 *
 * Puur een filter, zonder oordeel. Meer dan één rij betekent NIET automatisch
 * een probleem: of gedeelde eigendom toerekenbaar is hangt af van het aantal
 * aangewezen debiteuren, en dat oordeel hoort thuis in `classifyOwnership`.
 */
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

// ── Eigendomsclassificatie ──────────────────────────────────────────────────

/**
 * De vier eigendomstoestanden die de allocation engine onderscheidt.
 *
 * Dit is GEEN eigen indeling maar een letterlijke vertaling van twee condities
 * in `create_charge_call` (m20, regels 267 en 276):
 *
 *     WHERE ... o.owner_id IS NULL              -> ALLOC_NO_OWNER
 *     WHERE ... o.n_active > 1 AND o.n_primary <> 1  -> ALLOC_AMBIGUOUS_OWNER
 *
 * waarbij `n_active` en `n_primary` uit `fn_alloc_resolve_owner` komen: het
 * aantal eigendomsrijen dat op de oproepdatum actief is, en hoeveel daarvan
 * `is_primary_debtor` dragen.
 *
 * Twee gevolgen die makkelijk over het hoofd worden gezien, en die deze module
 * daarom expliciet vastlegt in plaats van te interpreteren:
 *
 *  1. MEDE-EIGENDOM IS GEEN FOUT. Meerdere actieve eigenaars met exact één
 *     aangewezen debiteur is een ONDERSTEUNDE toestand: de ambiguïteitscontrole
 *     eist `n_primary <> 1`, dus precies één primaire debiteur laat de oproep
 *     gewoon slagen. De volledige lot-allocatie gaat naar die ene debiteur; zie
 *     docs/known-issues.md paragraaf 0.
 *  2. ÉÉN ACTIEVE, NIET-PRIMAIRE EIGENAAR IS TOEGESTAAN. De ambiguïteitscontrole
 *     begint bij `n_active > 1`, dus bij één actieve rij wordt `n_primary` niet
 *     eens gewogen. `fn_alloc_resolve_owner` retourneert die ene rij en de
 *     oproep slaagt. Dat is misschien onbedoeld, maar het IS het gedrag, en dit
 *     bestand mag er niet stilzwijgend van afwijken — anders waarschuwt het
 *     scherm voor iets wat de database toestaat.
 */
export type OwnershipClass =
  /** Nul actieve eigenaars: `ALLOC_NO_OWNER`. */
  | "geenEigenaar"
  /** Precies één actieve eigenaar, primair of niet: toegestaan. */
  | "enkel"
  /** Meerdere actieve eigenaars met exact één debiteur: toegestaan. */
  | "medeEigendom"
  /** Meerdere actieve eigenaars, nul of meer dan één debiteur: `ALLOC_AMBIGUOUS_OWNER`. */
  | "ambigu";

export type OwnershipClassification = {
  /** Aantal actuele eigendomsrijen; spiegelt `n_active`. */
  nActive: number;
  /** Aantal daarvan met `is_primary_debtor`; spiegelt `n_primary`. */
  nPrimary: number;
  klasse: OwnershipClass;
  /**
   * De rij die de vordering zou krijgen, of `null` bij nul actieve eigenaars.
   * Bij een ambigue toestand is dit de rij die `fn_alloc_resolve_owner` zou
   * kiezen — de engine weigert dan alsnog, dus dit is informatie, geen belofte.
   */
  debiteur: OwnershipRow | null;
  /**
   * Kan de engine deze toestand toerekenen? Exact het complement van de twee
   * SQL-condities hierboven — niets meer en niets minder.
   */
  toewijsbaar: boolean;
};

/**
 * Classificeert de HUIDIGE eigendomstoestand van één lot.
 *
 * "Huidig" betekent `end_date IS NULL`. De engine rekent op een oproepdatum;
 * sinds m30 kan geen enkele eigendomsrij vooruitlopen op vandaag, waardoor
 * "huidig" en "actief op vandaag" samenvallen. Voor een oproepdatum in het
 * VERLEDEN kan de uitkomst afwijken — dit is dus een uitspraak over nu, niet
 * over elke denkbare oproepdatum. De schermteksten formuleren dat ook zo.
 */
export function classifyOwnership(
  ownership: readonly OwnershipRow[],
): OwnershipClassification {
  const lopend = currentOwnerships(ownership);
  const nActive = lopend.length;
  const nPrimary = lopend.filter((r) => r.is_primary_debtor).length;

  let klasse: OwnershipClass;
  if (nActive === 0) klasse = "geenEigenaar";
  else if (nActive === 1) klasse = "enkel";
  else if (nPrimary === 1) klasse = "medeEigendom";
  else klasse = "ambigu";

  return {
    nActive,
    nPrimary,
    klasse,
    debiteur: currentOwnership(ownership),
    toewijsbaar: klasse === "enkel" || klasse === "medeEigendom",
  };
}

// ── Overdraagbaarheid ───────────────────────────────────────────────────────

/**
 * Telt hele dagen op bij een ISO-datum (`YYYY-MM-DD`).
 *
 * Via `Date.UTC` en de UTC-getters, nooit via de lokale tijdzone: `new Date(iso)`
 * gevolgd door `getDate()` verschuift rond middernacht een dag, en een
 * overdrachtsdatum die een dag opschuift is precies de fout die de D-1/D-grens
 * onbruikbaar maakt. Maand-, jaar- en schrikkeljaargrenzen worden door de
 * kalenderrekenkunde van `Date.UTC` correct afgehandeld.
 */
export function addDays(iso: string, days: number): string {
  const [jaar, maand, dag] = iso.split("-").map(Number);
  const punt = new Date(Date.UTC(jaar, maand - 1, dag + days));
  return [
    String(punt.getUTCFullYear()).padStart(4, "0"),
    String(punt.getUTCMonth() + 1).padStart(2, "0"),
    String(punt.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Waarom de eenvoudige overdrachtsflow niet beschikbaar is. */
export type TransferBlockReason =
  /** Nul actuele eigenaars; er is niets over te dragen. */
  | "geenEigenaar"
  /** Meerdere eigenaars met een aangewezen debiteur; geldig, maar read-only. */
  | "medeEigendom"
  /** Meerdere eigenaars zonder aangewezen debiteur. */
  | "ambigu"
  /** Eén eigenaar, maar niet de aangewezen debiteur. */
  | "nietPrimair"
  /** Eén eigenaar met een gedeeltelijk aandeel. */
  | "gedeeltelijkAandeel"
  /** De eigendom begon vandaag: er bestaat geen geldige overdrachtsdatum. */
  | "vandaagBegonnen";

export type Transferability =
  | {
      allowed: true;
      current: OwnershipRow;
      /** Vroegst toegestane datum: `start_date + 1`. */
      minDate: string;
      /** Laatst toegestane datum: vandaag. */
      maxDate: string;
      /** Een gegarandeerd geldige standaardwaarde binnen [minDate, maxDate]. */
      defaultDate: string;
    }
  | { allowed: false; reason: TransferBlockReason; current: OwnershipRow | null };

/**
 * Mag deze eigendom via de eenvoudige overdrachtsflow worden overgedragen?
 *
 * Spiegelt de VOORAF KENBARE precondities van `transfer_ownership`, in dezelfde
 * volgorde waarin de RPC ze afdwingt:
 *
 *     v_n = 0                          -> OWNERSHIP_NO_CURRENT
 *     v_n > 1                          -> OWNERSHIP_COOWNED
 *     NOT v_cur.is_primary_debtor      -> OWNERSHIP_NOT_PRIMARY
 *     v_cur.share <> 1                 -> OWNERSHIP_NOT_FULL
 *     p_transfer_date <= start_date    -> OWNERSHIP_DATE_NOT_AFTER_START
 *     p_transfer_date >  CURRENT_DATE  -> OWNERSHIP_DATE_FUTURE
 *
 * De laatste twee samen bepalen het datumvenster: [start_date + 1, vandaag].
 * Is dat venster LEEG — de eigendom begon vandaag — dan bestaat er vandaag geen
 * enkele geldige overdrachtsdatum en heeft een formulier tonen geen zin.
 *
 * Dit is een UI-poort, geen beveiliging: de RPC controleert alles nogmaals op
 * basis van `auth.uid()` en blijft de autoritatieve grens. Wat deze functie
 * voorkomt is een formulier waarvan we vooraf WETEN dat het wordt geweigerd.
 *
 * Wat hier NIET wordt beoordeeld: of een lastenoproep zou slagen. Een
 * niet-overdraagbaar lot is niet automatisch financieel onveilig — geldige
 * mede-eigendom is daar het duidelijkste voorbeeld van. Zie `classifyOwnership`.
 */
export function transferability(
  ownership: readonly OwnershipRow[],
  today: string,
): Transferability {
  const { klasse, debiteur } = classifyOwnership(ownership);

  if (klasse === "geenEigenaar") return { allowed: false, reason: "geenEigenaar", current: null };
  if (klasse === "ambigu") return { allowed: false, reason: "ambigu", current: debiteur };
  if (klasse === "medeEigendom") {
    return { allowed: false, reason: "medeEigendom", current: debiteur };
  }

  // Vanaf hier: precies één actuele rij.
  const current = debiteur as OwnershipRow;
  if (!current.is_primary_debtor) {
    return { allowed: false, reason: "nietPrimair", current };
  }
  if (num(current.share) !== 1) {
    return { allowed: false, reason: "gedeeltelijkAandeel", current };
  }

  const minDate = addDays(current.start_date, 1);
  const maxDate = today;
  if (minDate > maxDate) {
    return { allowed: false, reason: "vandaagBegonnen", current };
  }

  // `maxDate` ligt per definitie in het venster en is de gebruikelijke keuze:
  // een overdracht wordt meestal op de dag zelf vastgelegd.
  return { allowed: true, current, minDate, maxDate, defaultDate: maxDate };
}

// ── Volledigheid ────────────────────────────────────────────────────────────

export type LotStatus =
  /** Eén eigenaar en een tantième groter dan nul. */
  | "compleet"
  /** Geen actuele eigenaar: een lastenoproep faalt hier. */
  | "zonderEigenaar"
  /** Meerdere actuele eigenaars zonder eenduidige debiteur: de oproep faalt. */
  | "ambigu"
  /** Meerdere actuele eigenaars MET eenduidige debiteur: geldig, geen fout. */
  | "medeEigendom"
  /** Tantième nul: dit lot deelt niet mee in de verdeling. */
  | "zonderTantieme";

/**
 * De status van één lot voor het overzichtsscherm.
 *
 * De precedentie volgt de ERNST, niet de volgorde van de controles:
 *
 *   zonderEigenaar  de oproep faalt volledig (ALLOC_NO_OWNER)
 *   ambigu          de oproep faalt volledig (ALLOC_AMBIGUOUS_OWNER)
 *   zonderTantieme  het lot deelt niet mee; wél een aandachtspunt
 *   medeEigendom    geldig; puur informatief
 *   compleet        niets aan de hand
 *
 * `medeEigendom` staat bewust ONDER `zonderTantieme`: een geldige mede-eigendom
 * is geen probleem, een tantième van nul wel. Dat de eigendom gedeeld is blijft
 * zichtbaar in de eigenaarskolom, die alle actuele eigenaars toont en de
 * aangewezen debiteur markeert.
 */
export function lotStatus(unit: UnitRow, ownership: readonly OwnershipRow[]): LotStatus {
  const { klasse } = classifyOwnership(ownership);
  if (klasse === "geenEigenaar") return "zonderEigenaar";
  if (klasse === "ambigu") return "ambigu";
  if (unit.tantiemes <= 0) return "zonderTantieme";
  if (klasse === "medeEigendom") return "medeEigendom";
  return "compleet";
}

/**
 * De vier eigendomstoestanden van een lot, voor schermen die nog geen
 * volledige `OwnershipRow[]` ophalen — alleen `end_date` (en of de gekoppelde
 * eigenaar resolveert) is nodig om ACTUEEL van GESLOTEN te scheiden.
 *
 * Gebruikt door de legacy gebouwpagina om het `assignOwner`-formulier NOOIT
 * te tonen op een lot met uitsluitend gesloten historie: `link_first_owner`
 * weigert die aanroep terecht met OWNERSHIP_HISTORY_EXISTS, dus een
 * formulier tonen zou een knop zijn waarvan al bekend is dat hij faalt. De
 * nieuwe lots-pagina kent dezelfde vier toestanden via `classifyOwnership` +
 * `rijen.length`; deze functie is de lichtgewicht tegenhanger voor een
 * scherm dat alleen `end_date` en de eigenaarsnaam opvraagt.
 */
export type OwnerFormState =
  /** Nog nooit een eigendomsrij gehad: het koppelformulier mag verschijnen. */
  | "geen"
  /** Historie bestaat, maar geen enkele rij is nog actueel: geen formulier. */
  | "historieZonderEigenaar"
  /** Precies één actuele rij. */
  | "eenEigenaar"
  /** Meerdere actuele rijen. */
  | "ambigu";

export function ownerFormState(
  ownership: readonly { end_date: string | null; owners: unknown }[],
): OwnerFormState {
  const actief = ownership.filter((o) => o.end_date === null && o.owners != null);
  if (actief.length === 0) {
    return ownership.length > 0 ? "historieZonderEigenaar" : "geen";
  }
  return actief.length === 1 ? "eenEigenaar" : "ambigu";
}

export type TantiemeOverzicht = {
  /** Som van de tantièmes van alle lots in het gebouw. */
  toegekend: number;
  /** De declaratieve controlewaarde uit `buildings.total_tantiemes`. */
  verklaard: number;
  /** Verschil; negatief betekent dat er minder is toegekend dan verklaard. */
  verschil: number;
  /** Aantal lots zonder actuele eigenaar; blokkeert een oproep. */
  zonderEigenaar: number;
  /** Aantal lots met GELDIGE mede-eigendom; blokkeert een oproep NIET. */
  medeEigendom: number;
  /** Aantal lots met meerdere eigenaars zonder eenduidige debiteur; blokkeert. */
  ambigu: number;
  /**
   * Aantal lots met tantième nul. Wordt ONAFHANKELIJK van de eigendomsklasse
   * geteld: een lot kan tegelijk mede-eigendom hebben én geen tantième. De
   * vorige versie telde elk lot in precies één emmer via `lotStatus` en verloor
   * daardoor het tantièmeprobleem van een gedeeld lot.
   */
  zonderTantieme: number;
  /** Elk lot is toerekenbaar volgens de engine: geen lot zonder eigenaar, geen ambiguïteit. */
  eigendomVeilig: boolean;
  /** De toegekende tantièmes halen het verklaarde totaal precies. */
  tantiemesKloppen: boolean;
  /**
   * Zijn de basisgegevens van dit gebouw COMPLEET genoeg om een lastenoproep op
   * te baseren?
   *
   * Bewust "gereedheid" en niet "deze oproep zal slagen". De engine oordeelt
   * over de lots die in de SCOPE van de gekozen verdeelregel vallen, op de
   * opgegeven `call_date`, en dat weet dit scherm allebei niet. Wat het wel kan
   * beoordelen is of er iets ontbreekt dat een oproep zou blokkeren zodra het
   * betrokken lot meedoet.
   *
   * Drie voorwaarden, elk een directe tegenhanger van een harde fout uit
   * `create_charge_call` (m20):
   *
   *   eigendomVeilig     geen lot zonder eigenaar (ALLOC_NO_OWNER) en geen lot
   *                      met meerdere eigenaars zonder eenduidige debiteur
   *                      (ALLOC_AMBIGUOUS_OWNER, alleen bij n_primary <> 1);
   *   zonderTantieme = 0 geen deelnemend lot met tantième nul
   *                      (ALLOC_WEIGHT_MISSING, m20 regel 164-170);
   *   tantiemesKloppen   de som haalt de controlewaarde uit het règlement
   *                      (ALLOC_CONTROL_TOTAL, m20 regel 243-257).
   *
   * GELDIGE MEDE-EIGENDOM TELT HIER NIET MEE: die is ondersteund, en de
   * aangewezen debiteur krijgt de volledige allocatie.
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
  let ambigu = 0;
  let zonderTantieme = 0;

  for (const unit of units) {
    toegekend += unit.tantiemes;

    // Eigendom en tantième worden APART geteld; ze sluiten elkaar niet uit.
    const { klasse } = classifyOwnership(ownershipPerUnit.get(unit.id) ?? []);
    if (klasse === "geenEigenaar") zonderEigenaar += 1;
    else if (klasse === "ambigu") ambigu += 1;
    else if (klasse === "medeEigendom") medeEigendom += 1;

    if (unit.tantiemes <= 0) zonderTantieme += 1;
  }

  const eigendomVeilig = zonderEigenaar === 0 && ambigu === 0;
  const tantiemesKloppen = toegekend === verklaard;

  return {
    toegekend,
    verklaard,
    verschil: toegekend - verklaard,
    zonderEigenaar,
    medeEigendom,
    ambigu,
    zonderTantieme,
    eigendomVeilig,
    tantiemesKloppen,
    // `zonderTantieme` werd geteld maar niet meegewogen; een gebouw waarvan de
    // tantièmes toevallig optelden kon daardoor als gereed gelden terwijl een
    // deelnemend lot gewicht nul had en de engine ALLOC_WEIGHT_MISSING geeft.
    oproepVeilig:
      units.length > 0 && eigendomVeilig && tantiemesKloppen && zonderTantieme === 0,
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

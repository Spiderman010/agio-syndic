/**
 * Lastenoproepen: regelscope en de CONTROLE VÓÓR AANMAKEN.
 *
 * Geen React, geen databasetoegang: pure functies over rijen die de pagina al
 * heeft opgehaald.
 *
 * ── WAT DIT WEL IS ─────────────────────────────────────────────────────────
 *
 * Een controle op de VOORAF KENBARE weigeringen van `create_charge_call`. Elke
 * blokkade hieronder spiegelt één harde conditie uit m20 en draagt dezelfde
 * stabiele code, zodat scherm en database dezelfde taal spreken.
 *
 * ── WAT DIT NADRUKKELIJK NIET IS ───────────────────────────────────────────
 *
 * Geen verdeling. Er wordt hier geen enkel bedrag per lot berekend, geschat of
 * voorspeld. De centverdeling (`fn_alloc_distribute`, largest remainder, hele
 * centen, algoritmeversie 1) bestaat uitsluitend in de database en is bewust
 * niet aanroepbaar voor `authenticated`. Een tweede implementatie in
 * TypeScript zou bij de eerste afrondingswijziging stilzwijgend uiteen gaan
 * lopen met wat er werkelijk wordt geboekt — precies wat m15 en m20 uitsluiten.
 *
 * En geen garantie. Deze controle kijkt naar de gegevens zoals ze NU zijn; de
 * database controleert bij het definitief aanmaken alles opnieuw, binnen één
 * transactie en met rijvergrendeling. Tussen de controle en het aanmaken kan
 * een collega een eigendom wijzigen. De schermteksten formuleren dat ook zo:
 * "Controle vóór aanmaken", nooit "dit zal slagen".
 */

import {
  classifyOwnershipOn,
  type OwnershipRow,
} from "@/lib/ownership";

// ── Rijvormen ───────────────────────────────────────────────────────────────

export type AllocationMethod = "equal" | "tantieme" | "percentage" | "manual";
export type AllocationScope = "whole_building" | "block" | "selected_units";
export type AllocationWeightSource =
  | "none"
  | "unit_tantiemes"
  | "rule_weights"
  | "charge_call_lines";
export type AllocationRuleStatus = "draft" | "active" | "retired";
export type UncoveredUnitPolicy = "scope_default" | "fail";

/** Exact de kolommen van `allocation_rules` die de controle nodig heeft. */
export type AllocationRuleRow = {
  id: string;
  building_id: string;
  code: string;
  label: string;
  method: AllocationMethod;
  scope: AllocationScope;
  weight_source: AllocationWeightSource;
  scope_block_id: string | null;
  uncovered_unit_policy: UncoveredUnitPolicy;
  status: AllocationRuleStatus;
  is_default: boolean;
  /** Vervalboekjaar van een vastgelegde afwijking op de controlewaarde (F09). */
  partial_denominator_until_year: number | null;
};

export type ChargeUnitRow = {
  id: string;
  building_id: string;
  label: string;
  tantiemes: number | string | null;
  block_id: string | null;
};

/** Deelnamerij; de betekenis volgt uit de scope van de ouderregel. */
export type RuleUnitRow = { rule_id: string; unit_id: string };

export type RuleWeightRow = {
  rule_id: string;
  unit_id: string;
  weight: number | string;
};

/** Een lot zoals de melding het noemt: label uit de eigen, geautoriseerde query. */
export type LotRef = { id: string; label: string };

function getal(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Invoer uit het formulier ────────────────────────────────────────────────

/**
 * Het oproepbedrag zoals `validation.ts` het leest.
 *
 * Exact dezelfde stappen als het `amount`-schema, inclusief de eigenaardigheden:
 * witruimte eruit, de EERSTE komma wordt een punt, en dan `parseFloat` — die is
 * bewust mild, dus "12abc" levert 12 op. Strenger zijn zou een rode melding
 * opleveren op invoer die de applicatie daarna gewoon accepteert; dat is net zo
 * fout als vals groen.
 */
export function parseFormAmount(
  raw: string,
): { ok: true; value: number } | { ok: false } {
  const tekst = raw.trim();
  if (tekst === "") return { ok: false };
  const n = Number.parseFloat(tekst.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return { ok: false };
  if (n <= 0) return { ok: false };
  if (n > 1_000_000_000) return { ok: false };
  // Onder een halve cent is `n > 0` niet genoeg. `validation.ts` rondt het
  // bedrag NA die controle af op hele centen, dus 0,004 komt als 0,00 bij de
  // RPC aan en m20 weigert dan met ALLOC_AMOUNT_INVALID. Een drempel in plaats
  // van een afronding: hier wordt niets met centen gerekend.
  if (n < HALVE_CENT) return { ok: false };
  return { ok: true, value: n };
}

/** Het kleinste bedrag dat na afronding op hele centen nog boven nul uitkomt. */
const HALVE_CENT = 0.005;

/** Het datumformaat dat `validation.ts` als enige accepteert. */
const ISO_DATUM = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Eén handmatig bedrag zoals `collectManualLines()` het leest.
 *
 * Let op het verschil met het oproepbedrag: die gebruikt `parseFloat`, deze
 * `Number()`. `Number("12abc")` is NaN, `parseFloat("12abc")` is 12. Dat is
 * bestaand gedrag van twee verschillende plekken; deze functie spiegelt de
 * plek die er werkelijk toe doet voor dit veld.
 *
 * Een LEEG veld is geldig en betekent 0,00 — precies wat `collectManualLines()`
 * ervan maakt. Nul is toegestaan: de database weigert alleen een NEGATIEF
 * bedrag (`ALLOC_MANUAL_NEGATIVE`).
 */
export function parseManualAmount(
  raw: string,
): { ok: true; value: number; filled: boolean } | { ok: false } {
  const tekst = raw.trim().replace(",", ".");
  if (tekst === "") return { ok: true, value: 0, filled: false };
  const n = Number(tekst);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n, filled: true };
}

function naarLotRef(u: ChargeUnitRow): LotRef {
  return { id: u.id, label: u.label };
}

function opLabel(a: LotRef, b: LotRef): number {
  return a.label.localeCompare(b.label);
}

// ── Regelscope ──────────────────────────────────────────────────────────────

/**
 * De deelnemende lots van een verdeelregel — letterlijk `fn_alloc_scope_units`:
 *
 *     (scope <> 'block' OR u.block_id IS NOT DISTINCT FROM r.scope_block_id)
 *     AND ( scope IN ('whole_building','block') AND NOT EXISTS aru
 *           OR scope = 'selected_units'         AND EXISTS aru )
 *
 * De betekenis van `allocation_rule_units` KANTELT met de scope: bij
 * `whole_building` en `block` is een rij een UITSLUITING, bij `selected_units`
 * een INSLUITING. Dat is geen implementatiedetail maar het model uit m12, waar
 * de scope via een samengestelde foreign key aan elke deelnamerij is vastgepind
 * juist zodat die betekenis niet kan omslaan.
 */
export function ruleScopeUnits(
  rule: AllocationRuleRow,
  units: readonly ChargeUnitRow[],
  ruleUnits: readonly RuleUnitRow[],
): ChargeUnitRow[] {
  const genoemd = new Set(
    ruleUnits.filter((r) => r.rule_id === rule.id).map((r) => r.unit_id),
  );

  return units
    .filter((u) => u.building_id === rule.building_id)
    .filter((u) =>
      rule.scope === "block" ? u.block_id === rule.scope_block_id : true,
    )
    .filter((u) =>
      rule.scope === "selected_units" ? genoemd.has(u.id) : !genoemd.has(u.id),
    );
}

/**
 * Lots waarover een `selected_units`-regel niets zegt — `fn_alloc_uncovered_units`.
 * Alleen betekenisvol bij die scope; de andere twee zijn zelfonderhoudend.
 */
export function uncoveredUnits(
  rule: AllocationRuleRow,
  units: readonly ChargeUnitRow[],
  ruleUnits: readonly RuleUnitRow[],
): ChargeUnitRow[] {
  if (rule.scope !== "selected_units") return [];
  const genoemd = new Set(
    ruleUnits.filter((r) => r.rule_id === rule.id).map((r) => r.unit_id),
  );
  return units
    .filter((u) => u.building_id === rule.building_id)
    .filter((u) => !genoemd.has(u.id));
}

// ── Uitkomst van de controle ────────────────────────────────────────────────

/**
 * Een blokkade draagt de stabiele enginecode, zodat het scherm dezelfde
 * vertaalsleutel gebruikt als wanneer de database hem alsnog terugmeldt.
 */
export type ReadinessBlocker =
  | { code: "ALLOC_RULE_INACTIVE" }
  | { code: "ALLOC_RULE_WRONG_BUILDING" }
  | { code: "ALLOC_FY_CLOSED" }
  | { code: "ALLOC_EMPTY_BLOCK" }
  | { code: "ALLOC_NO_PARTICIPANTS" }
  | { code: "ALLOC_UNCOVERED_UNITS"; units: LotRef[] }
  | { code: "ALLOC_WEIGHT_MISSING"; units: LotRef[] }
  | { code: "ALLOC_NO_OWNER"; units: LotRef[] }
  | { code: "ALLOC_AMBIGUOUS_OWNER"; units: LotRef[] }
  | { code: "ALLOC_MANUAL_MISSING" }
  | { code: "ALLOC_MANUAL_NEGATIVE"; units: LotRef[] }
  | {
      /** Een handmatig veld is geen getal; `collectManualLines()` weigert dit. */
      code: "FORM_MANUAL_INVALID";
      units: LotRef[];
    }
  | {
      /** Leeg, niet-numeriek, niet-eindig, nul, negatief of onrealistisch hoog. */
      code: "FORM_AMOUNT_INVALID";
    }
  | {
      /** `chargeCallSchema` eist `due_date >= call_date`; gelijk mag. */
      code: "FORM_DUE_BEFORE_CALL";
    }
  | {
      /** Geen of geen volledige `YYYY-MM-DD`; `isoDate` weigert dat. */
      code: "FORM_CALL_DATE_INVALID";
    }
  | {
      /**
       * De percentages tellen niet op tot exact 100. De database rekent in
       * miljoensten en vergelijkt met 100000000; zie `percentageTotalPpm()`.
       */
      code: "ALLOC_PCT_SUM";
      /** De som in miljoensten, zoals m20 hem berekent. */
      ppm: number;
    }
  | {
      code: "ALLOC_CONTROL_TOTAL";
      /** Som van de tantièmes van de deelnemende lots. */
      participating: number;
      /** `buildings.total_tantiemes`, de verklaarde controlewaarde. */
      declared: number;
    };

/** Een aandachtspunt dat het aanmaken NIET tegenhoudt. */
export type ReadinessNotice =
  | {
      /** Vastgelegde afwijking op de controlewaarde; geldig t/m dit boekjaar. */
      code: "PARTIAL_DENOMINATOR";
      participating: number;
      declared: number;
      untilYear: number;
    }
  | {
      /** Handmatige verdeling: de database toetst de som, niet dit scherm. */
      code: "MANUAL_SUM_CHECKED_BY_DATABASE";
    };

export type ChargeCallReadiness = {
  /** Aantal lots binnen de scope van de gekozen regel. */
  participantCount: number;
  /** Alleen de labels, voor het scherm; nooit bedragen. */
  participants: LotRef[];
  blockers: ReadinessBlocker[];
  notices: ReadinessNotice[];
  /** Geen enkele vooraf kenbare blokkade gevonden. Nooit een garantie. */
  clear: boolean;
};

export type ReadinessInput = {
  rule: AllocationRuleRow;
  /** Het gebouw uit de URL; de regel moet daarbij horen. */
  buildingId: string;
  /** `buildings.total_tantiemes`, de verklaarde controlewaarde. */
  declaredTantiemes: number | string | null;
  /** Het boekjaar waarin de oproep valt. */
  fiscalYear: { year: number; status: "open" | "closed" };
  /** De oproepdatum uit het formulier, `YYYY-MM-DD`. */
  callDate: string;
  units: readonly ChargeUnitRow[];
  ruleUnits: readonly RuleUnitRow[];
  ruleWeights: readonly RuleWeightRow[];
  /** Eigendomsrijen van de lots van dit gebouw. */
  ownership: readonly OwnershipRow[];
  /** Het ingevulde oproepbedrag, onbewerkt uit het formulier. */
  totalAmount: string;
  /** De ingevulde vervaldatum, onbewerkt; leeg is toegestaan. */
  dueDate: string;
  /** Bij een handmatige regel: de onbewerkte bedragen per lot-id. */
  manualAmounts?: Readonly<Record<string, string>>;
};

/**
 * De som van de percentages in MILJOENSTEN, exact zoals m20 hem berekent:
 *
 *     round(weight * 1000000)  per deelnemende rij, daarna sommeren
 *
 * Afronden gebeurt PER RIJ en niet over de som, omdat de database dat ook zo
 * doet — `array_agg(round(w.weight * 1000000)::bigint)` gevolgd door `sum`.
 * Rond je pas op het eind af, dan wijkt de uitkomst af bij gewichten met meer
 * dan zes decimalen.
 *
 * Dit is GEWICHTSVALIDATIE, geen geldverdeling: er komt geen bedrag, geen cent
 * en geen restverdeling aan te pas.
 */
export function percentageTotalPpm(
  rule: AllocationRuleRow,
  participants: readonly ChargeUnitRow[],
  ruleWeights: readonly RuleWeightRow[],
): number {
  const inScope = new Set(participants.map((u) => u.id));
  let ppm = 0;
  for (const w of ruleWeights) {
    // Alleen de gekozen regel, en alleen de daadwerkelijke deelnemers.
    if (w.rule_id !== rule.id) continue;
    if (!inScope.has(w.unit_id)) continue;
    ppm += Math.round(getal(w.weight) * 1_000_000);
  }
  return ppm;
}

/** De waarde die m20 eist voor een percentageregel: 100,000000 procent. */
const PERCENTAGE_TOTAAL_PPM = 100_000_000;

/**
 * De controle vóór aanmaken.
 *
 * De volgorde volgt m20, zodat de gebruiker dezelfde oorzaak als eerste ziet
 * die de database als eerste zou melden. Alle blokkades worden wél verzameld —
 * één probleem per poging oplossen is precies de ervaring die dit scherm moet
 * voorkomen.
 */
export function chargeCallReadiness(input: ReadinessInput): ChargeCallReadiness {
  const {
    rule,
    buildingId,
    declaredTantiemes,
    fiscalYear,
    callDate,
    units,
    ruleUnits,
    ruleWeights,
    ownership,
    totalAmount,
    dueDate,
    manualAmounts,
  } = input;

  const blockers: ReadinessBlocker[] = [];
  const notices: ReadinessNotice[] = [];

  // 0. Wat het formulier NU bevat. Deze twee weigeringen zijn deterministisch
  //    bekend vóór er ook maar iets naar de server gaat: `chargeCallSchema`
  //    weigert het bedrag, en de refine erop weigert de datumvolgorde. Een
  //    groene controle op invoer die de volgende stap zeker afkeurt is precies
  //    het gedrag dat deze controle moet uitsluiten.
  if (!parseFormAmount(totalAmount).ok) {
    blockers.push({ code: "FORM_AMOUNT_INVALID" });
  }

  // Een lege of onvolledige oproepdatum is geen detail: `isoDate` weigert hem,
  // en zonder geldige datum is "wie is op die dag eigenaar" een zinloze vraag.
  // Zonder deze controle zou de vergelijking met de vervaldatum stilletjes
  // slagen (`"2026-06-29" < ""` is false) en zou elk lot ten onrechte als
  // "geen eigenaar" worden gemeld.
  const datumGeldig = ISO_DATUM.test(callDate);
  if (!datumGeldig) blockers.push({ code: "FORM_CALL_DATE_INVALID" });

  if (datumGeldig && dueDate.trim() !== "" && dueDate < callDate) {
    blockers.push({ code: "FORM_DUE_BEFORE_CALL" });
  }

  // 1. Regel en boekjaar — de poortcondities uit stap 3 en 4 van m20.
  if (rule.building_id !== buildingId) {
    blockers.push({ code: "ALLOC_RULE_WRONG_BUILDING" });
    return { participantCount: 0, participants: [], blockers, notices, clear: false };
  }
  if (rule.status !== "active") blockers.push({ code: "ALLOC_RULE_INACTIVE" });
  if (fiscalYear.status === "closed") blockers.push({ code: "ALLOC_FY_CLOSED" });

  // 2. Deelnemersverzameling.
  const deelnemers = ruleScopeUnits(rule, units, ruleUnits);
  const participants = deelnemers.map(naarLotRef).sort(opLabel);

  if (rule.uncovered_unit_policy === "fail") {
    const ongedekt = uncoveredUnits(rule, units, ruleUnits).map(naarLotRef).sort(opLabel);
    if (ongedekt.length > 0) {
      blockers.push({ code: "ALLOC_UNCOVERED_UNITS", units: ongedekt });
    }
  }

  if (deelnemers.length === 0) {
    blockers.push(
      rule.scope === "block"
        ? { code: "ALLOC_EMPTY_BLOCK" }
        : { code: "ALLOC_NO_PARTICIPANTS" },
    );
    return {
      participantCount: 0,
      participants,
      blockers,
      notices,
      clear: false,
    };
  }

  // 3. Gewichten per methode. Geen enkele tak kent een stille terugval: een
  //    ontbrekend of niet-positief gewicht is een harde fout, nooit een
  //    impliciete uitsluiting.
  if (rule.method === "equal") {
    // `equal` kent per definitie geen ontbrekend gewicht.
  } else if (rule.weight_source === "unit_tantiemes") {
    const zonder = deelnemers
      .filter((u) => getal(u.tantiemes) <= 0)
      .map(naarLotRef)
      .sort(opLabel);
    if (zonder.length > 0) blockers.push({ code: "ALLOC_WEIGHT_MISSING", units: zonder });
  } else if (rule.weight_source === "rule_weights") {
    const metGewicht = new Set(
      ruleWeights.filter((w) => w.rule_id === rule.id).map((w) => w.unit_id),
    );
    const zonder = deelnemers
      .filter((u) => !metGewicht.has(u.id))
      .map(naarLotRef)
      .sort(opLabel);
    if (zonder.length > 0) blockers.push({ code: "ALLOC_WEIGHT_MISSING", units: zonder });

    // De noemer telt pas ergens op als élk deelnemend lot een gewicht heeft;
    // met een ontbrekende rij zegt de som niets en staat er al een blokkade.
    if (zonder.length === 0 && rule.method === "percentage") {
      const ppm = percentageTotalPpm(rule, deelnemers, ruleWeights);
      if (ppm !== PERCENTAGE_TOTAAL_PPM) {
        blockers.push({ code: "ALLOC_PCT_SUM", ppm });
      }
    }
  } else if (rule.method === "manual") {
    // Twee dingen die `collectManualLines()` en m20 deterministisch weigeren:
    // een veld dat geen getal is, en een negatief bedrag. Een LEEG veld is
    // geldig en telt als 0,00 — precies wat de actie ervan maakt — en nul is
    // toegestaan; alleen negatief niet.
    //
    // Of de bedragen exact optellen tot het oproepbedrag blijft bij de
    // database (ALLOC_MANUAL_SUM). Die som in TypeScript naleggen zou een
    // tweede financiële waarheid opleveren over afronding van centen.
    const bedragen = manualAmounts ?? {};
    const ongeldig: LotRef[] = [];
    const negatief: LotRef[] = [];
    let ingevuld = false;

    for (const u of deelnemers) {
      const gelezen = parseManualAmount(bedragen[u.id] ?? "");
      if (!gelezen.ok) {
        ongeldig.push(naarLotRef(u));
        continue;
      }
      if (gelezen.filled) ingevuld = true;
      if (gelezen.value < 0) negatief.push(naarLotRef(u));
    }

    if (ongeldig.length > 0) {
      blockers.push({ code: "FORM_MANUAL_INVALID", units: ongeldig.sort(opLabel) });
    }
    if (negatief.length > 0) {
      blockers.push({ code: "ALLOC_MANUAL_NEGATIVE", units: negatief.sort(opLabel) });
    }
    // Geen enkel veld ingevuld: de actie stuurt dan `p_manual_lines = null` en
    // de database weigert met ALLOC_MANUAL_MISSING.
    if (!ingevuld && ongeldig.length === 0) {
      blockers.push({ code: "ALLOC_MANUAL_MISSING" });
    }
    notices.push({ code: "MANUAL_SUM_CHECKED_BY_DATABASE" });
  }

  // 4. Controlewaarde (F09). Geldt UITSLUITEND voor een tantième-verdeling over
  //    het hele gebouw op `units.tantiemes`: alleen dan bestaat er een
  //    verklaarde controlewaarde voor exact deze verzameling. Een vastgelegde
  //    afwijking geldt tot en met haar vervalboekjaar en is dan geen blokkade.
  if (
    rule.method === "tantieme" &&
    rule.scope === "whole_building" &&
    rule.weight_source === "unit_tantiemes"
  ) {
    const participating = deelnemers.reduce((s, u) => s + getal(u.tantiemes), 0);
    const declared = getal(declaredTantiemes);
    if (participating !== declared) {
      const tot = rule.partial_denominator_until_year;
      if (tot !== null && fiscalYear.year <= tot) {
        notices.push({
          code: "PARTIAL_DENOMINATOR",
          participating,
          declared,
          untilYear: tot,
        });
      } else {
        blockers.push({ code: "ALLOC_CONTROL_TOTAL", participating, declared });
      }
    }
  }

  // 5. Eigenaarscontrole OP DE OPROEPDATUM.
  const perUnit = new Map<string, OwnershipRow[]>();
  for (const rij of ownership) {
    const lijst = perUnit.get(rij.unit_id);
    if (lijst) lijst.push(rij);
    else perUnit.set(rij.unit_id, [rij]);
  }

  const zonderEigenaar: LotRef[] = [];
  const ambigu: LotRef[] = [];
  // Zonder geldige oproepdatum heeft deze vraag geen antwoord; hem toch stellen
  // zou elk lot als "geen eigenaar" melden en de echte oorzaak verbergen.
  for (const u of datumGeldig ? deelnemers : []) {
    const { klasse } = classifyOwnershipOn(perUnit.get(u.id) ?? [], callDate);
    if (klasse === "geenEigenaar") zonderEigenaar.push(naarLotRef(u));
    else if (klasse === "ambigu") ambigu.push(naarLotRef(u));
  }
  if (zonderEigenaar.length > 0) {
    blockers.push({ code: "ALLOC_NO_OWNER", units: zonderEigenaar.sort(opLabel) });
  }
  if (ambigu.length > 0) {
    blockers.push({ code: "ALLOC_AMBIGUOUS_OWNER", units: ambigu.sort(opLabel) });
  }

  return {
    participantCount: deelnemers.length,
    participants,
    blockers,
    notices,
    clear: blockers.length === 0,
  };
}

// ── Foutcodes van de engine ────────────────────────────────────────────────

/**
 * `ALLOC_*` naar vertaalsleutel binnen `charges.errors`.
 *
 * De engine werpt `CODE: Nederlandse uitleg` met SQLSTATE 23514. Die uitleg is
 * geschreven voor de ontwikkelaar, niet voor een Marokkaanse syndic, en mag
 * dus nooit rechtstreeks in beeld komen. Alleen de CODE wordt gebruikt; de
 * rest van de melding wordt weggegooid, inclusief de lotlabels die erin staan.
 * Labels die het scherm toont komen uit de eigen, al geautoriseerde query.
 *
 * Codes zijn alleen samengevoegd wanneer de HERSTELACTIE van de gebruiker
 * werkelijk dezelfde is. `ALLOC_WEIGHT_MISSING` en `ALLOC_CONTROL_TOTAL` staan
 * daarom los: het eerste betekent "vul een tantième in", het tweede "de som
 * klopt niet met het règlement".
 */
const CHARGE_ERROR_KEYS: Record<string, string> = {
  // Autorisatie en scope
  ALLOC_FORBIDDEN: "forbidden",
  ALLOC_FY_NOT_FOUND: "fiscalYearNotFound",
  ALLOC_FY_CLOSED: "fiscalYearClosed",

  // Verdeelregel
  ALLOC_NO_DEFAULT_RULE: "noDefaultRule",
  ALLOC_RULE_NOT_FOUND: "ruleNotFound",
  ALLOC_RULE_WRONG_BUILDING: "ruleWrongBuilding",
  ALLOC_RULE_INACTIVE: "ruleInactive",
  ALLOC_METHOD_UNSUPPORTED: "methodUnsupported",

  // Bedrag
  ALLOC_AMOUNT_INVALID: "amountInvalid",

  // Deelnemers
  ALLOC_EMPTY_BLOCK: "emptyBlock",
  ALLOC_NO_PARTICIPANTS: "noParticipants",
  ALLOC_UNCOVERED_UNITS: "uncoveredUnits",

  // Gewichten en noemer
  ALLOC_WEIGHT_MISSING: "weightMissing",
  ALLOC_ZERO_DENOMINATOR: "zeroDenominator",
  ALLOC_PCT_SUM: "percentageSum",
  ALLOC_CONTROL_TOTAL: "controlTotal",
  ALLOC_DENOM_MISMATCH: "integrity",
  ALLOC_COUNT_MISMATCH: "integrity",
  ALLOC_RANK_MISMATCH: "integrity",
  ALLOC_SUM_MISMATCH: "integrity",

  // Handmatige verdeling. Vier verschillende herstelacties, dus vier sleutels;
  // duplicaat en buiten-scope betekenen allebei "deze regel hoort hier niet",
  // maar de gebruiker herstelt ze anders en houdt daarom een eigen tekst.
  ALLOC_MANUAL_MISSING: "manualMissing",
  ALLOC_MANUAL_MISSING_UNIT: "manualMissingUnit",
  ALLOC_MANUAL_OUT_OF_SCOPE: "manualOutOfScope",
  ALLOC_MANUAL_DUPLICATE: "manualDuplicate",
  ALLOC_MANUAL_NEGATIVE: "manualNegative",
  ALLOC_MANUAL_SUM: "manualSum",

  // Eigendom
  ALLOC_NO_OWNER: "noOwner",
  ALLOC_AMBIGUOUS_OWNER: "ambiguousOwner",
  ALLOC_OWNER_HAS_HISTORY: "ownerHasHistory",
  ALLOC_OWNER_HAS_PAYMENTS: "ownerHasPayments",
  ALLOC_UNIT_HAS_HISTORY: "unitHasHistory",

  // Onveranderlijkheid van een bestaande oproep
  ALLOC_CALL_IMMUTABLE: "callImmutable",
  ALLOC_CALL_PAID: "callPaid",
  ALLOC_SNAPSHOT_IMMUTABLE: "callImmutable",
  ALLOC_BLOCK_MOVE: "blockMove",
  ALLOC_TRUNCATE_BLOCKED: "integrity",
};

/**
 * Codes die alléén uit de controle vóór aanmaken komen.
 *
 * Ze dragen bewust geen `ALLOC_`-voorvoegsel: de engine kent ze niet. Het zijn
 * weigeringen van de laag ervoor — `chargeCallSchema` en `collectManualLines()`
 * — die deterministisch bekend zijn zolang de gebruiker nog typt.
 */
const FORM_BLOCKER_KEYS: Record<string, string> = {
  FORM_AMOUNT_INVALID: "amountInvalid",
  FORM_CALL_DATE_INVALID: "callDateInvalid",
  FORM_DUE_BEFORE_CALL: "dueBeforeCall",
  FORM_MANUAL_INVALID: "manualInvalidNumber",
};

/** Precies het patroon van de engine: een kale code gevolgd door een dubbele punt. */
const ENGINE_CODE = /^([A-Z][A-Z0-9_]{4,}):/;

/** De stabiele code uit een enginemelding, of null. */
export function chargeErrorCode(message: string | null | undefined): string | null {
  const match = ENGINE_CODE.exec((message ?? "").trim());
  return match ? match[1] : null;
}

/**
 * Vertaalsleutel binnen `charges.errors` voor een databasefout.
 *
 * Valt bewust terug op `generic` in plaats van de databasetekst door te geven:
 * een onbekende fout is geen reden om Nederlandse of PostgreSQL-proza aan een
 * Franstalige gebruiker te tonen.
 */
export function chargeErrorKey(message: string | null | undefined): string {
  const code = chargeErrorCode(message);
  if (!code) return "generic";
  return CHARGE_ERROR_KEYS[code] ?? "generic";
}

/** Vertaalsleutel voor een blokkade uit de controle vóór aanmaken. */
export function blockerKey(blocker: ReadinessBlocker): string {
  return CHARGE_ERROR_KEYS[blocker.code] ?? FORM_BLOCKER_KEYS[blocker.code] ?? "generic";
}

/** Alle codes die een vertaling moeten hebben; gebruikt door de pariteittest. */
export function chargeErrorKeys(): string[] {
  return Array.from(
    new Set([...Object.values(CHARGE_ERROR_KEYS), ...Object.values(FORM_BLOCKER_KEYS)]),
  ).sort();
}

/** Alle door de engine gedocumenteerde codes die deze mapping dekt. */
export function mappedChargeErrorCodes(): string[] {
  return Object.keys(CHARGE_ERROR_KEYS).sort();
}

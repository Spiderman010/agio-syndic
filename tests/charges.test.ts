import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTranslator } from "next-intl";
import {
  blockerKey,
  chargeCallReadiness,
  chargeErrorCode,
  chargeErrorKey,
  chargeErrorKeys,
  mappedChargeErrorCodes,
  parseFormAmount,
  parseManualAmount,
  percentageTotalPpm,
  ruleScopeUnits,
  uncoveredUnits,
  type AllocationRuleRow,
  type ChargeUnitRow,
  type ReadinessInput,
  type RuleUnitRow,
  type RuleWeightRow,
} from "@/lib/charges";
import {
  classifyOwnershipOn,
  ownershipsOn,
  resolveOwnerOn,
  type OwnershipRow,
} from "@/lib/ownership";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const BLD = "11111111-1111-1111-1111-111111111111";
const BLOK_A = "aaaaaaaa-0000-0000-0000-0000000000aa";
const U1 = "u1111111-0000-0000-0000-000000000001";
const U2 = "u2222222-0000-0000-0000-000000000002";
const U3 = "u3333333-0000-0000-0000-000000000003";
const O1 = "o1111111-0000-0000-0000-000000000001";
const O2 = "o2222222-0000-0000-0000-000000000002";
const REGEL = "r1111111-0000-0000-0000-000000000001";

function unit(id: string, label: string, tantiemes: number, block: string | null = null): ChargeUnitRow {
  return { id, building_id: BLD, label, tantiemes, block_id: block };
}

function bezit(over: Partial<OwnershipRow> & { unit_id: string }): OwnershipRow {
  return {
    id: `own-${over.unit_id}-${over.owner_id ?? O1}-${over.start_date ?? "x"}`,
    owner_id: O1,
    share: 1,
    start_date: "2026-01-01",
    end_date: null,
    is_primary_debtor: true,
    ...over,
  };
}

function regel(over: Partial<AllocationRuleRow> = {}): AllocationRuleRow {
  return {
    id: REGEL,
    building_id: BLD,
    code: "general",
    label: "Charges générales",
    method: "tantieme",
    scope: "whole_building",
    weight_source: "unit_tantiemes",
    scope_block_id: null,
    uncovered_unit_policy: "scope_default",
    status: "active",
    is_default: true,
    partial_denominator_until_year: null,
    ...over,
  };
}

function invoer(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    rule: regel(),
    buildingId: BLD,
    declaredTantiemes: 100,
    fiscalYear: { year: 2026, status: "open", startDate: "2026-01-01", endDate: "2026-12-31" },
    callDate: "2026-06-30",
    units: [unit(U1, "A1", 60), unit(U2, "A2", 40)],
    ruleUnits: [],
    ruleWeights: [],
    ownership: [bezit({ unit_id: U1 }), bezit({ unit_id: U2 })],
    // Geldige formulierinvoer, zodat een test die over de scope of de
    // eigendom gaat niet per ongeluk op een formulierblokkade stuit.
    totalAmount: "1200.00",
    dueDate: "",
    ...over,
  };
}

/** De codes van de blokkades, in de volgorde waarin de controle ze meldt. */
function codes(r: ReturnType<typeof chargeCallReadiness>): string[] {
  return r.blockers.map((b) => b.code);
}

/** Broncode zonder commentaar, zodat een toelichting geen overtreding wordt. */
function zonderCommentaar(bron: string): string {
  return bron.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

// ── 1-5. Datumsemantiek van de eigendomsresolutie ───────────────────────────

describe("CD — eigendom op de oproepdatum", () => {
  it("CD1 — een eigendom die op exact de oproepdatum loopt, telt mee", () => {
    const rijen = [bezit({ unit_id: U1, start_date: "2026-06-30", end_date: "2026-06-30" })];
    expect(ownershipsOn(rijen, "2026-06-30")).toHaveLength(1);
    expect(classifyOwnershipOn(rijen, "2026-06-30").klasse).toBe("enkel");
  });

  it("CD2 — de startdatum is INCLUSIEF", () => {
    const rijen = [bezit({ unit_id: U1, start_date: "2026-06-30" })];
    expect(classifyOwnershipOn(rijen, "2026-06-30").nActive).toBe(1);
    // Eén dag ervoor bestaat de eigendom nog niet.
    expect(classifyOwnershipOn(rijen, "2026-06-29").klasse).toBe("geenEigenaar");
  });

  it("CD3 — de einddatum is INCLUSIEF: de laatste eigendomsdag telt nog mee", () => {
    const rijen = [bezit({ unit_id: U1, start_date: "2026-01-01", end_date: "2026-06-30" })];
    expect(classifyOwnershipOn(rijen, "2026-06-30").klasse).toBe("enkel");
    expect(classifyOwnershipOn(rijen, "2026-07-01").klasse).toBe("geenEigenaar");
  });

  it("CD4 — uitsluitend gesloten historie vóór de oproepdatum telt niet mee", () => {
    const rijen = [bezit({ unit_id: U1, start_date: "2024-01-01", end_date: "2025-12-31" })];
    expect(classifyOwnershipOn(rijen, "2026-06-30").klasse).toBe("geenEigenaar");
    expect(resolveOwnerOn(rijen, "2026-06-30")).toBeNull();
  });

  it("CD5 — een eigendom die pas ná de oproepdatum begint telt niet mee", () => {
    const rijen = [bezit({ unit_id: U1, start_date: "2026-07-01" })];
    expect(classifyOwnershipOn(rijen, "2026-06-30").klasse).toBe("geenEigenaar");
  });

  it("CD6 — de datumloze variant zou hier een ANDER antwoord geven", () => {
    // Precies de reden dat classifyOwnership() hier niet mag worden hergebruikt:
    // een lopende rij die pas na de oproepdatum begint is "actueel", maar op de
    // oproepdatum bestaat er geen eigenaar.
    const rijen = [bezit({ unit_id: U1, start_date: "2026-07-01", end_date: null })];
    expect(classifyOwnershipOn(rijen, "2026-06-30").klasse).toBe("geenEigenaar");
  });

  it("CD7 — meerdere eigenaars met exact één aangewezen debiteur is toegestaan", () => {
    const rijen = [
      bezit({ unit_id: U1, owner_id: O1, share: 0.5, is_primary_debtor: true }),
      bezit({ unit_id: U1, owner_id: O2, share: 0.5, is_primary_debtor: false }),
    ];
    const k = classifyOwnershipOn(rijen, "2026-06-30");
    expect(k.nActive).toBe(2);
    expect(k.nPrimary).toBe(1);
    expect(k.klasse).toBe("medeEigendom");
    expect(k.toewijsbaar).toBe(true);
    expect(k.debiteur?.owner_id).toBe(O1);
  });

  it("CD8 — meerdere eigenaars zonder exact één debiteur is ambigu", () => {
    const geen = [
      bezit({ unit_id: U1, owner_id: O1, is_primary_debtor: false }),
      bezit({ unit_id: U1, owner_id: O2, is_primary_debtor: false }),
    ];
    const twee = [
      bezit({ unit_id: U1, owner_id: O1, is_primary_debtor: true }),
      bezit({ unit_id: U1, owner_id: O2, is_primary_debtor: true }),
    ];
    expect(classifyOwnershipOn(geen, "2026-06-30").klasse).toBe("ambigu");
    expect(classifyOwnershipOn(twee, "2026-06-30").klasse).toBe("ambigu");
  });
});

// ── 8-9. Regelscope ─────────────────────────────────────────────────────────

describe("RS — regelscope", () => {
  const units = [unit(U1, "A1", 50, BLOK_A), unit(U2, "A2", 30, BLOK_A), unit(U3, "B1", 20, null)];

  it("RS1 — whole_building: een deelnamerij is een UITSLUITING", () => {
    const r = regel({ scope: "whole_building" });
    const aru: RuleUnitRow[] = [{ rule_id: REGEL, unit_id: U3 }];
    expect(ruleScopeUnits(r, units, aru).map((u) => u.id)).toEqual([U1, U2]);
  });

  it("RS2 — selected_units: een deelnamerij is een INSLUITING", () => {
    const r = regel({ scope: "selected_units" });
    const aru: RuleUnitRow[] = [{ rule_id: REGEL, unit_id: U3 }];
    expect(ruleScopeUnits(r, units, aru).map((u) => u.id)).toEqual([U3]);
  });

  it("RS3 — block: alleen lots van dat blok, minus uitsluitingen", () => {
    const r = regel({ scope: "block", scope_block_id: BLOK_A });
    expect(ruleScopeUnits(r, units, []).map((u) => u.id)).toEqual([U1, U2]);
    expect(
      ruleScopeUnits(r, units, [{ rule_id: REGEL, unit_id: U2 }]).map((u) => u.id),
    ).toEqual([U1]);
  });

  it("RS4 — een deelnamerij van een ANDERE regel telt niet mee", () => {
    const r = regel({ scope: "selected_units" });
    const aru: RuleUnitRow[] = [{ rule_id: "andere-regel", unit_id: U1 }];
    expect(ruleScopeUnits(r, units, aru)).toHaveLength(0);
  });

  it("RS5 — uncoveredUnits is alleen betekenisvol bij selected_units", () => {
    expect(uncoveredUnits(regel({ scope: "whole_building" }), units, [])).toHaveLength(0);
    const r = regel({ scope: "selected_units" });
    expect(
      uncoveredUnits(r, units, [{ rule_id: REGEL, unit_id: U1 }]).map((u) => u.id),
    ).toEqual([U2, U3]);
  });

  it("RS6 — alleen lots BINNEN de scope worden gecontroleerd", () => {
    // U3 heeft geen eigenaar, maar valt buiten de regel: geen blokkade.
    const r = regel({ scope: "selected_units" });
    const uit = chargeCallReadiness(
      invoer({
        rule: r,
        units,
        ruleUnits: [
          { rule_id: REGEL, unit_id: U1 },
          { rule_id: REGEL, unit_id: U2 },
        ],
        declaredTantiemes: 80,
        ownership: [bezit({ unit_id: U1 }), bezit({ unit_id: U2 })],
      }),
    );
    expect(uit.participantCount).toBe(2);
    expect(uit.blockers).toEqual([]);
    expect(uit.clear).toBe(true);
  });

  it("RS7 — een probleem BUITEN de regelscope blokkeert niet", () => {
    const r = regel({ scope: "block", scope_block_id: BLOK_A });
    const uit = chargeCallReadiness(
      invoer({
        rule: r,
        units,
        // U3 heeft tantième 20 maar geen eigenaar; hij zit niet in blok A.
        ownership: [bezit({ unit_id: U1 }), bezit({ unit_id: U2 })],
      }),
    );
    expect(uit.participants.map((p) => p.label)).toEqual(["A1", "A2"]);
    expect(codes(uit)).not.toContain("ALLOC_NO_OWNER");
  });

  it("RS8 — een leeg blok blokkeert met ALLOC_EMPTY_BLOCK, niet met NO_PARTICIPANTS", () => {
    const r = regel({ scope: "block", scope_block_id: "leeg-blok" });
    const uit = chargeCallReadiness(invoer({ rule: r, units }));
    expect(codes(uit)).toContain("ALLOC_EMPTY_BLOCK");
    expect(codes(uit)).not.toContain("ALLOC_NO_PARTICIPANTS");
  });

  it("RS9 — geen enkel deelnemend lot buiten blokscope geeft ALLOC_NO_PARTICIPANTS", () => {
    const r = regel({ scope: "selected_units" });
    const uit = chargeCallReadiness(invoer({ rule: r, units, ruleUnits: [] }));
    expect(codes(uit)).toContain("ALLOC_NO_PARTICIPANTS");
  });

  it("RS10 — uncovered_unit_policy 'fail' blokkeert een onvolledige selectie", () => {
    const r = regel({ scope: "selected_units", uncovered_unit_policy: "fail" });
    const uit = chargeCallReadiness(
      invoer({
        rule: r,
        units,
        ruleUnits: [{ rule_id: REGEL, unit_id: U1 }],
        declaredTantiemes: 50,
        ownership: [bezit({ unit_id: U1 })],
      }),
    );
    const blok = uit.blockers.find((b) => b.code === "ALLOC_UNCOVERED_UNITS");
    expect(blok).toBeDefined();
    expect(blok && "units" in blok ? blok.units.map((u) => u.label) : []).toEqual(["A2", "B1"]);
  });
});

// ── 10. Gewichten ───────────────────────────────────────────────────────────

describe("GW — gewichten binnen de regelscope", () => {
  it("GW1 — tantième nul binnen de scope blokkeert", () => {
    const uit = chargeCallReadiness(
      invoer({ units: [unit(U1, "A1", 100), unit(U2, "A2", 0)], declaredTantiemes: 100 }),
    );
    const blok = uit.blockers.find((b) => b.code === "ALLOC_WEIGHT_MISSING");
    expect(blok && "units" in blok ? blok.units.map((u) => u.label) : []).toEqual(["A2"]);
  });

  it("GW2 — een ontbrekende tantième (null) blokkeert net zo goed", () => {
    const uit = chargeCallReadiness(
      invoer({ units: [unit(U1, "A1", 100), unit(U2, "A2", null as unknown as number)] }),
    );
    expect(codes(uit)).toContain("ALLOC_WEIGHT_MISSING");
  });

  it("GW3 — rule_weights: een deelnemend lot zonder gewichtrij blokkeert", () => {
    const r = regel({ method: "percentage", weight_source: "rule_weights" });
    const gewichten: RuleWeightRow[] = [{ rule_id: REGEL, unit_id: U1, weight: 100 }];
    const uit = chargeCallReadiness(invoer({ rule: r, ruleWeights: gewichten }));
    const blok = uit.blockers.find((b) => b.code === "ALLOC_WEIGHT_MISSING");
    expect(blok && "units" in blok ? blok.units.map((u) => u.label) : []).toEqual(["A2"]);
  });

  it("GW4 — equal kent per definitie geen ontbrekend gewicht", () => {
    const r = regel({ method: "equal", weight_source: "none" });
    const uit = chargeCallReadiness(
      invoer({ rule: r, units: [unit(U1, "A1", 0), unit(U2, "A2", 0)] }),
    );
    expect(codes(uit)).not.toContain("ALLOC_WEIGHT_MISSING");
  });

  it("GW5 — handmatig: een leeg veld telt als 0,00 en blokkeert dus niet", () => {
    // Exact wat `collectManualLines()` doet: leeg wordt 0 cent. Blokkeren zou
    // rood tonen op invoer die de applicatie daarna gewoon accepteert.
    const r = regel({ method: "manual", weight_source: "charge_call_lines" });
    const uit = chargeCallReadiness(
      invoer({ rule: r, manualAmounts: { [U1]: "1200,00", [U2]: "" } }),
    );
    expect(uit.blockers).toEqual([]);
    expect(uit.clear).toBe(true);
  });

  it("GW6 — handmatig: een som die niet klopt is niet groen", () => {
    const r = regel({ method: "manual", weight_source: "charge_call_lines" });
    // 600 + 400 is 1000, de oproep is 1200. m20 weigert dat hoe dan ook met
    // ALLOC_MANUAL_SUM, dus het scherm mag hier niet groen zeggen.
    const uit = chargeCallReadiness(
      invoer({ rule: r, manualAmounts: { [U1]: "600", [U2]: "400" } }),
    );
    expect(codes(uit)).toContain("ALLOC_MANUAL_SUM");
    expect(uit.clear).toBe(false);
  });

  it("GW7 — handmatig: geen enkel veld ingevuld blokkeert met ALLOC_MANUAL_MISSING", () => {
    // De actie stuurt dan `p_manual_lines = null`; m20 weigert dat hard.
    const r = regel({ method: "manual", weight_source: "charge_call_lines" });
    const uit = chargeCallReadiness(invoer({ rule: r, manualAmounts: {} }));
    expect(codes(uit)).toContain("ALLOC_MANUAL_MISSING");
    expect(uit.clear).toBe(false);
  });

  it("GW8 — handmatig: een niet-numeriek bedrag blokkeert, met het lot erbij", () => {
    const r = regel({ method: "manual", weight_source: "charge_call_lines" });
    const uit = chargeCallReadiness(
      invoer({ rule: r, manualAmounts: { [U1]: "600", [U2]: "abc" } }),
    );
    const blok = uit.blockers.find((b) => b.code === "FORM_MANUAL_INVALID");
    expect(blok && "units" in blok ? blok.units.map((u) => u.label) : []).toEqual(["A2"]);
    expect(uit.clear).toBe(false);
  });

  it("GW9 — handmatig: een negatief bedrag blokkeert", () => {
    const r = regel({ method: "manual", weight_source: "charge_call_lines" });
    const uit = chargeCallReadiness(
      invoer({ rule: r, manualAmounts: { [U1]: "1400", [U2]: "-200" } }),
    );
    const blok = uit.blockers.find((b) => b.code === "ALLOC_MANUAL_NEGATIVE");
    expect(blok && "units" in blok ? blok.units.map((u) => u.label) : []).toEqual(["A2"]);
    expect(uit.clear).toBe(false);
  });

  it("GW10 — handmatig: nul is toegestaan, want de database staat het toe", () => {
    // m20 weigert alleen `amount_cents < 0`; nul is een geldige regel.
    const r = regel({ method: "manual", weight_source: "charge_call_lines" });
    const uit = chargeCallReadiness(
      invoer({ rule: r, manualAmounts: { [U1]: "1200", [U2]: "0" } }),
    );
    expect(uit.blockers).toEqual([]);
    expect(uit.clear).toBe(true);
  });
});

// ── Oproepdatum binnen het boekjaar (m31) ───────────────────────────────────

/**
 * BJ — de app spiegelt de m31-invariant.
 *
 * m31 maakt `start_date <= call_date <= end_date` een database-invariant met
 * INCLUSIEVE grenzen, afgedwongen door `trig_01_cc_date_in_fy`. Een groene
 * controle op een datum daarbuiten zou een belofte zijn die de database op
 * datzelfde moment al breekt.
 */
describe("BJ — oproepdatum binnen de periode van het boekjaar", () => {
  /** Boekjaar met een niet-kalenderperiode, zodat het jaartal niets verraadt. */
  const PERIODE = { year: 2026, status: "open" as const, startDate: "2026-04-01", endDate: "2026-09-30" };

  function metPeriode(over: Partial<ReadinessInput> = {}) {
    return invoer({ fiscalYear: PERIODE, ...over });
  }

  it("BJ1 — een datum midden in het boekjaar is groen", () => {
    const uit = chargeCallReadiness(metPeriode({ callDate: "2026-06-15" }));
    expect(codes(uit)).not.toContain("FORM_CALL_DATE_OUTSIDE_FY");
    expect(uit.clear).toBe(true);
  });

  it("BJ2 — exact op start_date is toegestaan, de ondergrens is inclusief", () => {
    const uit = chargeCallReadiness(metPeriode({ callDate: "2026-04-01" }));
    expect(codes(uit)).not.toContain("FORM_CALL_DATE_OUTSIDE_FY");
    expect(uit.clear).toBe(true);
  });

  it("BJ3 — exact op end_date is toegestaan, de bovengrens is inclusief", () => {
    const uit = chargeCallReadiness(metPeriode({ callDate: "2026-09-30" }));
    expect(codes(uit)).not.toContain("FORM_CALL_DATE_OUTSIDE_FY");
    expect(uit.clear).toBe(true);
  });

  it("BJ4 — een dag vóór start_date blokkeert", () => {
    const uit = chargeCallReadiness(metPeriode({ callDate: "2026-03-31" }));
    expect(codes(uit)).toContain("FORM_CALL_DATE_OUTSIDE_FY");
    expect(uit.clear).toBe(false);
  });

  it("BJ5 — een dag ná end_date blokkeert", () => {
    const uit = chargeCallReadiness(metPeriode({ callDate: "2026-10-01" }));
    expect(codes(uit)).toContain("FORM_CALL_DATE_OUTSIDE_FY");
    expect(uit.clear).toBe(false);
  });

  it("BJ6 — extreem oude en extreem toekomstige datums blokkeren", () => {
    for (const datum of ["1999-01-01", "2099-12-31"]) {
      const uit = chargeCallReadiness(metPeriode({ callDate: datum }));
      expect(codes(uit), datum).toContain("FORM_CALL_DATE_OUTSIDE_FY");
    }
  });

  it("BJ7 — de eigendomscontrole draait NIET op een datum buiten het boekjaar", () => {
    // Zonder deze poort zou elk lot als eigenaarloos worden gemeld, want geen
    // enkele eigendomsperiode dekt 1999. Dat is de verkeerde oorzaak tonen.
    const uit = chargeCallReadiness(metPeriode({ callDate: "1999-01-01" }));
    expect(codes(uit)).toContain("FORM_CALL_DATE_OUTSIDE_FY");
    expect(codes(uit)).not.toContain("ALLOC_NO_OWNER");
    expect(codes(uit)).not.toContain("ALLOC_AMBIGUOUS_OWNER");
  });

  it("BJ8 — de melding draagt de grenzen, niet de technische code", () => {
    const uit = chargeCallReadiness(metPeriode({ callDate: "2026-10-01" }));
    const blok = uit.blockers.find((b) => b.code === "FORM_CALL_DATE_OUTSIDE_FY");
    expect(blok && "startDate" in blok ? blok.startDate : null).toBe("2026-04-01");
    expect(blok && "endDate" in blok ? blok.endDate : null).toBe("2026-09-30");
    expect(blockerKey(blok!)).toBe("callDateOutsideFy");
  });

  it("BJ9 — een ONGELDIG datumformaat meldt dat, niet de boekjaargrens", () => {
    // Twee verschillende oorzaken mogen niet op één hoop; de gebruiker moet
    // weten of de datum onleesbaar is of gewoon buiten de periode valt.
    for (const datum of ["", "2026-99-99", "31-03-2026"]) {
      const uit = chargeCallReadiness(metPeriode({ callDate: datum }));
      expect(codes(uit), datum).toContain("FORM_CALL_DATE_INVALID");
      expect(codes(uit), datum).not.toContain("FORM_CALL_DATE_OUTSIDE_FY");
      expect(codes(uit), datum).not.toContain("ALLOC_NO_OWNER");
    }
  });

  it("BJ10 — de databasecode ALLOC_CALL_DATE_OUTSIDE_FY krijgt dezelfde melding", () => {
    // Een race of een omzeiling levert de trigger-exceptie op; die moet bij de
    // gebruiker als dezelfde begrijpelijke tekst landen, niet als "generic".
    expect(
      chargeErrorKey("ALLOC_CALL_DATE_OUTSIDE_FY: oproepdatum valt buiten de periode van het boekjaar"),
    ).toBe("callDateOutsideFy");
    expect(chargeErrorCode("ALLOC_CALL_DATE_OUTSIDE_FY: x")).toBe("ALLOC_CALL_DATE_OUTSIDE_FY");
    expect(mappedChargeErrorCodes()).toContain("ALLOC_CALL_DATE_OUTSIDE_FY");
  });

  it("BJ11 — de vervaldatumvolgorde blijft los van de boekjaargrens werken", () => {
    // Een oproepdatum buiten het boekjaar mag de volgordefout niet verbergen.
    const uit = chargeCallReadiness(
      metPeriode({ callDate: "2026-10-01", dueDate: "2026-09-01" }),
    );
    expect(codes(uit)).toContain("FORM_CALL_DATE_OUTSIDE_FY");
    expect(codes(uit)).toContain("FORM_DUE_BEFORE_CALL");
  });

  it("BJ12 — de melding bestaat in FR, NL en AR en noemt geen tabel of code", () => {
    for (const [naam, berichten] of Object.entries({ fr, nl, ar })) {
      const tekst = (berichten as { charges: { errors: Record<string, string> } })
        .charges.errors.callDateOutsideFy;
      expect(tekst, `${naam} mist callDateOutsideFy`).toBeTruthy();
      expect(tekst, naam).toContain("{start}");
      expect(tekst, naam).toContain("{end}");
      expect(tekst, naam).not.toContain("ALLOC_");
      expect(tekst, naam).not.toContain("charge_calls");
      expect(tekst, naam).not.toContain("fiscal_years");
    }
  });
});

// ── Handmatige som (ALLOC_MANUAL_SUM) ───────────────────────────────────────

describe("MS — de handmatige som tegenover het oproepbedrag", () => {
  const handmatig = regel({ method: "manual", weight_source: "charge_call_lines" });

  /** Wat `collectManualLines()` uit het formulier zou halen, met dezelfde parser. */
  function alsActie(bedragen: Record<string, string>): number | null {
    let som = 0;
    let ingevuld = false;
    for (const ruw of Object.values(bedragen)) {
      const gelezen = parseManualAmount(ruw);
      if (!gelezen.ok) return null;
      if (gelezen.filled) ingevuld = true;
      som += gelezen.cents;
    }
    return ingevuld ? som : null;
  }

  it("MS1 — een kloppende som is groen", () => {
    const uit = chargeCallReadiness(
      invoer({ rule: handmatig, manualAmounts: { [U1]: "600", [U2]: "600" } }),
    );
    expect(uit.blockers).toEqual([]);
    expect(uit.clear).toBe(true);
  });

  it("MS2 — een som die te laag is, is niet groen", () => {
    const uit = chargeCallReadiness(
      invoer({ rule: handmatig, manualAmounts: { [U1]: "600", [U2]: "400" } }),
    );
    expect(codes(uit)).toContain("ALLOC_MANUAL_SUM");
    expect(uit.clear).toBe(false);
  });

  it("MS3 — een som die te hoog is, is evenmin groen", () => {
    const uit = chargeCallReadiness(
      invoer({ rule: handmatig, manualAmounts: { [U1]: "700", [U2]: "600" } }),
    );
    expect(codes(uit)).toContain("ALLOC_MANUAL_SUM");
    expect(uit.clear).toBe(false);
  });

  it("MS4 — komma en punt zijn hetzelfde bedrag, in beide richtingen", () => {
    const metKomma = chargeCallReadiness(
      invoer({
        rule: handmatig,
        totalAmount: "1200,00",
        manualAmounts: { [U1]: "600,50", [U2]: "599,50" },
      }),
    );
    expect(metKomma.blockers).toEqual([]);

    const metPunt = chargeCallReadiness(
      invoer({
        rule: handmatig,
        totalAmount: "1200.00",
        manualAmounts: { [U1]: "600.50", [U2]: "599.50" },
      }),
    );
    expect(metPunt.blockers).toEqual([]);

    // En een cent ernaast is in beide notaties rood.
    const ernaast = chargeCallReadiness(
      invoer({
        rule: handmatig,
        totalAmount: "1200,00",
        manualAmounts: { [U1]: "600,51", [U2]: "599,50" },
      }),
    );
    expect(codes(ernaast)).toContain("ALLOC_MANUAL_SUM");
  });

  it("MS5 — de centen zijn exact die van de Server Action, niet een eigen afronding", () => {
    // Drie bedragen die in drijvende komma NIET netjes optellen (0.1+0.2 is
    // 0.30000000000000004). In hele centen doen ze dat wél, en de controle
    // gebruikt letterlijk dezelfde parser als `collectManualLines()`.
    const bedragen = { [U1]: "0.10", [U2]: "0.20" };
    expect(alsActie(bedragen)).toBe(30);

    const uit = chargeCallReadiness(
      invoer({ rule: handmatig, totalAmount: "0.30", manualAmounts: bedragen }),
    );
    expect(uit.blockers).toEqual([]);
    expect(uit.clear).toBe(true);
  });

  it("MS6 — een leeg veld telt aan beide kanten als 0,00", () => {
    const bedragen = { [U1]: "1200,00", [U2]: "" };
    expect(alsActie(bedragen)).toBe(120000);

    const uit = chargeCallReadiness(
      invoer({ rule: handmatig, manualAmounts: bedragen }),
    );
    expect(uit.blockers).toEqual([]);
    expect(uit.clear).toBe(true);

    // En met dat lege veld erbij klopt de som dus níét meer als de rest te laag is.
    const teLaag = chargeCallReadiness(
      invoer({ rule: handmatig, manualAmounts: { [U1]: "1100,00", [U2]: "" } }),
    );
    expect(codes(teLaag)).toContain("ALLOC_MANUAL_SUM");
  });

  it("MS7 — de som verdringt de hardere fouten niet", () => {
    // Bij een niet-numeriek of negatief bedrag is de som betekenisloos; dan
    // hoort die oorzaak te blijven staan en niet te worden overschaduwd.
    const nietNumeriek = chargeCallReadiness(
      invoer({ rule: handmatig, manualAmounts: { [U1]: "600", [U2]: "abc" } }),
    );
    expect(codes(nietNumeriek)).toContain("FORM_MANUAL_INVALID");
    expect(codes(nietNumeriek)).not.toContain("ALLOC_MANUAL_SUM");

    const negatief = chargeCallReadiness(
      invoer({ rule: handmatig, manualAmounts: { [U1]: "1400", [U2]: "-200" } }),
    );
    expect(codes(negatief)).toContain("ALLOC_MANUAL_NEGATIVE");
    expect(codes(negatief)).not.toContain("ALLOC_MANUAL_SUM");
  });

  it("MS8 — zonder geldig oproepbedrag wordt er geen som beoordeeld", () => {
    // Het bedrag zelf is dan al de blokkade; een tweede rode melding over een
    // som tegen een onbekend totaal zou de oorzaak alleen maar vertroebelen.
    const uit = chargeCallReadiness(
      invoer({
        rule: handmatig,
        totalAmount: "abc",
        manualAmounts: { [U1]: "600", [U2]: "400" },
      }),
    );
    expect(codes(uit)).toContain("FORM_AMOUNT_INVALID");
    expect(codes(uit)).not.toContain("ALLOC_MANUAL_SUM");
  });

  it("MS9 — de som telt alleen lots binnen de regelscope", () => {
    // Een bedrag bij een uitgesloten lot gaat ook niet mee in `manual_`-lijnen
    // die de actie stuurt, want dat veld staat niet in het rooster.
    const r = regel({
      method: "manual",
      weight_source: "charge_call_lines",
      scope: "selected_units",
    });
    const uit = chargeCallReadiness(
      invoer({
        rule: r,
        units: [unit(U1, "A1", 60), unit(U2, "A2", 40)],
        ruleUnits: [{ rule_id: REGEL, unit_id: U1 }],
        manualAmounts: { [U1]: "1200", [U2]: "999" },
      }),
    );
    expect(uit.participants.map((u) => u.label)).toEqual(["A1"]);
    expect(codes(uit)).not.toContain("ALLOC_MANUAL_SUM");
  });

  it("MS10 — de som is één optelling, geen verdeling", () => {
    // De uitkomst draagt nergens een bedrag per lot: de blokkade zegt alleen
    // DAT de som niet klopt, nooit wat elk lot dan zou moeten betalen.
    const uit = chargeCallReadiness(
      invoer({ rule: handmatig, manualAmounts: { [U1]: "600", [U2]: "400" } }),
    );
    const blok = uit.blockers.find((b) => b.code === "ALLOC_MANUAL_SUM");
    expect(blok).toEqual({ code: "ALLOC_MANUAL_SUM" });
    expect(JSON.stringify(uit)).not.toMatch(/cent/i);
  });

  it("MS11 — de Server Action en de controle delen letterlijk dezelfde parser", () => {
    const actie = zonderCommentaar(
      readFileSync(
        join(
          REPO,
          "src",
          "app",
          "[locale]",
          "(app)",
          "buildings",
          "[id]",
          "boekjaren",
          "actions.ts",
        ),
        "utf8",
      ),
    );
    // De actie importeert de parser uit de gedeelde module ...
    expect(actie).toMatch(/import\s*\{[^}]*parseManualAmount[^}]*\}\s*from\s*"@\/lib\/charges"/);
    // ... en leest geen enkel handmatig bedrag nog zelf.
    expect(actie).not.toMatch(/Number\(String\(value\)/);
    expect(actie).not.toMatch(/parseFloat\(String\(value\)/);
    const manueleRegels = actie
      .split("\n")
      .filter((r) => r.includes("amount_cents"))
      .join("\n");
    expect(manueleRegels).toMatch(/gelezen\.cents/);
    expect(manueleRegels).not.toMatch(/\*\s*100/);
  });
});

// ── Percentagesom (ALLOC_PCT_SUM) ───────────────────────────────────────────

describe("PC — percentages tellen op tot exact 100", () => {
  const pctRegel = regel({ method: "percentage", weight_source: "rule_weights" });

  function metGewichten(gewichten: RuleWeightRow[], over: Partial<ReadinessInput> = {}) {
    return chargeCallReadiness(invoer({ rule: pctRegel, ruleWeights: gewichten, ...over }));
  }

  it("PC1 — 60 + 40 geeft geen percentageblokkade", () => {
    const uit = metGewichten([
      { rule_id: REGEL, unit_id: U1, weight: 60 },
      { rule_id: REGEL, unit_id: U2, weight: 40 },
    ]);
    expect(codes(uit)).not.toContain("ALLOC_PCT_SUM");
    expect(uit.clear).toBe(true);
  });

  it("PC2 — 60 + 30 blokkeert met ALLOC_PCT_SUM en is niet groen", () => {
    const uit = metGewichten([
      { rule_id: REGEL, unit_id: U1, weight: 60 },
      { rule_id: REGEL, unit_id: U2, weight: 30 },
    ]);
    const blok = uit.blockers.find((b) => b.code === "ALLOC_PCT_SUM");
    expect(blok).toBeDefined();
    expect(blok && "ppm" in blok ? blok.ppm : null).toBe(90_000_000);
    expect(uit.clear).toBe(false);
  });

  it("PC3 — het gewicht van een UITGESLOTEN lot telt niet mee", () => {
    // U3 is via allocation_rule_units uitgesloten bij whole_building, maar
    // draagt nog wel een gewichtrij. Die mag de som niet vervuilen.
    const uit = metGewichten(
      [
        { rule_id: REGEL, unit_id: U1, weight: 60 },
        { rule_id: REGEL, unit_id: U2, weight: 40 },
        { rule_id: REGEL, unit_id: U3, weight: 25 },
      ],
      {
        units: [unit(U1, "A1", 60), unit(U2, "A2", 40), unit(U3, "B1", 25)],
        ruleUnits: [{ rule_id: REGEL, unit_id: U3 }],
        ownership: [bezit({ unit_id: U1 }), bezit({ unit_id: U2 })],
      },
    );
    expect(codes(uit)).not.toContain("ALLOC_PCT_SUM");
    expect(uit.participantCount).toBe(2);
    expect(uit.clear).toBe(true);
  });

  it("PC4 — gewichten van een ANDERE regel tellen niet mee", () => {
    const uit = metGewichten([
      { rule_id: REGEL, unit_id: U1, weight: 60 },
      { rule_id: REGEL, unit_id: U2, weight: 40 },
      { rule_id: "andere-regel", unit_id: U1, weight: 500 },
    ]);
    expect(codes(uit)).not.toContain("ALLOC_PCT_SUM");
  });

  it("PC5 — stringwaarden uit PostgREST worden correct gelezen", () => {
    const uit = metGewichten([
      { rule_id: REGEL, unit_id: U1, weight: "60.000000" },
      { rule_id: REGEL, unit_id: U2, weight: "40.000000" },
    ]);
    expect(codes(uit)).not.toContain("ALLOC_PCT_SUM");
    expect(uit.clear).toBe(true);
  });

  it("PC6 — de som gebruikt de precisie van m20: round(weight * 1000000) per rij", () => {
    // Drie keer 33,333333 is 99,999999 procent en dus NIET geldig; de database
    // rekent in miljoensten en vergelijkt met 100000000.
    const uit = metGewichten(
      [
        { rule_id: REGEL, unit_id: U1, weight: "33.333333" },
        { rule_id: REGEL, unit_id: U2, weight: "33.333333" },
        { rule_id: REGEL, unit_id: U3, weight: "33.333333" },
      ],
      {
        units: [unit(U1, "A1", 1), unit(U2, "A2", 1), unit(U3, "B1", 1)],
        ownership: [bezit({ unit_id: U1 }), bezit({ unit_id: U2 }), bezit({ unit_id: U3 })],
      },
    );
    const blok = uit.blockers.find((b) => b.code === "ALLOC_PCT_SUM");
    expect(blok && "ppm" in blok ? blok.ppm : null).toBe(99_999_999);

    expect(
      percentageTotalPpm(
        pctRegel,
        [unit(U1, "A1", 1), unit(U2, "A2", 1)],
        [
          { rule_id: REGEL, unit_id: U1, weight: "0.0000004" },
          { rule_id: REGEL, unit_id: U2, weight: "0.0000004" },
        ],
      ),
      // Per rij afgerond naar nul, niet als som naar 1 miljoenste.
    ).toBe(0);
  });

  it("PC7 — een ontbrekende gewichtrij blijft ALLOC_WEIGHT_MISSING", () => {
    const uit = metGewichten([{ rule_id: REGEL, unit_id: U1, weight: 100 }]);
    expect(codes(uit)).toContain("ALLOC_WEIGHT_MISSING");
    // Zonder volledige gewichten zegt de som niets; geen dubbele melding.
    expect(codes(uit)).not.toContain("ALLOC_PCT_SUM");
    expect(uit.clear).toBe(false);
  });

  it("PC8 — een tantièmeregel op rule_weights kent géén percentagecontrole", () => {
    const uit = chargeCallReadiness(
      invoer({
        rule: regel({ method: "tantieme", weight_source: "rule_weights" }),
        ruleWeights: [
          { rule_id: REGEL, unit_id: U1, weight: 60 },
          { rule_id: REGEL, unit_id: U2, weight: 30 },
        ],
      }),
    );
    expect(codes(uit)).not.toContain("ALLOC_PCT_SUM");
  });
});

// ── Vooraf kenbare formulierfouten ──────────────────────────────────────────

describe("FV — formuliervalidatie vóór de controle groen wordt", () => {
  it("FV1 — een leeg totaalbedrag is niet groen", () => {
    const uit = chargeCallReadiness(invoer({ totalAmount: "" }));
    expect(codes(uit)).toContain("FORM_AMOUNT_INVALID");
    expect(uit.clear).toBe(false);
  });

  it("FV2 — 'abc' als totaalbedrag is niet groen", () => {
    expect(codes(chargeCallReadiness(invoer({ totalAmount: "abc" })))).toContain(
      "FORM_AMOUNT_INVALID",
    );
  });

  it("FV3 — nul of negatief is niet groen", () => {
    for (const bedrag of ["0", "0,00", "-1", "-0.01"]) {
      expect(codes(chargeCallReadiness(invoer({ totalAmount: bedrag }))), bedrag).toContain(
        "FORM_AMOUNT_INVALID",
      );
    }
  });

  it("FV4 — punt én komma als decimaalteken zijn geldig, net als in validation.ts", () => {
    for (const bedrag of ["1200.00", "1200,00", " 1 200,50 ", "0.01"]) {
      const uit = chargeCallReadiness(invoer({ totalAmount: bedrag }));
      expect(codes(uit), bedrag).not.toContain("FORM_AMOUNT_INVALID");
      expect(uit.clear, bedrag).toBe(true);
    }
  });

  it("FV5 — een onrealistisch hoog bedrag is niet groen", () => {
    expect(codes(chargeCallReadiness(invoer({ totalAmount: "1000000001" })))).toContain(
      "FORM_AMOUNT_INVALID",
    );
  });

  it("FV6 — een vervaldatum vóór de oproepdatum is niet groen", () => {
    const uit = chargeCallReadiness(
      invoer({ callDate: "2026-06-30", dueDate: "2026-06-29" }),
    );
    expect(codes(uit)).toContain("FORM_DUE_BEFORE_CALL");
    expect(uit.clear).toBe(false);
  });

  it("FV7 — een vervaldatum gelijk aan de oproepdatum is toegestaan", () => {
    const uit = chargeCallReadiness(
      invoer({ callDate: "2026-06-30", dueDate: "2026-06-30" }),
    );
    expect(codes(uit)).not.toContain("FORM_DUE_BEFORE_CALL");
    expect(uit.clear).toBe(true);
  });

  it("FV8 — een lege vervaldatum is toegestaan", () => {
    const uit = chargeCallReadiness(invoer({ dueDate: "" }));
    expect(codes(uit)).not.toContain("FORM_DUE_BEFORE_CALL");
    expect(uit.clear).toBe(true);
  });

  it("FV11 — een bedrag onder een halve cent is niet groen", () => {
    // `validation.ts` rondt NA de `> 0`-controle af op hele centen, dus 0,004
    // komt als 0,00 bij de RPC aan en m20 weigert met ALLOC_AMOUNT_INVALID.
    for (const bedrag of ["0.001", "0.004", "0.0049999"]) {
      const uit = chargeCallReadiness(invoer({ totalAmount: bedrag }));
      expect(codes(uit), bedrag).toContain("FORM_AMOUNT_INVALID");
      expect(uit.clear, bedrag).toBe(false);
    }
    // Precies een halve cent rondt naar 0,01 en is dus wél geldig.
    expect(codes(chargeCallReadiness(invoer({ totalAmount: "0.005" })))).not.toContain(
      "FORM_AMOUNT_INVALID",
    );
  });

  it("FV12 — een lege of onvolledige oproepdatum is niet groen", () => {
    for (const datum of ["", "2026-06", "30-06-2026", "geen datum"]) {
      const uit = chargeCallReadiness(invoer({ callDate: datum }));
      expect(codes(uit), datum).toContain("FORM_CALL_DATE_INVALID");
      expect(uit.clear, datum).toBe(false);
    }
  });

  it("FV13 — bij een ongeldige oproepdatum wordt niet ten onrechte 'geen eigenaar' gemeld", () => {
    // Zonder deze poort zou `start_date <= ""` voor elk lot falen en zou elk
    // lot als eigenaarloos worden aangemerkt — de verkeerde oorzaak.
    const uit = chargeCallReadiness(invoer({ callDate: "" }));
    expect(codes(uit)).toContain("FORM_CALL_DATE_INVALID");
    expect(codes(uit)).not.toContain("ALLOC_NO_OWNER");
  });

  it("FV14 — een lege oproepdatum verbergt geen datumvolgordefout", () => {
    // `"2026-06-29" < ""` is false; zonder de datumpoort zou dit stil slagen.
    const uit = chargeCallReadiness(invoer({ callDate: "", dueDate: "2026-06-29" }));
    expect(uit.clear).toBe(false);
    expect(codes(uit)).toContain("FORM_CALL_DATE_INVALID");
  });

  it("FV9 — parseFormAmount spiegelt parseFloat, niet een strengere parser", () => {
    // validation.ts gebruikt parseFloat; die is mild. Strenger zijn zou rood
    // tonen op invoer die de Server Action daarna accepteert. De uitkomst is
    // in HELE CENTEN, precies het getal dat de RPC krijgt.
    expect(parseFormAmount("12abc")).toEqual({ ok: true, cents: 1200 });
    expect(parseFormAmount("1200,00")).toEqual({ ok: true, cents: 120000 });
    expect(parseFormAmount("abc").ok).toBe(false);
    expect(parseFormAmount("").ok).toBe(false);
    expect(parseFormAmount("   ").ok).toBe(false);
  });

  it("FV10 — parseManualAmount spiegelt Number(), inclusief leeg = 0", () => {
    // collectManualLines gebruikt Number(), niet parseFloat.
    expect(parseManualAmount("")).toEqual({ ok: true, cents: 0, filled: false });
    expect(parseManualAmount("600,50")).toEqual({ ok: true, cents: 60050, filled: true });
    expect(parseManualAmount("12abc").ok).toBe(false);
    expect(parseManualAmount("-5")).toEqual({ ok: true, cents: -500, filled: true });
  });

  it("FV15 — een onbestaande datum is niet groen, precies zoals isoDate oordeelt", () => {
    // `isoDate` in validation.ts is patroon ÉN `Date.parse` zonder NaN.
    // "2026-99-99" komt door het patroon maar geeft NaN; zonder de tweede
    // voorwaarde zou dit scherm groen zeggen en zou de server alsnog weigeren.
    const alsOproep = chargeCallReadiness(invoer({ callDate: "2026-99-99" }));
    expect(codes(alsOproep)).toContain("FORM_CALL_DATE_INVALID");
    expect(alsOproep.clear).toBe(false);

    const alsVerval = chargeCallReadiness(
      invoer({ callDate: "2026-06-30", dueDate: "2026-99-99" }),
    );
    expect(codes(alsVerval)).toContain("FORM_DUE_DATE_INVALID");
    expect(alsVerval.clear).toBe(false);
  });

  it("FV16 — een ongeldige datum blokkeert, maar bedenkt geen tweede oorzaak", () => {
    // Bij een onbestaande oproepdatum is de eigendom op die datum niet te
    // beoordelen; dan hoort er GEEN 'geen eigenaar' bij te staan, en ook geen
    // volgordefout tegen een datum die niet bestaat.
    const uit = chargeCallReadiness(
      invoer({ callDate: "2026-99-99", dueDate: "2026-01-01" }),
    );
    expect(codes(uit)).toContain("FORM_CALL_DATE_INVALID");
    expect(codes(uit)).not.toContain("ALLOC_NO_OWNER");
    expect(codes(uit)).not.toContain("FORM_DUE_BEFORE_CALL");
  });

  it("FV17 — een geldige datum die de server ook accepteert is groen", () => {
    // 2026-02-30 slaagt voor patroon én Date.parse (JavaScript rolt door naar
    // 2 maart) — net als op de server. Strenger zijn dan de server is óók fout.
    for (const datum of ["2026-06-30", "2026-01-01", "2026-12-31", "2026-02-30"]) {
      const uit = chargeCallReadiness(invoer({ callDate: datum }));
      expect(codes(uit), datum).not.toContain("FORM_CALL_DATE_INVALID");
    }
  });
});

// ── 11. Controlewaarde en de vastgelegde afwijking ──────────────────────────

describe("CT — controletotaal (F09)", () => {
  it("CT1 — afwijkende som van tantièmes blokkeert", () => {
    const uit = chargeCallReadiness(invoer({ declaredTantiemes: 120 }));
    const blok = uit.blockers.find((b) => b.code === "ALLOC_CONTROL_TOTAL");
    expect(blok).toBeDefined();
    expect(blok && "participating" in blok ? blok.participating : null).toBe(100);
    expect(blok && "declared" in blok ? blok.declared : null).toBe(120);
  });

  it("CT2 — een vastgelegde afwijking binnen haar vervalboekjaar blokkeert NIET", () => {
    const uit = chargeCallReadiness(
      invoer({
        rule: regel({ partial_denominator_until_year: 2026 }),
        declaredTantiemes: 120,
        fiscalYear: { year: 2026, status: "open", startDate: "2026-01-01", endDate: "2026-12-31" },
      }),
    );
    expect(codes(uit)).not.toContain("ALLOC_CONTROL_TOTAL");
    expect(uit.notices.map((n) => n.code)).toContain("PARTIAL_DENOMINATOR");
    expect(uit.clear).toBe(true);
  });

  it("CT3 — ná het vervalboekjaar blokkeert dezelfde afwijking wél", () => {
    const uit = chargeCallReadiness(
      invoer({
        rule: regel({ partial_denominator_until_year: 2025 }),
        declaredTantiemes: 120,
        fiscalYear: { year: 2026, status: "open", startDate: "2026-01-01", endDate: "2026-12-31" },
      }),
    );
    expect(codes(uit)).toContain("ALLOC_CONTROL_TOTAL");
    expect(uit.clear).toBe(false);
  });

  it("CT4 — F09 geldt UITSLUITEND voor tantieme/whole_building/unit_tantiemes", () => {
    // Zelfde afwijkende som, maar een blokscope: geen controletotaal.
    const uit = chargeCallReadiness(
      invoer({
        rule: regel({ scope: "block", scope_block_id: BLOK_A }),
        units: [unit(U1, "A1", 60, BLOK_A), unit(U2, "A2", 40, null)],
        declaredTantiemes: 100,
        ownership: [bezit({ unit_id: U1 })],
      }),
    );
    expect(codes(uit)).not.toContain("ALLOC_CONTROL_TOTAL");
  });

  it("CT5 — percentage-regels kennen geen F09", () => {
    const uit = chargeCallReadiness(
      invoer({
        rule: regel({ method: "percentage", weight_source: "rule_weights" }),
        ruleWeights: [
          { rule_id: REGEL, unit_id: U1, weight: 60 },
          { rule_id: REGEL, unit_id: U2, weight: 40 },
        ],
        declaredTantiemes: 999,
      }),
    );
    expect(codes(uit)).not.toContain("ALLOC_CONTROL_TOTAL");
  });
});

// ── Eigendomsblokkades binnen de volledige controle ─────────────────────────

describe("CR — controle vóór aanmaken, samengesteld", () => {
  it("CR1 — een lot zonder eigenaar op de oproepdatum blokkeert, met labels", () => {
    const uit = chargeCallReadiness(invoer({ ownership: [bezit({ unit_id: U1 })] }));
    const blok = uit.blockers.find((b) => b.code === "ALLOC_NO_OWNER");
    expect(blok && "units" in blok ? blok.units.map((u) => u.label) : []).toEqual(["A2"]);
    expect(uit.clear).toBe(false);
  });

  it("CR2 — een ambigu lot blokkeert apart van een lot zonder eigenaar", () => {
    const uit = chargeCallReadiness(
      invoer({
        units: [unit(U1, "A1", 50), unit(U2, "A2", 30), unit(U3, "B1", 20)],
        declaredTantiemes: 100,
        ownership: [
          bezit({ unit_id: U1 }),
          bezit({ unit_id: U2, owner_id: O1, is_primary_debtor: false }),
          bezit({ unit_id: U2, owner_id: O2, is_primary_debtor: false }),
        ],
      }),
    );
    expect(codes(uit)).toEqual(
      expect.arrayContaining(["ALLOC_NO_OWNER", "ALLOC_AMBIGUOUS_OWNER"]),
    );
  });

  it("CR3 — een volledig gezonde situatie levert nul blokkades", () => {
    const uit = chargeCallReadiness(invoer());
    expect(uit.blockers).toEqual([]);
    expect(uit.notices).toEqual([]);
    expect(uit.clear).toBe(true);
    expect(uit.participantCount).toBe(2);
  });

  it("CR4 — een gesloten boekjaar blokkeert", () => {
    const uit = chargeCallReadiness(invoer({ fiscalYear: { year: 2026, status: "closed", startDate: "2026-01-01", endDate: "2026-12-31" } }));
    expect(codes(uit)).toContain("ALLOC_FY_CLOSED");
  });

  it("CR5 — een niet-actieve regel blokkeert", () => {
    const uit = chargeCallReadiness(invoer({ rule: regel({ status: "draft" }) }));
    expect(codes(uit)).toContain("ALLOC_RULE_INACTIVE");
  });

  it("CR6 — een regel van een ANDER gebouw blokkeert en stopt de controle", () => {
    const uit = chargeCallReadiness(invoer({ rule: regel({ building_id: "ander-gebouw" }) }));
    expect(codes(uit)).toEqual(["ALLOC_RULE_WRONG_BUILDING"]);
    expect(uit.participantCount).toBe(0);
    expect(uit.clear).toBe(false);
  });

  it("CR7 — de oproepdatum verschuift de eigenaarsbepaling", () => {
    const rijen = [
      bezit({ unit_id: U1, owner_id: O1, start_date: "2026-01-01", end_date: "2026-05-31" }),
      bezit({ unit_id: U1, owner_id: O2, start_date: "2026-06-01" }),
      bezit({ unit_id: U2 }),
    ];
    const voor = chargeCallReadiness(invoer({ callDate: "2026-03-01", ownership: rijen }));
    const na = chargeCallReadiness(invoer({ callDate: "2026-09-01", ownership: rijen }));
    expect(voor.clear).toBe(true);
    expect(na.clear).toBe(true);
    expect(resolveOwnerOn(rijen.filter((r) => r.unit_id === U1), "2026-03-01")?.owner_id).toBe(O1);
    expect(resolveOwnerOn(rijen.filter((r) => r.unit_id === U1), "2026-09-01")?.owner_id).toBe(O2);
  });

  it("CR8 — een gat in de eigendomsketen blokkeert op de dag in het gat", () => {
    const rijen = [
      bezit({ unit_id: U1, owner_id: O1, start_date: "2026-01-01", end_date: "2026-05-31" }),
      bezit({ unit_id: U1, owner_id: O2, start_date: "2026-07-01" }),
      bezit({ unit_id: U2 }),
    ];
    const uit = chargeCallReadiness(invoer({ callDate: "2026-06-15", ownership: rijen }));
    const blok = uit.blockers.find((b) => b.code === "ALLOC_NO_OWNER");
    expect(blok && "units" in blok ? blok.units.map((u) => u.label) : []).toEqual(["A1"]);
  });
});

// ── 20. Geen centverdeling in TypeScript ────────────────────────────────────

describe("GV — geen verdeling in de applicatielaag", () => {
  it("GV1 — de controle geeft nergens een bedrag per lot terug", () => {
    const uit = chargeCallReadiness(invoer());
    const platgeslagen = JSON.stringify(uit);
    // De uitkomst draagt lots, codes en tantièmes — nooit een bedrag of cent.
    expect(platgeslagen).not.toMatch(/amount/i);
    expect(platgeslagen).not.toMatch(/cent/i);
    for (const deelnemer of uit.participants) {
      expect(Object.keys(deelnemer).sort()).toEqual(["id", "label"]);
    }
  });

  it("GV2 — charges.ts bevat geen restverdeling of centrekenkunde", () => {
    // Alleen de CODE, niet de toelichting: de commentaarblokken leggen juist uit
    // dat de largest-remainder verdeling in `fn_alloc_distribute` thuishoort, en
    // die uitleg hoort niet als overtreding te tellen.
    const code = zonderCommentaar(readFileSync(join(REPO, "src", "lib", "charges.ts"), "utf8"));
    expect(code).not.toMatch(/remainder/i);
    expect(code).not.toMatch(/amount_cents/);

    // Er wordt op precies DRIE plaatsen afgerond, en elke plaats moet één van
    // de toegestane vormen zijn:
    //
    //   * euro's naar hele centen, exact zoals `validation.ts` en
    //     `collectManualLines()` het doen — geen eigen regel, maar dezelfde;
    //   * een GEWICHT naar miljoensten, letterlijk `round(weight * 1000000)`
    //     uit m20.
    //
    // Elke andere afronding zou een tweede financiële waarheid zijn en moet
    // deze test laten omvallen.
    const TOEGESTAAN = [
      /Math\.round\(n\s*\*\s*100\)/,
      /Math\.round\(getal\(w\.weight\)\s*\*\s*1_000_000\)/,
    ];
    const afrondingen = code.split("\n").filter((r) => r.includes("Math.round("));
    expect(afrondingen).toHaveLength(3);
    for (const regel of afrondingen) {
      expect(TOEGESTAAN.some((vorm) => vorm.test(regel)), regel.trim()).toBe(true);
    }
    // Delen komt er niet in voor: dat is wat verdelen zou zijn.
    expect(code).not.toMatch(/Math\.floor\(/);
    expect(code).not.toMatch(/\/\s*(deelnemers|participants|units)\b/);
  });

  it("GV3 — de workflowcomponent berekent geen bedragen", () => {
    const code = zonderCommentaar(
      readFileSync(
        join(
          REPO,
          "src",
          "app",
          "[locale]",
          "(app)",
          "buildings",
          "[id]",
          "boekjaren",
          "[fy_id]",
          "ChargeCallWorkflow.tsx",
        ),
        "utf8",
      ),
    );
    expect(code).not.toMatch(/Math\.round/);
    expect(code).not.toMatch(/remainder/i);
    // De definitieve bedragen komen van de server, uit charge_call_lines.
    expect(code).not.toMatch(/amount_cents/);
  });

  it("GV4 — de pagina toont definitieve bedragen uit charge_allocations", () => {
    const bron = readFileSync(
      join(
        REPO,
        "src",
        "app",
        "[locale]",
        "(app)",
        "buildings",
        "[id]",
        "boekjaren",
        "[fy_id]",
        "page.tsx",
      ),
      "utf8",
    );
    // De autoritatieve uitkomst van de centverdeling staat in
    // `charge_allocations.amount_cents`. `charge_call_lines` wordt door m20
    // ALLEEN bij `method = 'manual'` gevuld (regel 307), dus die tabel als
    // bron zou voor tantieme, equal en percentage nul rijen opleveren.
    expect(bron).toContain("amount_cents");
    expect(bron).toContain("verdelingVan");
    expect(bron).not.toContain('.from("charge_call_lines")');

    // En er wordt nog steeds niets herberekend: het scherm deelt de
    // opgeslagen centen alleen door 100 om ze te tonen.
    expect(bron).not.toMatch(/remainder/i);
    expect(bron).not.toMatch(/Math\.(round|floor)\(/);
  });

  it("GV5 — de voorgevulde oproepdatum komt niet uit een UTC-slice", () => {
    const bron = readFileSync(
      join(
        REPO,
        "src",
        "app",
        "[locale]",
        "(app)",
        "buildings",
        "[id]",
        "boekjaren",
        "[fy_id]",
        "page.tsx",
      ),
      "utf8",
    );
    // `toISOString().slice(0, 10)` geeft de UTC-dag. Marokko loopt op UTC+1,
    // dus dat levert tussen 00:00 en 01:00 lokaal de dag ERVOOR - en op die
    // datum wordt de eigendom beoordeeld.
    expect(bron).not.toContain('toISOString().slice(0, 10)');
    // Sinds m31 klemt de default bovendien binnen de periode van het boekjaar.
    expect(bron).toContain("defaultCallDate");
  });
});

// ── 21-22. Foutcodes van de engine ──────────────────────────────────────────

describe("FE — foutcodes naar vertaalsleutels", () => {
  it("FE1 — de stabiele code wordt uit de enginemelding gehaald", () => {
    expect(chargeErrorCode("ALLOC_NO_OWNER: deze lots hebben geen eigenaar op 01-01-2026: A3")).toBe(
      "ALLOC_NO_OWNER",
    );
    expect(chargeErrorCode("zomaar een zin")).toBeNull();
    expect(chargeErrorCode(null)).toBeNull();
  });

  it("FE2 — elke bekende ALLOC_*-code levert een niet-generieke sleutel", () => {
    for (const code of mappedChargeErrorCodes()) {
      const sleutel = chargeErrorKey(`${code}: technische uitleg`);
      expect(sleutel, code).not.toBe("generic");
      expect(sleutel, code).toBeTruthy();
    }
  });

  it("FE3 — elke ALLOC_*-code uit m20 is gedekt", () => {
    const m20 = readFileSync(
      join(
        REPO,
        "supabase",
        "migrations",
        "20260825113354_m20_allocation_constraint_mode_hardening.sql",
      ),
      "utf8",
    );
    const gevonden = new Set(m20.match(/ALLOC_[A-Z_]+/g) ?? []);
    expect(gevonden.size).toBeGreaterThan(10);
    const gedekt = new Set(mappedChargeErrorCodes());
    const ontbrekend = [...gevonden].filter((c) => !gedekt.has(c));
    expect(ontbrekend, `niet gemapt: ${ontbrekend.join(", ")}`).toEqual([]);
  });

  it("FE4 — een onbekende of lege fout valt terug op de generieke sleutel", () => {
    expect(chargeErrorKey("ALLOC_IETS_NIEUWS: onbekend")).toBe("generic");
    expect(chargeErrorKey("permission denied for table charge_calls")).toBe("generic");
    expect(chargeErrorKey(null)).toBe("generic");
    expect(chargeErrorKey("")).toBe("generic");
  });

  it("FE5 — elke blokkade uit de controle heeft een vertaalsleutel", () => {
    const uit = chargeCallReadiness(
      invoer({ ownership: [], declaredTantiemes: 999, fiscalYear: { year: 2026, status: "closed", startDate: "2026-01-01", endDate: "2026-12-31" } }),
    );
    expect(uit.blockers.length).toBeGreaterThan(0);
    for (const b of uit.blockers) {
      expect(blockerKey(b), b.code).not.toBe("generic");
    }
  });
});

// ── 23-24. Vertalingen ──────────────────────────────────────────────────────

describe("VT — vertalingen FR/NL/AR", () => {
  const talen = { fr, nl, ar } as Record<string, Record<string, unknown>>;

  it("VT1 — elke foutsleutel bestaat in fr, nl en ar", () => {
    for (const [naam, berichten] of Object.entries(talen)) {
      const charges = berichten.charges as { errors?: Record<string, string> } | undefined;
      expect(charges?.errors, `charges.errors ontbreekt in ${naam}`).toBeDefined();
      for (const sleutel of [...chargeErrorKeys(), "generic", "manualInvalidNumber"]) {
        expect(charges?.errors?.[sleutel], `charges.errors.${sleutel} ontbreekt in ${naam}`)
          .toBeTruthy();
      }
    }
  });

  it("VT2 — de workflowteksten bestaan in alle drie de talen", () => {
    const paden: [string, string][] = [
      ["check", "title"],
      ["check", "run"],
      ["check", "clear"],
      ["check", "notGuarantee"],
      ["check", "blockersTitle"],
      ["confirm", "title"],
      ["confirm", "warning"],
      ["confirm", "checkbox"],
      ["confirm", "submit"],
      ["result", "title"],
      ["result", "source"],
      ["result", "unit"],
      ["result", "amount"],
    ];
    for (const [naam, berichten] of Object.entries(talen)) {
      const charges = berichten.charges as Record<string, Record<string, string>>;
      for (const [groep, sleutel] of paden) {
        expect(charges[groep]?.[sleutel], `charges.${groep}.${sleutel} ontbreekt in ${naam}`)
          .toBeTruthy();
      }
      for (const m of ["equal", "tantieme", "percentage", "manual"]) {
        expect(charges.methods?.[m], `charges.methods.${m} ontbreekt in ${naam}`).toBeTruthy();
      }
      for (const s of ["whole_building", "block", "selected_units"]) {
        expect(charges.scopes?.[s], `charges.scopes.${s} ontbreekt in ${naam}`).toBeTruthy();
      }
    }
  });

  it("VT3 — geen Nederlandse enginetekst in de Franse of Arabische meldingen", () => {
    // De engine schrijft o.a. "deze lots", "geen eigenaar", "verdeelregel".
    const verdacht = /\b(deze lots|geen eigenaar|verdeelregel|lastenoproep|boekjaar|tantième van)\b/i;
    for (const naam of ["fr", "ar"]) {
      const charges = talen[naam].charges as { errors: Record<string, string> };
      for (const [sleutel, tekst] of Object.entries(charges.errors)) {
        expect(verdacht.test(tekst), `${naam}.charges.errors.${sleutel}: "${tekst}"`).toBe(false);
      }
    }
  });

  it("VT4 — de teksten renderen met de echte ICU-pipeline, zonder losse placeholders", () => {
    const maak = createTranslator as unknown as (opties: {
      locale: string;
      messages: unknown;
      namespace: string;
    }) => (sleutel: string, waarden?: Record<string, string | number>) => string;

    for (const [naam, berichten] of Object.entries(talen)) {
      const t = maak({ locale: naam, messages: berichten, namespace: "charges" });
      const zin = t("check.partialDenominator", {
        year: 2026,
        participating: 980,
        declared: 1000,
      });
      expect(zin, naam).toContain("2026");
      expect(zin, naam).not.toContain("{");
      expect(t("errors.noOwner"), naam).not.toContain("{");
      expect(t("confirm.warning"), naam).not.toContain("{");
    }
  });

  it("VT6 — de fail-closed meldingen bestaan in fr, nl en ar en zijn echte tekst", () => {
    // Zonder deze sleutels zou next-intl in productie op de sleutelnaam
    // terugvallen en zou de gebruiker "charges.errors.callsUnavailable" lezen
    // op de plek waar een bedrag hoorde te staan.
    const paden: [string, string][] = [
      ["errors", "callsUnavailable"],
      ["errors", "paymentsUnavailable"],
      ["errors", "balanceUnavailable"],
      ["result", "unavailable"],
    ];
    for (const [naam, berichten] of Object.entries(talen)) {
      const charges = berichten.charges as Record<string, Record<string, string>>;
      for (const [groep, sleutel] of paden) {
        const tekst = charges[groep]?.[sleutel];
        expect(tekst, `charges.${groep}.${sleutel} ontbreekt in ${naam}`).toBeTruthy();
        expect(tekst, `${naam}.${groep}.${sleutel}`).not.toContain("{");
        // Een foutmelding mag niet klinken als een lege, geslaagde uitkomst.
        expect(tekst!.toLowerCase(), `${naam}.${groep}.${sleutel}`).not.toMatch(
          /\b(aucun|geen enkele|0,00)\b/,
        );
      }
    }
  });

  it("VT5 — geen enkele taal mist een sleutel die het Frans wel heeft binnen charges", () => {
    const leaves = (o: unknown, p = ""): string[] =>
      o && typeof o === "object"
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}${k}.`))
        : [p.slice(0, -1)];
    const frKeys = new Set(leaves((fr as Record<string, unknown>).charges));
    for (const [naam, berichten] of Object.entries({ nl, ar })) {
      const andere = new Set(leaves((berichten as Record<string, unknown>).charges));
      const ontbrekend = [...frKeys].filter((k) => !andere.has(k));
      expect(ontbrekend, `ontbrekend in ${naam}: ${ontbrekend.join(", ")}`).toEqual([]);
    }
  });
});

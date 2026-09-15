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
    fiscalYear: { year: 2026, status: "open" },
    callDate: "2026-06-30",
    units: [unit(U1, "A1", 60), unit(U2, "A2", 40)],
    ruleUnits: [],
    ruleWeights: [],
    ownership: [bezit({ unit_id: U1 }), bezit({ unit_id: U2 })],
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

  it("GW5 — handmatig: een deelnemend lot zonder bedrag blokkeert", () => {
    const r = regel({ method: "manual", weight_source: "charge_call_lines" });
    const uit = chargeCallReadiness(invoer({ rule: r, manualUnitIds: [U1] }));
    const blok = uit.blockers.find((b) => b.code === "ALLOC_MANUAL_MISSING_UNIT");
    expect(blok && "units" in blok ? blok.units.map((u) => u.label) : []).toEqual(["A2"]);
  });

  it("GW6 — handmatig: de SOM blijft bij de database, dit scherm rekent niet mee", () => {
    const r = regel({ method: "manual", weight_source: "charge_call_lines" });
    const uit = chargeCallReadiness(invoer({ rule: r, manualUnitIds: [U1, U2] }));
    expect(uit.blockers).toEqual([]);
    expect(uit.notices.map((n) => n.code)).toContain("MANUAL_SUM_CHECKED_BY_DATABASE");
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
        fiscalYear: { year: 2026, status: "open" },
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
        fiscalYear: { year: 2026, status: "open" },
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
    const uit = chargeCallReadiness(invoer({ fiscalYear: { year: 2026, status: "closed" } }));
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
    expect(code).not.toMatch(/\*\s*100\b/);
    expect(code).not.toMatch(/\/\s*100\b/);
    expect(code).not.toMatch(/Math\.round/);
    expect(code).not.toMatch(/amount_cents/);
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

  it("GV4 — de pagina toont definitieve bedragen uit charge_call_lines", () => {
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
    expect(bron).toContain('.from("charge_call_lines")');
    expect(bron).toContain("linesPerCall");
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
      invoer({ ownership: [], declaredTantiemes: 999, fiscalYear: { year: 2026, status: "closed" } }),
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

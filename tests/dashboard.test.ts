import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildReversalIndex, emptyReversalIndex } from "@/lib/reversal";
import {
  assembleFinancials,
  buildAttentionItems,
  computeKpis,
  evaluateReconciliation,
  filterToSelectedFiscalYear,
  quickActions,
  recentActivity,
  selectFiscalYears,
  topDebtors,
  type FiscalYearRow,
  type SettlementRow,
} from "@/lib/dashboard";
import { formatMoney, formatPercent } from "@/lib/money";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = "aaaaaaaa-0000-0000-0000-000000000001"; // gebouw A
const B = "bbbbbbbb-0000-0000-0000-000000000002"; // gebouw B
const O1 = "11111111-0000-0000-0000-000000000001";
const O2 = "22222222-0000-0000-0000-000000000002";
const CALL_A = "ca110000-0000-0000-0000-00000000000a"; // lastenoproep in boekjaar 1
const CALL_B = "ca110000-0000-0000-0000-00000000000b"; // lastenoproep in boekjaar 2
const FY1 = "f7000000-0000-0000-0000-000000000001";
const FY2 = "f7000000-0000-0000-0000-000000000002";

function alloc(over: Partial<SettlementRow> = {}): SettlementRow {
  return {
    charge_allocation_id: crypto.randomUUID(),
    building_id: A,
    charge_call_id: CALL_A,
    owner_id: O1,
    amount: 1000,
    settled_amount: 0,
    ok: true,
    ...over,
  };
}

/** Bouwt de storno-index zoals `v_financial_reversals` hem levert. */
function reversalIndex(
  rows: { source: string; type?: "payment" | "expense"; correction?: string | null }[],
) {
  return buildReversalIndex(
    rows.map((r, i) => ({
      reversal_id: `rev-${i}`,
      source_type: r.type ?? "payment",
      source_id: r.source,
      correction_source_id: r.correction ?? null,
      reason: "test",
      effective_date: "2026-01-01",
      is_correctie: Boolean(r.correction),
      is_correctie_vorig_boekjaar: false,
    })),
  );
}

const geen = emptyReversalIndex();

// ── FINANCIËLE REKENKUNDE ───────────────────────────────────────────────────

describe("KPI-rekenkunde", () => {
  it("D1 — een oproep van 1000 levert appelé 1000", () => {
    const k = computeKpis({
      settlements: [alloc({ amount: 1000 })],
      payments: [],
      expenses: [],
      reversals: geen,
    });
    expect(k.appele).toBe(1000);
  });

  it("D1b — appelé telt alle allocaties van de oproep op, zonder dubbeltelling", () => {
    const k = computeKpis({
      settlements: [alloc({ amount: 600 }), alloc({ amount: 400, owner_id: O2 })],
      payments: [],
      expenses: [],
      reversals: geen,
    });
    expect(k.appele).toBe(1000);
  });

  it("D2 — een betaling van 1000 levert encaissé 1000", () => {
    const k = computeKpis({
      settlements: [],
      payments: [{ id: "p1", amount: 1000, building_id: A }],
      expenses: [],
      reversals: geen,
    });
    expect(k.encaisse).toBe(1000);
  });

  it("D3 — na storno van die betaling is encaissé 0", () => {
    const k = computeKpis({
      settlements: [],
      payments: [{ id: "p1", amount: 1000, building_id: A }],
      expenses: [],
      reversals: reversalIndex([{ source: "p1" }]),
    });
    expect(k.encaisse).toBe(0);
  });

  it("D4 — correctie 1000 naar 800 levert encaissé 800, niet 1800", () => {
    // De engine laat DRIE feiten achter: het origineel, de storno en de
    // vervangende betaling. Bruto is 1800; economisch is het 800.
    const k = computeKpis({
      settlements: [],
      payments: [
        { id: "p1", amount: 1000, building_id: A },
        { id: "p2", amount: 800, building_id: A },
      ],
      expenses: [],
      reversals: reversalIndex([{ source: "p1", correction: "p2" }]),
    });
    expect(k.encaisse).toBe(800);
  });

  it("D5 — een onbetaalde vordering van 1000 levert restant dû 1000", () => {
    const k = computeKpis({
      settlements: [alloc({ amount: 1000, settled_amount: 0 })],
      payments: [],
      expenses: [],
      reversals: geen,
    });
    expect(k.restant).toBe(1000);
  });

  it("D6 — 800 afgeboekt van 1000 levert restant dû 200", () => {
    const k = computeKpis({
      settlements: [alloc({ amount: 1000, settled_amount: 800 })],
      payments: [],
      expenses: [],
      reversals: geen,
    });
    expect(k.restant).toBe(200);
  });

  it("D7 — een uitgave van 1200 levert dépenses 1200", () => {
    const k = computeKpis({
      settlements: [],
      payments: [],
      expenses: [{ id: "e1", amount: 1200, building_id: A }],
      reversals: geen,
    });
    expect(k.depenses).toBe(1200);
  });

  it("D8 — na storno van die uitgave is dépenses 0", () => {
    const k = computeKpis({
      settlements: [],
      payments: [],
      expenses: [{ id: "e1", amount: 1200, building_id: A }],
      reversals: reversalIndex([{ source: "e1", type: "expense" }]),
    });
    expect(k.depenses).toBe(0);
  });

  it("D9 — correctie 1200 naar 900 levert dépenses 900", () => {
    const k = computeKpis({
      settlements: [],
      payments: [],
      expenses: [
        { id: "e1", amount: 1200, building_id: A },
        { id: "e2", amount: 900, building_id: A },
      ],
      reversals: reversalIndex([
        { source: "e1", type: "expense", correction: "e2" },
      ]),
    });
    expect(k.depenses).toBe(900);
  });

  it("het volledige scenario uit de live-probe komt op dezelfde cijfers uit", () => {
    // Drie gebouwen: normaal, gestorneerd, gecorrigeerd — exact de fixture die
    // tegen de echte database is gedraaid.
    const k = computeKpis({
      settlements: [
        alloc({ building_id: A, amount: 1000, settled_amount: 1000 }),
        alloc({ building_id: B, amount: 1000, settled_amount: 0 }),
        alloc({ building_id: "c", amount: 1000, settled_amount: 800 }),
      ],
      payments: [
        { id: "p1", amount: 1000, building_id: A },
        { id: "p2", amount: 1000, building_id: B },
        { id: "p3", amount: 1000, building_id: "c" },
        { id: "p4", amount: 800, building_id: "c" },
      ],
      expenses: [
        { id: "e1", amount: 1200, building_id: A },
        { id: "e2", amount: 1200, building_id: B },
        { id: "e3", amount: 1200, building_id: "c" },
        { id: "e4", amount: 900, building_id: "c" },
      ],
      reversals: reversalIndex([
        { source: "p2" },
        { source: "e2", type: "expense" },
        { source: "p3", correction: "p4" },
        { source: "e3", type: "expense", correction: "e4" },
      ]),
    });
    expect(k.appele).toBe(3000);
    expect(k.encaisse).toBe(1800);
    expect(k.restant).toBe(1200);
    expect(k.depenses).toBe(2100);
    expect(k.taux).toBe(60);
  });
});

describe("D10 — inningsgraad", () => {
  it("is nooit hoger dan 100% bij overbetaling", () => {
    // Overbetaling kan settled_amount niet boven amount duwen: dat verbiedt
    // CHECK (settled_amount <= amount). Het meerdere landt op 4419 en telt wel
    // in encaissé mee — precies waarom de formule NIET encaissé/appelé is.
    const k = computeKpis({
      settlements: [alloc({ amount: 1000, settled_amount: 1000 })],
      payments: [{ id: "p1", amount: 1500, building_id: A }],
      expenses: [],
      reversals: geen,
    });
    expect(k.encaisse).toBe(1500);
    expect(k.taux).toBe(100);
    expect(k.taux!).toBeLessThanOrEqual(100);
  });

  it("is null wanneer er niets is opgeroepen, niet 0%", () => {
    const k = computeKpis({ settlements: [], payments: [], expenses: [], reversals: geen });
    expect(k.taux).toBeNull();
    expect(formatPercent(k.taux, "fr")).toBe("—");
  });

  it("weerspiegelt gedeeltelijke afboeking", () => {
    const k = computeKpis({
      settlements: [alloc({ amount: 1000, settled_amount: 250 })],
      payments: [],
      expenses: [],
      reversals: geen,
    });
    expect(k.taux).toBe(25);
  });
});

// ── SCOPE ───────────────────────────────────────────────────────────────────

describe("scope", () => {
  const alleRijen = [
    alloc({ building_id: A, amount: 1000, settled_amount: 400 }),
    alloc({ building_id: B, amount: 500, settled_amount: 0, owner_id: O2 }),
  ];

  it("D11 — het dashboard van gebouw A sluit gebouw B uit", () => {
    const k = computeKpis({
      settlements: alleRijen.filter((r) => r.building_id === A),
      payments: [{ id: "p1", amount: 400, building_id: A }],
      expenses: [],
      reversals: geen,
    });
    expect(k.appele).toBe(1000);
    expect(k.restant).toBe(600);
  });

  it("D12 — organisatiebreed telt alleen de eigen gebouwen samen", () => {
    const k = computeKpis({
      settlements: alleRijen,
      payments: [],
      expenses: [],
      reversals: geen,
    });
    expect(k.appele).toBe(1500);
    expect(k.restant).toBe(1100);
  });

});

// ── LEGE TOESTANDEN ─────────────────────────────────────────────────────────

describe("lege toestanden", () => {
  it("D14 — zonder financiële data zijn alle bedragen 0 en het percentage leeg", () => {
    const k = computeKpis({ settlements: [], payments: [], expenses: [], reversals: geen });
    expect(k).toEqual({ appele: 0, encaisse: 0, restant: 0, depenses: 0, taux: null });
  });

  it("D15 — zonder open boekjaar valt de keuze terug op het meest recente jaar", () => {
    const jaren: FiscalYearRow[] = [
      fy("f1", A, 2025, "closed"),
      fy("f2", A, 2026, "closed"),
    ];
    const sel = selectFiscalYears([A], jaren, "2026-06-01");
    expect(sel.selected).toHaveLength(1);
    expect(sel.selected[0].fiscalYear.year).toBe(2026);
    expect(sel.buildingsWithMultipleOpen).toEqual([]);
  });

  it("zonder enig boekjaar doet het gebouw niet mee en wordt dat gemeld", () => {
    const sel = selectFiscalYears([A], [], "2026-06-01");
    expect(sel.selected).toEqual([]);
    expect(sel.buildingsWithoutFiscalYear).toEqual([A]);
  });

  it("kiest het open boekjaar waarin de peildatum valt", () => {
    const jaren: FiscalYearRow[] = [fy("f1", A, 2025), fy("f2", A, 2026)];
    const sel = selectFiscalYears([A], jaren, "2025-06-01");
    expect(sel.selected[0].fiscalYear.year).toBe(2025);
  });
});

// ── AANDACHTSPUNTEN ─────────────────────────────────────────────────────────

const gezond = {
  restant: 0,
  aantalDebiteuren: 0,
  zonderEigenaar: 0,
  settlementNok: 0 as number | null,
  allocationNok: 0 as number | null,
  reconciliatieVerschil: 0 as number | null,
  buildingsWithMultipleOpen: 0,
  buildingsWithoutFiscalYear: 0,
  buildingsOutsideReferenceDate: 0,
  buildingHref: null as string | null,
};

describe("aandachtspunten", () => {
  it("D16 — een integriteitsfout levert een kritiek signaal op", () => {
    const items = buildAttentionItems({ ...gezond, settlementNok: 2 });
    expect(items).toHaveLength(1);
    expect(items[0].tone).toBe("crit");
    expect(items[0].labelKey).toBe("settlementMismatch");
    expect(items[0].values).toEqual({ count: 2 });
  });

  it("D17 — een gezonde toestand levert geen enkel signaal op", () => {
    expect(buildAttentionItems(gezond)).toEqual([]);
  });

  it("meldt een niet-sluitende boekhouding, ook bij een klein verschil", () => {
    expect(buildAttentionItems({ ...gezond, reconciliatieVerschil: 0.01 })).toHaveLength(1);
    // Centruis onder een halve cent is geen signaal.
    expect(buildAttentionItems({ ...gezond, reconciliatieVerschil: 0.001 })).toEqual([]);
  });

  it("meldt vorderingen zonder eigenaar als datafout, niet als eigenaar", () => {
    const items = buildAttentionItems({ ...gezond, zonderEigenaar: 250 });
    expect(items[0].labelKey).toBe("allocationWithoutOwner");
    expect(items[0].tone).toBe("crit");
  });

  it("waarschuwt alleen wanneer EEN GEBOUW meerdere open boekjaren heeft", () => {
    expect(buildAttentionItems({ ...gezond, buildingsWithMultipleOpen: 1 })
      .some((i) => i.labelKey === "buildingsWithMultipleOpenFiscalYears")).toBe(true);
    expect(buildAttentionItems({ ...gezond, buildingsWithMultipleOpen: 0 })
      .some((i) => i.labelKey === "buildingsWithMultipleOpenFiscalYears")).toBe(false);
  });

  it("meldt gebouwen zonder boekjaar als onvolledige dekking", () => {
    const items = buildAttentionItems({ ...gezond, buildingsWithoutFiscalYear: 2 });
    const item = items.find((i) => i.labelKey === "buildingsWithoutFiscalYear");
    expect(item?.values).toEqual({ count: 2 });
  });

  it("een MISLUKTE integriteitscontrole leest nooit als gezond", () => {
    for (const kapot of [
      { settlementNok: null },
      { allocationNok: null },
      { reconciliatieVerschil: null },
    ]) {
      const items = buildAttentionItems({ ...gezond, ...kapot });
      expect(items.some((i) => i.labelKey === "integrityUnavailable")).toBe(true);
      expect(items[0].tone).toBe("crit");
    }
  });

  it("toont nooit een interne view- of tabelnaam", () => {
    const items = buildAttentionItems({
      restant: 900,
      aantalDebiteuren: 3,
      zonderEigenaar: 100,
      settlementNok: 1,
      allocationNok: 1,
      reconciliatieVerschil: 5,
      buildingsWithMultipleOpen: 1,
      buildingsWithoutFiscalYear: 1,
      buildingsOutsideReferenceDate: 1,
      buildingHref: `/buildings/${A}`,
    });
    const alles = JSON.stringify(items);
    for (const intern of ["v_settlement", "v_allocation", "v_reconciliation", "charge_allocations", "SELECT"]) {
      expect(alles).not.toContain(intern);
    }
  });
});

// ── DEBITEUREN ──────────────────────────────────────────────────────────────

describe("debiteuren", () => {
  const namen = new Map([
    [O1, "Ahmed Benali"],
    [O2, "Fatima Zahra"],
  ]);

  it("sorteert aflopend op openstaand bedrag", () => {
    const { debtors } = topDebtors(
      [
        alloc({ owner_id: O1, amount: 1000, settled_amount: 900 }),
        alloc({ owner_id: O2, amount: 1000, settled_amount: 100 }),
      ],
      namen,
    );
    expect(debtors.map((d) => d.name)).toEqual(["Fatima Zahra", "Ahmed Benali"]);
    expect(debtors[0].restant).toBe(900);
  });

  it("telt meerdere posten per eigenaar samen en telt de open posten", () => {
    const { debtors } = topDebtors(
      [
        alloc({ owner_id: O1, amount: 600, settled_amount: 0 }),
        alloc({ owner_id: O1, amount: 400, settled_amount: 400 }),
        alloc({ owner_id: O1, amount: 300, settled_amount: 100 }),
      ],
      namen,
    );
    expect(debtors[0].appele).toBe(1300);
    expect(debtors[0].restant).toBe(800);
    expect(debtors[0].openPosten).toBe(2);
  });

  it("laat eigenaren zonder schuld weg", () => {
    const { debtors, totaalDebiteuren } = topDebtors(
      [alloc({ owner_id: O1, amount: 500, settled_amount: 500 })],
      namen,
    );
    expect(debtors).toEqual([]);
    expect(totaalDebiteuren).toBe(0);
  });

  it("presenteert een allocatie zonder eigenaar NIET als eigenaar", () => {
    const { debtors, zonderEigenaar } = topDebtors(
      [
        alloc({ owner_id: null, amount: 700, settled_amount: 0 }),
        alloc({ owner_id: O1, amount: 100, settled_amount: 0 }),
      ],
      namen,
    );
    expect(debtors).toHaveLength(1);
    expect(debtors[0].ownerId).toBe(O1);
    expect(zonderEigenaar).toBe(700);
  });

  it("beperkt de lijst tot het gevraagde aantal maar telt het totaal door", () => {
    const rijen = Array.from({ length: 9 }, (_, i) =>
      alloc({ owner_id: `owner-${i}`, amount: 100 * (i + 1), settled_amount: 0 }),
    );
    const { debtors, totaalDebiteuren } = topDebtors(rijen, new Map(), 5);
    expect(debtors).toHaveLength(5);
    expect(totaalDebiteuren).toBe(9);
    expect(debtors[0].restant).toBe(900);
  });
});

// ── ACTIVITEIT ──────────────────────────────────────────────────────────────

describe("recente activiteit", () => {
  it("mengt betalingen en uitgaven, nieuwste eerst", () => {
    const rijen = recentActivity(
      [{ id: "p1", amount: 100, building_id: A, date: "2026-03-01", context: "Atlas" }],
      [{ id: "e1", amount: 200, building_id: A, date: "2026-05-01", context: "Lydec" }],
      geen,
    );
    expect(rijen.map((r) => r.kind)).toEqual(["expense", "payment"]);
  });

  it("houdt een gestorneerde rij ZICHTBAAR maar gemarkeerd", () => {
    const rijen = recentActivity(
      [{ id: "p1", amount: 100, building_id: A, date: "2026-03-01", context: "Atlas" }],
      [],
      reversalIndex([{ source: "p1" }]),
    );
    expect(rijen).toHaveLength(1);
    expect(rijen[0].reversed).toBe(true);
  });

  it("markeert de vervangende rij van een correctie", () => {
    const rijen = recentActivity(
      [
        { id: "p1", amount: 1000, building_id: A, date: "2026-03-01", context: "Atlas" },
        { id: "p2", amount: 800, building_id: A, date: "2026-03-02", context: "Atlas" },
      ],
      [],
      reversalIndex([{ source: "p1", correction: "p2" }]),
    );
    expect(rijen.find((r) => r.id === "p2")?.isCorrection).toBe(true);
    expect(rijen.find((r) => r.id === "p1")?.reversed).toBe(true);
  });

  it("respecteert de limiet", () => {
    const veel = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      amount: 10,
      building_id: A,
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      context: "x",
    }));
    expect(recentActivity(veel, [], geen, 8)).toHaveLength(8);
  });
});

// ── ROLLEN ──────────────────────────────────────────────────────────────────

describe("D18 — rollen", () => {
  it("een reader krijgt geen enkele muterende snelkoppeling", () => {
    const acties = quickActions({ buildingId: A, fiscalYearId: "fy1", mayWrite: false });
    expect(acties.every((a) => !a.mutating)).toBe(true);
    expect(acties.map((a) => a.key)).toEqual(["fiscal-years", "building"]);
  });

  it("wie mag schrijven krijgt ze wel", () => {
    const acties = quickActions({ buildingId: A, fiscalYearId: "fy1", mayWrite: true });
    expect(acties.filter((a) => a.mutating).map((a) => a.key)).toEqual([
      "payment",
      "expense",
    ]);
  });

  it("biedt geen betaling aan zonder boekjaar, want dat scherm bestaat dan niet", () => {
    const acties = quickActions({ buildingId: A, fiscalYearId: null, mayWrite: true });
    expect(acties.some((a) => a.key === "payment")).toBe(false);
  });

  it("verwijst zonder gebouwcontext alleen naar de gebouwenlijst", () => {
    const acties = quickActions({ buildingId: null, fiscalYearId: null, mayWrite: true });
    expect(acties).toEqual([
      { key: "buildings", href: "/buildings", labelKey: "allBuildings", mutating: false },
    ]);
  });

  it("verwijst uitsluitend naar bestaande routes", () => {
    const paden = [
      ...quickActions({ buildingId: A, fiscalYearId: "fy1", mayWrite: true }),
      ...quickActions({ buildingId: null, fiscalYearId: null, mayWrite: true }),
    ].map((a) => a.href);
    const bestaand = [
      `/buildings/${A}/boekjaren/fy1`,
      `/buildings/${A}/expenses`,
      `/buildings/${A}/boekjaren`,
      `/buildings/${A}`,
      "/buildings",
    ];
    for (const pad of paden) expect(bestaand).toContain(pad);
  });
});

// ── BEDRAGWEERGAVE EN I18N ──────────────────────────────────────────────────

describe("bedragweergave", () => {
  it("toont MAD in elke taal", () => {
    for (const locale of ["fr", "nl", "ar"]) {
      const tekst = formatMoney(1234.5, locale);
      expect(tekst).toMatch(/1[\s  .,]?234/);
    }
  });

  it("gebruikt Latijnse cijfers in het Arabisch", () => {
    // Zonder -u-nu-latn rendert Intl Arabisch-Indische cijfers (١٢٣٤).
    expect(formatMoney(1234.5, "ar")).toMatch(/[0-9]/);
    expect(formatMoney(1234.5, "ar")).not.toMatch(/[٠-٩]/);
  });

  it("valt terug op het Frans bij een onbekende taal", () => {
    expect(formatMoney(1000, "de")).toBe(formatMoney(1000, "fr"));
  });

  it("toont een gedachtestreepje in plaats van 0% wanneer er niets is opgeroepen", () => {
    expect(formatPercent(null, "nl")).toBe("—");
    expect(formatPercent(0, "nl")).not.toBe("—");
  });
});

describe("D19 — vertalingen", () => {
  const locales = { fr, nl, ar } as Record<string, Record<string, unknown>>;

  it("de dashboardsleutels bestaan in fr, nl en ar", () => {
    const paden = [
      "title", "fiscalYear", "fiscalYearRange", "multipleOpenBadge",
      "buildingsCounted", "unknownBuilding",
      "loadError.title", "loadError.body",
      "attention.integrityUnavailable", "attention.buildingsWithoutFiscalYear",
      "status.open", "status.closed",
      "kpi.called", "kpi.collected", "kpi.outstanding", "kpi.expenses", "kpi.recovery",
      "kpi.recoveryNone", "kpi.sectionTitle",
      "attention.title", "attention.open", "attention.outstanding",
      "attention.settlementMismatch", "attention.allocationMismatch",
      "attention.reconciliationMismatch", "attention.allocationWithoutOwner",
      "attention.buildingsWithMultipleOpenFiscalYears",
      "attention.periodExcludesToday",
      "attention.tone.crit", "attention.tone.warn", "attention.tone.info",
      "debtors.title", "debtors.owner", "debtors.called", "debtors.outstanding",
      "debtors.openItems", "debtors.empty", "debtors.unknownOwner",
      "activity.title", "activity.empty", "activity.noContext",
      "activity.reversed", "activity.correction",
      "activity.kind.payment", "activity.kind.expense",
      "actions.title", "actions.recordPayment", "actions.addExpense",
      "actions.fiscalYears", "actions.manageBuilding", "actions.allBuildings",
      "noFiscalYear.title", "noFiscalYear.body", "noFiscalYear.cta",
      "noActivity.title", "noActivity.body", "noActivity.cta",
      "empty.title", "empty.body", "empty.cta",
    ];
    for (const [naam, berichten] of Object.entries(locales)) {
      const dash = berichten.dashboard as Record<string, unknown>;
      for (const pad of paden) {
        const waarde = pad.split(".").reduce<unknown>(
          (o, k) => (o as Record<string, unknown> | undefined)?.[k],
          dash,
        );
        expect(typeof waarde, `dashboard.${pad} ontbreekt in ${naam}`).toBe("string");
      }
    }
  });

  it("de meervoudsvormen dragen in elke taal een {count}-parameter", () => {
    const meervoud = [
      "multipleOpenBadge",
      "attention.outstanding",
      "attention.buildingsWithMultipleOpenFiscalYears",
      "attention.periodExcludesToday",
      "debtors.openItems",
    ];
    for (const [naam, berichten] of Object.entries(locales)) {
      const dash = berichten.dashboard as Record<string, unknown>;
      for (const pad of meervoud) {
        const waarde = pad.split(".").reduce<unknown>(
          (o, k) => (o as Record<string, unknown> | undefined)?.[k],
          dash,
        ) as string;
        expect(waarde, `${naam} ${pad}`).toContain("{count, plural,");
      }
    }
  });

  it("de interpolatie {year} staat in alle talen", () => {
    for (const [naam, berichten] of Object.entries(locales)) {
      const dash = berichten.dashboard as Record<string, string>;
      expect(dash.fiscalYear, naam).toContain("{year}");
    }
  });
});

// ── RENDERVORM ──────────────────────────────────────────────────────────────

describe("D20 — geen overflowgevoelige vaste breedtes", () => {
  it("de dashboardbestanden gebruiken geen vaste pixelbreedtes of fysieke richtingen", () => {
    const bestanden = [
      join(REPO, "src", "app", "[locale]", "(app)", "dashboard", "page.tsx"),
      join(REPO, "src", "components", "dashboard", "KpiCard.tsx"),
    ];
    for (const bestand of bestanden) {
      const bron = readFileSync(bestand, "utf8");
      // Vaste breedtes in px binnen een className breken op 360px.
      expect(bron, bestand).not.toMatch(/className="[^"]*\bw-\[\d+px\]/);
      expect(bron, bestand).not.toMatch(/style=\{\{[^}]*width:\s*\d/);
      // Fysieke richtingen breken het Arabisch.
      expect(bron, bestand).not.toMatch(/className="[^"]*\b(ml-|mr-|pl-|pr-|text-left|text-right|border-l\b|border-r\b)/);
    }
  });

  it("de KPI-rasters schalen mee met het scherm", () => {
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "dashboard", "page.tsx"),
      "utf8",
    );
    // Mobiel twee kolommen, desktop vier: nooit een vast aantal zonder breekpunt.
    expect(bron).toMatch(/grid-cols-2[^"]*lg:grid-cols-4/);
  });
});

// ── BOEKJAARSELECTIE PER GEBOUW ─────────────────────────────────────────────

/** Bouwt een boekjaarrij; standaard een kalenderjaar met status open. */
function fy(
  id: string,
  building: string,
  year: number,
  status: "open" | "closed" = "open",
  start = `${year}-01-01`,
  end = `${year}-12-31`,
): FiscalYearRow {
  return { id, building_id: building, year, start_date: start, end_date: end, status };
}

const C = "cccccccc-0000-0000-0000-000000000003";

describe("boekjaarselectie per gebouw", () => {
  it("S1 — twee gebouwen met ieder EEN open boekjaar geeft GEEN waarschuwing", () => {
    // Dit was de kern van de bevinding: vijf gebouwen met ieder een open jaar
    // meldden ten onrechte dat er vijf boekjaren tegelijk openstonden.
    const sel = selectFiscalYears(
      [A, B],
      [fy("fa", A, 2026), fy("fb", B, 2026)],
      "2026-06-01",
    );
    expect(sel.selected).toHaveLength(2);
    expect(sel.buildingsWithMultipleOpen).toEqual([]);
    expect(
      buildAttentionItems({
        ...gezond,
        buildingsWithMultipleOpen: sel.buildingsWithMultipleOpen.length,
      }).some((i) => i.labelKey === "buildingsWithMultipleOpenFiscalYears"),
    ).toBe(false);
  });

  it("S1b — ook vijf gebouwen met ieder een open boekjaar blijven stil", () => {
    const ids = ["b1", "b2", "b3", "b4", "b5"];
    const sel = selectFiscalYears(
      ids,
      ids.map((id, i) => fy(`f${i}`, id, 2026)),
      "2026-06-01",
    );
    expect(sel.selected).toHaveLength(5);
    expect(sel.buildingsWithMultipleOpen).toEqual([]);
  });

  it("S2 — EEN gebouw met twee open boekjaren geeft WEL een waarschuwing", () => {
    const sel = selectFiscalYears(
      [A, B],
      [fy("fa1", A, 2025), fy("fa2", A, 2026), fy("fb", B, 2026)],
      "2026-06-01",
    );
    expect(sel.buildingsWithMultipleOpen).toEqual([A]);
    // Er wordt nog steeds precies een boekjaar per gebouw gekozen.
    expect(sel.selected).toHaveLength(2);
    expect(sel.selected.filter((x) => x.buildingId === A)).toHaveLength(1);
    expect(
      buildAttentionItems({ ...gezond, buildingsWithMultipleOpen: 1 }).some(
        (i) => i.labelKey === "buildingsWithMultipleOpenFiscalYears",
      ),
    ).toBe(true);
  });

  it("S3 — gebouwen met verschillende boekjaarperioden krijgen ieder hun eigen", () => {
    // A voert een kalenderjaar, B een gebroken boekjaar juli tot en met juni.
    const sel = selectFiscalYears(
      [A, B],
      [
        fy("fa", A, 2026, "open", "2026-01-01", "2026-12-31"),
        fy("fb", B, 2026, "open", "2025-07-01", "2026-06-30"),
      ],
      "2026-03-01",
    );
    const perGebouw = new Map(sel.selected.map((x) => [x.buildingId, x.fiscalYear]));
    expect(perGebouw.get(A)?.start_date).toBe("2026-01-01");
    expect(perGebouw.get(B)?.start_date).toBe("2025-07-01");
    expect(perGebouw.get(B)?.end_date).toBe("2026-06-30");
  });

  it("S4 — een gebouw zonder boekjaar doet niet mee en wordt zichtbaar gemeld", () => {
    const sel = selectFiscalYears([A, B], [fy("fa", A, 2026)], "2026-06-01");
    expect(sel.selected.map((x) => x.buildingId)).toEqual([A]);
    expect(sel.buildingsWithoutFiscalYear).toEqual([B]);
    const items = buildAttentionItems({
      ...gezond,
      buildingsWithoutFiscalYear: sel.buildingsWithoutFiscalYear.length,
    });
    expect(items.some((i) => i.labelKey === "buildingsWithoutFiscalYear")).toBe(true);
  });

  it("de jaartallen van de selectie worden ontdubbeld en gesorteerd", () => {
    const sel = selectFiscalYears(
      [A, B, C],
      [fy("fa", A, 2026), fy("fb", B, 2025), fy("fc", C, 2026)],
      "2026-06-01",
    );
    expect(sel.years).toEqual([2025, 2026]);
  });
});

// ── BETALINGEN PER GEBOUWBOEKJAAR ───────────────────────────────────────────

describe("betalingen worden per gebouwboekjaar gefilterd", () => {
  // A: kalenderjaar 2026. B: gebroken boekjaar juli 2025 tot en met juni 2026.
  const selectie = selectFiscalYears(
    [A, B],
    [
      fy("fa", A, 2026, "open", "2026-01-01", "2026-12-31"),
      fy("fb", B, 2026, "open", "2025-07-01", "2026-06-30"),
    ],
    "2026-03-01",
  );

  const pay = (id: string, building: string | null, date: string, amount = 100) => ({
    id,
    amount,
    building_id: building,
    value_date: date,
  });

  it("S5 — binnen het gecombineerde venster maar BUITEN het eigen boekjaar telt niet", () => {
    // Het gecombineerde venster loopt van 2025-07-01 tot 2026-12-31. Een
    // betaling van gebouw A op 2025-09-01 valt daar netjes in, maar buiten het
    // eigen boekjaar van A. Precies de fout die de brede periode veroorzaakte.
    expect(filterToSelectedFiscalYear([pay("p1", A, "2025-09-01")], selectie)).toEqual([]);
  });

  it("S5b — en andersom: gebouw B op 2026-11-01 valt buiten het boekjaar van B", () => {
    expect(filterToSelectedFiscalYear([pay("p2", B, "2026-11-01")], selectie)).toEqual([]);
  });

  it("S6 — een betaling binnen het eigen boekjaar telt WEL mee", () => {
    const resultaat = filterToSelectedFiscalYear(
      [pay("p3", A, "2026-05-01"), pay("p4", B, "2025-09-01")],
      selectie,
    );
    expect(resultaat.map((r) => r.id).sort()).toEqual(["p3", "p4"]);
  });

  it("de grenzen zelf horen erbij", () => {
    const resultaat = filterToSelectedFiscalYear(
      [pay("start", A, "2026-01-01"), pay("eind", A, "2026-12-31")],
      selectie,
    );
    expect(resultaat).toHaveLength(2);
  });

  it("S7 — in gebouwscope telt een betaling van een ander gebouw niet mee", () => {
    const alleenA = selectFiscalYears(
      [A],
      [fy("fa", A, 2026, "open", "2026-01-01", "2026-12-31")],
      "2026-03-01",
    );
    const resultaat = filterToSelectedFiscalYear(
      [pay("pa", A, "2026-05-01"), pay("pb", B, "2026-05-01")],
      alleenA,
    );
    expect(resultaat.map((r) => r.id)).toEqual(["pa"]);
  });

  it("S4b — betalingen van een gebouw zonder boekjaar tellen niet mee", () => {
    const zonderB = selectFiscalYears([A, B], [fy("fa", A, 2026)], "2026-06-01");
    const resultaat = filterToSelectedFiscalYear(
      [pay("pa", A, "2026-05-01"), pay("pb", B, "2026-05-01")],
      zonderB,
    );
    expect(resultaat.map((r) => r.id)).toEqual(["pa"]);
  });

  it("een rij zonder gebouw is niet toewijsbaar en telt nooit mee", () => {
    expect(filterToSelectedFiscalYear([pay("px", null, "2026-05-01")], selectie)).toEqual([]);
  });

  it("S8 — appele, restant, encaisse en depenses gebruiken dezelfde gebouwset", () => {
    // B heeft geen boekjaar en valt dus overal uit: ook de vordering en de
    // uitgave van B mogen niet meetellen, anders wijkt appele af van encaisse.
    const zonderB = selectFiscalYears([A, B], [fy("fa", A, 2026)], "2026-06-01");
    const gekozen = new Set(zonderB.selected.map((x) => x.buildingId));

    const alleSettlements = [
      alloc({ building_id: A, amount: 1000, settled_amount: 400 }),
      alloc({ building_id: B, amount: 500, settled_amount: 0 }),
    ];
    const alleUitgaven = [
      { id: "ea", amount: 300, building_id: A },
      { id: "eb", amount: 700, building_id: B },
    ];
    const betalingen = filterToSelectedFiscalYear(
      [pay("pa", A, "2026-05-01", 400), pay("pb", B, "2026-05-01", 900)],
      zonderB,
    );

    const k = computeKpis({
      settlements: alleSettlements.filter((r) => gekozen.has(r.building_id!)),
      payments: betalingen,
      expenses: alleUitgaven.filter((r) => gekozen.has(r.building_id)),
      reversals: geen,
    });

    expect(k.appele).toBe(1000);
    expect(k.restant).toBe(600);
    expect(k.encaisse).toBe(400);
    expect(k.depenses).toBe(300);
  });
});

// ── FAIL-CLOSED FOUTAFHANDELING ─────────────────────────────────────────────

describe("fail-closed bij queryfouten", () => {
  const basis = {
    selection: selectFiscalYears([A], [fy("fa", A, 2026)], "2026-06-01"),
    settlements: [alloc({ amount: 1000, settled_amount: 400 })],
    payments: [{ id: "p1", amount: 400, building_id: A }],
    expenses: [{ id: "e1", amount: 300, building_id: A }],
    reversals: geen,
  };

  it("een volledige set levert gewoon bedragen op", () => {
    const r = assembleFinancials(basis);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.kpis.appele).toBe(1000);
    expect(r.kpis.encaisse).toBe(400);
    expect(r.kpis.depenses).toBe(300);
  });

  it.each([
    ["E11 boekjaren", "selection", "fiscalYears"],
    ["E12 vorderingen", "settlements", "settlements"],
    ["E13 betalingen", "payments", "payments"],
    ["E14 uitgaven", "expenses", "expenses"],
    ["E15 stornos", "reversals", "reversals"],
  ])(
    "%s: een fout onderdrukt ALLE bedragen in plaats van nul te tonen",
    (_naam, bron, gemeld) => {
    const r = assembleFinancials({ ...basis, [bron]: null });
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.failed).toContain(gemeld);
    // Er is geen enkel bedrag om te tonen: geen 0, geen gedeeltelijk totaal.
    expect(r).not.toHaveProperty("kpis");
  },
  );

  it("meldt alle gefaalde bronnen, niet alleen de eerste", () => {
    const r = assembleFinancials({ ...basis, payments: null, expenses: null });
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.failed).toEqual(expect.arrayContaining(["payments", "expenses"]));
  });

  it("een LEGE bron is een antwoord en mag wel nul opleveren", () => {
    const r = assembleFinancials({
      ...basis,
      settlements: [],
      payments: [],
      expenses: [],
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.kpis).toEqual({ appele: 0, encaisse: 0, restant: 0, depenses: 0, taux: null });
  });

  it("E16 — een mislukte integriteitscontrole telt niet als geen problemen", () => {
    expect(buildAttentionItems(gezond)).toEqual([]);

    const kapot = buildAttentionItems({ ...gezond, allocationNok: null });
    expect(kapot.some((i) => i.labelKey === "integrityUnavailable")).toBe(true);
    // En hij mag niet stilletjes als nul problemen worden gelezen.
    expect(kapot.some((i) => i.labelKey === "allocationMismatch")).toBe(false);
  });
});

// ── SCOPE-REGRESSIE ─────────────────────────────────────────────────────────

describe("S18 — gebouwscope blijft regressievrij", () => {
  it("de live-proof blijft exact staan binnen een gebouwboekjaar", () => {
    const sel = selectFiscalYears(
      [A],
      [fy("fa", A, 2026, "open", "2026-01-01", "2026-12-31")],
      "2026-06-01",
    );
    const rij = (id: string, bedrag: number, datum: string) => ({
      id,
      amount: bedrag,
      building_id: A,
      value_date: datum,
    });

    // normaal
    let betalingen = filterToSelectedFiscalYear([rij("p1", 1000, "2026-04-01")], sel);
    let k = computeKpis({
      settlements: [alloc({ amount: 1000, settled_amount: 1000 })],
      payments: betalingen,
      expenses: [],
      reversals: geen,
    });
    expect([k.appele, k.encaisse, k.restant]).toEqual([1000, 1000, 0]);

    // na storno
    k = computeKpis({
      settlements: [alloc({ amount: 1000, settled_amount: 0 })],
      payments: betalingen,
      expenses: [],
      reversals: reversalIndex([{ source: "p1" }]),
    });
    expect([k.appele, k.encaisse, k.restant]).toEqual([1000, 0, 1000]);

    // na correctie naar 800
    betalingen = filterToSelectedFiscalYear(
      [rij("p1", 1000, "2026-04-01"), rij("p2", 800, "2026-04-01")],
      sel,
    );
    k = computeKpis({
      settlements: [alloc({ amount: 1000, settled_amount: 800 })],
      payments: betalingen,
      expenses: [],
      reversals: reversalIndex([{ source: "p1", correction: "p2" }]),
    });
    expect([k.appele, k.encaisse, k.restant]).toEqual([1000, 800, 200]);
  });

  it("een correctie over de boekjaargrens wordt per periode correct verdeeld", () => {
    // Bewezen tegen de echte database: het origineel staat in 2026, de
    // vervangende betaling in 2027, en de storno wordt in 2027 geboekt. Omdat
    // de storno-index ORGANISATIEBREED is, ziet 2026 die storno wel degelijk.
    const idx = reversalIndex([{ source: "p1", correction: "p2" }]);
    const sel2026 = selectFiscalYears([A], [fy("f26", A, 2026)], "2026-06-01");
    const sel2027 = selectFiscalYears([A], [fy("f27", A, 2027)], "2027-06-01");
    const rijen = [
      { id: "p1", amount: 1000, building_id: A, value_date: "2026-12-15" },
      { id: "p2", amount: 800, building_id: A, value_date: "2027-01-05" },
    ];

    const in2026 = filterToSelectedFiscalYear(rijen, sel2026);
    const in2027 = filterToSelectedFiscalYear(rijen, sel2027);
    expect(in2026.map((r) => r.id)).toEqual(["p1"]);
    expect(in2027.map((r) => r.id)).toEqual(["p2"]);

    // 2026 telt niets, want p1 is gestorneerd. 2027 telt de vervanging.
    expect(
      computeKpis({ settlements: [], payments: in2026, expenses: [], reversals: idx }).encaisse,
    ).toBe(0);
    expect(
      computeKpis({ settlements: [], payments: in2027, expenses: [], reversals: idx }).encaisse,
    ).toBe(800);
  });
});

// ── AANSLUITING GROOTBOEK 4111 ──────────────────────────────────────────────

/**
 * De koppeling die de pagina uit `charge_calls` bouwt: oproep → boekjaar.
 * Oproep A hoort bij boekjaar 1, oproep B bij boekjaar 2.
 */
const oproepen = new Map([
  [CALL_A, FY1],
  [CALL_B, FY2],
]);

describe("R — aansluiting grootboek 4111 wordt pas geteld als hij is vastgesteld", () => {
  it("R1 — geen vorderingen en geen rij: nul, en geen onbeschikbaarheidsmelding", () => {
    const uitkomst = evaluateReconciliation({
      rows: [],
      settlements: [],
      chargeCallFiscalYear: oproepen,
    });
    expect(uitkomst).toBe(0);
    expect(
      buildAttentionItems({ ...gezond, reconciliatieVerschil: uitkomst }).some(
        (i) => i.labelKey === "integrityUnavailable",
      ),
    ).toBe(false);
  });

  it("R2 — vorderingen met een sluitende rij: de controle geldt als uitgevoerd", () => {
    const uitkomst = evaluateReconciliation({
      rows: [{ fiscal_year_id: FY1, verschil: 0 }],
      settlements: [alloc()],
      chargeCallFiscalYear: oproepen,
    });
    expect(uitkomst).toBe(0);
    expect(buildAttentionItems({ ...gezond, reconciliatieVerschil: uitkomst })).toEqual([]);
  });

  it("R3 — vorderingen ZONDER rij is niet nul maar onbekend", () => {
    // De kern van de bevinding. `v_reconciliation_4111` begint bij de
    // chargejournaalposten en joint door naar rekening 4111; een boekjaar met
    // vorderingen maar zonder zo'n journaalregel levert dus GEEN rij. Optellen
    // maakte daar stilletjes nul van, en nul leest als "de boekhouding sluit
    // aan" terwijl er juist een vordering zonder tegenhanger staat.
    const uitkomst = evaluateReconciliation({
      rows: [],
      settlements: [alloc()],
      chargeCallFiscalYear: oproepen,
    });
    expect(uitkomst).toBeNull();
    const items = buildAttentionItems({ ...gezond, reconciliatieVerschil: uitkomst });
    const melding = items.find((i) => i.labelKey === "integrityUnavailable");
    expect(melding).toBeDefined();
    expect(melding?.tone).toBe("crit");
  });

  it("R4 — twee boekjaren met vorderingen en maar één rij: onbekend", () => {
    expect(
      evaluateReconciliation({
        rows: [{ fiscal_year_id: FY1, verschil: 0 }],
        settlements: [alloc(), alloc({ charge_call_id: CALL_B })],
        chargeCallFiscalYear: oproepen,
      }),
    ).toBeNull();
  });

  it("R5 — volledige dekking telt de ABSOLUTE verschillen op", () => {
    // Tegengestelde afwijkingen mogen elkaar niet opheffen: +120 en -80 is een
    // afwijking van 200, geen gezonde 40.
    expect(
      evaluateReconciliation({
        rows: [
          { fiscal_year_id: FY1, verschil: 120 },
          { fiscal_year_id: FY2, verschil: -80 },
        ],
        settlements: [alloc(), alloc({ charge_call_id: CALL_B })],
        chargeCallFiscalYear: oproepen,
      }),
    ).toBe(200);
  });

  it("R6 — een mislukte query is nooit nul", () => {
    expect(
      evaluateReconciliation({
        rows: null,
        settlements: [alloc()],
        chargeCallFiscalYear: oproepen,
      }),
    ).toBeNull();
    // Ook zonder enige vordering blijft een mislukte query onbekend: er is dan
    // niets vastgesteld, en dat is iets anders dan niets gevonden.
    expect(
      evaluateReconciliation({ rows: null, settlements: [], chargeCallFiscalYear: oproepen }),
    ).toBeNull();
  });

  it("R7 — een sluitende rij voor een boekjaar zonder vorderingen verandert niets", () => {
    const zonder = evaluateReconciliation({
      rows: [{ fiscal_year_id: FY1, verschil: 0 }],
      settlements: [alloc()],
      chargeCallFiscalYear: oproepen,
    });
    const met = evaluateReconciliation({
      rows: [
        { fiscal_year_id: FY1, verschil: 0 },
        { fiscal_year_id: FY2, verschil: 0 },
      ],
      settlements: [alloc()],
      chargeCallFiscalYear: oproepen,
    });
    expect(met).toBe(zonder);
    expect(met).toBe(0);
  });

  it("R7b — een SCHEVE rij voor een boekjaar zonder vorderingen wordt wél gemeld", () => {
    // Bewust strenger dan R7. De rijen zijn in de query al tot de geselecteerde
    // boekjaren beperkt, en een verschil daarbinnen is altijd een echte breuk:
    // 4111-chargeregels zonder ook maar één allocatie betekent dat het grootboek
    // lasten kent die de vorderingenadministratie niet heeft. Zo'n rij
    // wegfilteren omdat er toevallig geen vordering tegenover staat, zou
    // dezelfde blindheid herintroduceren die R3 wegneemt.
    expect(
      evaluateReconciliation({
        rows: [
          { fiscal_year_id: FY1, verschil: 0 },
          { fiscal_year_id: FY2, verschil: 500 },
        ],
        settlements: [alloc()],
        chargeCallFiscalYear: oproepen,
      }),
    ).toBe(500);
  });

  it("R8 — een vordering zonder herleidbaar boekjaar maakt de dekking onbewijsbaar", () => {
    // Kolom ontbreekt in het antwoord.
    expect(
      evaluateReconciliation({
        rows: [{ fiscal_year_id: FY1, verschil: 0 }],
        settlements: [alloc({ charge_call_id: null })],
        chargeCallFiscalYear: oproepen,
      }),
    ).toBeNull();
    // Oproep die niet in de opgehaalde koppeling voorkomt.
    expect(
      evaluateReconciliation({
        rows: [{ fiscal_year_id: FY1, verschil: 0 }],
        settlements: [alloc({ charge_call_id: "ca110000-0000-0000-0000-0000000000ff" })],
        chargeCallFiscalYear: oproepen,
      }),
    ).toBeNull();
  });

  it("R9 — leeg antwoord en mislukte query lopen niet door elkaar", () => {
    expect(
      evaluateReconciliation({ rows: [], settlements: [], chargeCallFiscalYear: oproepen }),
    ).toBe(0);
    expect(
      evaluateReconciliation({ rows: null, settlements: [], chargeCallFiscalYear: oproepen }),
    ).toBeNull();
  });

  it("R10 — numerieke tekst uit de view telt gewoon mee", () => {
    // PostgREST levert `numeric` als string.
    expect(
      evaluateReconciliation({
        rows: [{ fiscal_year_id: FY1, verschil: "-12.34" }],
        settlements: [alloc()],
        chargeCallFiscalYear: oproepen,
      }),
    ).toBe(12.34);
  });

  it("R11 — een rij zonder boekjaar dekt niets af", () => {
    expect(
      evaluateReconciliation({
        rows: [{ fiscal_year_id: null, verschil: 0 }],
        settlements: [alloc()],
        chargeCallFiscalYear: oproepen,
      }),
    ).toBeNull();
  });
});

// ── GERENDERDE MELDINGEN ────────────────────────────────────────────────────

/**
 * Rendert een vertaalsleutel met de ECHTE ICU-pipeline van next-intl.
 *
 * Niet met een eigen nabootsing: juist de pluralisatie is wat misging, en die
 * is alleen te controleren met de formatter die in productie draait.
 */
const maakVertaler = createTranslator as unknown as (opties: {
  locale: string;
  messages: unknown;
  namespace: string;
}) => (sleutel: string, waarden?: Record<string, string | number>) => string;

const talen: Record<string, unknown> = { fr, nl, ar };

function tekst(
  locale: string,
  sleutel: string,
  waarden?: Record<string, string | number>,
): string {
  return maakVertaler({
    locale,
    messages: talen[locale],
    namespace: "dashboard.attention",
  })(sleutel, waarden);
}

describe("M — melding over gebouwen met meerdere open boekjaren", () => {
  function melding(aantalGebouwen: number, locale: string): string {
    const item = buildAttentionItems({
      ...gezond,
      buildingsWithMultipleOpen: aantalGebouwen,
    }).find((i) => i.labelKey === "buildingsWithMultipleOpenFiscalYears");
    if (!item) throw new Error("melding ontbreekt");
    return tekst(locale, item.labelKey, item.values);
  }

  it("M8 — één gebouw levert een enkelvoudszin over GEBOUWEN op", () => {
    const zin = melding(1, "nl");
    // De bevinding: het getal telde gebouwen, de zin sprak over boekjaren, en
    // er was alleen een `other`-tak. Resultaat: "Er staan 1 boekjaren open".
    expect(zin).not.toMatch(/1 boekjaren/);
    expect(zin).toContain("1 gebouw ");
    expect(zin).toContain("heeft meerdere open boekjaren");
  });

  it("M9 — twee gebouwen leveren de meervoudsvorm op", () => {
    const zin = melding(2, "nl");
    expect(zin).toContain("2 gebouwen");
    expect(zin).toContain("hebben meerdere open boekjaren");
  });

  it("M9b — het getal blijft het aantal GEBOUWEN, niet het aantal boekjaren", () => {
    // Eén gebouw met drie open boekjaren telt als één gebouw.
    const sel = selectFiscalYears(
      [A],
      [fy("f1", A, 2024), fy("f2", A, 2025), fy("f3", A, 2026)],
      "2026-06-01",
    );
    expect(sel.buildingsWithMultipleOpen).toEqual([A]);
    const item = buildAttentionItems({
      ...gezond,
      buildingsWithMultipleOpen: sel.buildingsWithMultipleOpen.length,
    }).find((i) => i.labelKey === "buildingsWithMultipleOpenFiscalYears");
    expect(item?.values).toEqual({ count: 1 });
    expect(melding(1, "fr")).toContain("1 immeuble ");
  });

  it("M10 — de ICU-vormen zijn geldig in fr, nl en ar voor 0, 1, 2, 3 en 11", () => {
    const sleutels = ["buildingsWithMultipleOpenFiscalYears", "periodExcludesToday"];
    for (const locale of Object.keys(talen)) {
      for (const sleutel of sleutels) {
        for (const count of [0, 1, 2, 3, 11]) {
          const uit = tekst(locale, sleutel, { count });
          const waar = `${locale} ${sleutel} ${count}`;
          expect(uit.length, waar).toBeGreaterThan(0);
          // Een niet-afgehandelde tak laat de ICU-syntaxis staan.
          expect(uit, waar).not.toContain("{");
          expect(uit, waar).not.toContain("plural");
        }
      }
    }
  });

  it("M10b — het Arabisch gebruikt de dualis bij twee gebouwen", () => {
    expect(tekst("ar", "buildingsWithMultipleOpenFiscalYears", { count: 2 })).toContain(
      "عمارتان",
    );
    expect(tekst("ar", "periodExcludesToday", { count: 2 })).toContain("عمارتين");
    // En Latijnse cijfers vanaf drie, net als de rest van het dashboard.
    expect(tekst("ar", "buildingsWithMultipleOpenFiscalYears", { count: 3 })).toContain("3");
  });
});

// ── PEILDATUM BUITEN HET GETOONDE BOEKJAAR ──────────────────────────────────

describe("P — het getoonde boekjaar omvat de peildatum niet", () => {
  it("P11 — een boekjaar dat de peildatum omvat geeft geen waarschuwing", () => {
    const sel = selectFiscalYears([A], [fy("f1", A, 2026)], "2026-09-02");
    expect(sel.buildingsOutsideReferenceDate).toEqual([]);
    expect(
      buildAttentionItems({ ...gezond, buildingsOutsideReferenceDate: 0 }).some(
        (i) => i.labelKey === "periodExcludesToday",
      ),
    ).toBe(false);
  });

  it("P12 — een TOEKOMSTIG open boekjaar wordt gekozen én gemarkeerd", () => {
    // Exact de productiesituatie op 2 september 2026: het enige boekjaar loopt
    // van 1 oktober tot en met 31 december en staat open.
    const sel = selectFiscalYears(
      [A],
      [fy("f1", A, 2026, "open", "2026-10-01", "2026-12-31")],
      "2026-09-02",
    );
    // De keuzevolgorde blijft ongewijzigd: regel 2 kiest dit jaar.
    expect(sel.selected[0].fiscalYear.id).toBe("f1");
    expect(sel.buildingsOutsideReferenceDate).toEqual([A]);

    const item = buildAttentionItems({
      ...gezond,
      buildingsOutsideReferenceDate: 1,
    }).find((i) => i.labelKey === "periodExcludesToday");
    expect(item?.tone).toBe("warn");
    expect(item?.values).toEqual({ count: 1 });
  });

  it("P13 — een VERLOPEN maar nog open boekjaar wordt gemarkeerd", () => {
    const sel = selectFiscalYears(
      [A],
      [fy("f1", A, 2025, "open", "2025-01-01", "2025-12-31")],
      "2026-09-02",
    );
    expect(sel.selected[0].fiscalYear.id).toBe("f1");
    expect(sel.buildingsOutsideReferenceDate).toEqual([A]);
  });

  it("P14 — een AFGESLOTEN boekjaar als laatste terugval wordt gemarkeerd", () => {
    const sel = selectFiscalYears(
      [A],
      [fy("f1", A, 2025, "closed", "2025-01-01", "2025-12-31")],
      "2026-09-02",
    );
    expect(sel.selected[0].fiscalYear.status).toBe("closed");
    expect(sel.buildingsOutsideReferenceDate).toEqual([A]);
  });

  it("P15 — met twee gebouwen telt alleen het gebouw zonder passende periode", () => {
    const sel = selectFiscalYears(
      [A, B],
      [
        fy("fa", A, 2026, "open", "2026-01-01", "2026-12-31"), // omvat de peildatum
        fy("fb", B, 2026, "open", "2026-10-01", "2026-12-31"), // begint later
      ],
      "2026-09-02",
    );
    expect(sel.selected).toHaveLength(2);
    expect(sel.buildingsOutsideReferenceDate).toEqual([B]);
    expect(
      buildAttentionItems({
        ...gezond,
        buildingsOutsideReferenceDate: sel.buildingsOutsideReferenceDate.length,
      }).find((i) => i.labelKey === "periodExcludesToday")?.values,
    ).toEqual({ count: 1 });
  });

  it("P15b — de randdatums zelf vallen binnen de periode", () => {
    const jaren = [fy("f1", A, 2026, "open", "2026-10-01", "2026-12-31")];
    expect(selectFiscalYears([A], jaren, "2026-10-01").buildingsOutsideReferenceDate).toEqual([]);
    expect(selectFiscalYears([A], jaren, "2026-12-31").buildingsOutsideReferenceDate).toEqual([]);
    expect(selectFiscalYears([A], jaren, "2026-09-30").buildingsOutsideReferenceDate).toEqual([A]);
    expect(selectFiscalYears([A], jaren, "2027-01-01").buildingsOutsideReferenceDate).toEqual([A]);
  });

  it("P16 — de waarschuwing verandert geen bedrag en geen filter", () => {
    const sel = selectFiscalYears(
      [A],
      [fy("f1", A, 2026, "open", "2026-10-01", "2026-12-31")],
      "2026-09-02",
    );
    expect(sel.buildingsOutsideReferenceDate).toEqual([A]);

    const betalingen = [
      { id: "p1", amount: 500, building_id: A, value_date: "2026-09-02" }, // vandaag, buiten
      { id: "p2", amount: 300, building_id: A, value_date: "2026-11-15" }, // binnen
    ];
    // Onveranderd gedrag: het filter blijft de periode volgen, niet de melding.
    expect(filterToSelectedFiscalYear(betalingen, sel).map((p) => p.id)).toEqual(["p2"]);

    const uitgaven = [{ id: "e1", amount: 100, building_id: A }];
    const kpi = computeKpis({
      settlements: [alloc({ amount: 1000, settled_amount: 300 })],
      payments: filterToSelectedFiscalYear(betalingen, sel),
      expenses: uitgaven,
      reversals: emptyReversalIndex(),
    });
    expect(kpi.encaisse).toBe(300);
    expect(kpi.appele).toBe(1000);
    expect(kpi.restant).toBe(700);
    expect(kpi.depenses).toBe(100);
  });

  it("P17 — de nieuwe sleutel bestaat en pluraliseert in fr, nl en ar", () => {
    for (const [naam, berichten] of Object.entries(talen)) {
      const attention = (
        (berichten as Record<string, Record<string, unknown>>).dashboard as Record<
          string,
          unknown
        >
      ).attention as Record<string, unknown>;
      const waarde = attention.periodExcludesToday;
      expect(typeof waarde, `periodExcludesToday ontbreekt in ${naam}`).toBe("string");
      expect(waarde as string, naam).toContain("{count, plural,");
      // Geen technische termen op het scherm.
      expect(waarde as string, naam).not.toMatch(/4111|v_|fiscal_year|peildatum/i);
    }
  });
});

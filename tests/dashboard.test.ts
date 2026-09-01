import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildReversalIndex, emptyReversalIndex } from "@/lib/reversal";
import {
  buildAttentionItems,
  computeKpis,
  pickFiscalYear,
  quickActions,
  recentActivity,
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

function alloc(over: Partial<SettlementRow> = {}): SettlementRow {
  return {
    charge_allocation_id: crypto.randomUUID(),
    building_id: A,
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

  /**
   * D13 — rijen van een andere tenant komen niet binnen.
   *
   * RLS scoopt op LIDMAATSCHAP en laat dus alle organisaties van de gebruiker
   * door; `requireOrg()` kiest er één. Elke dashboardquery moet daarom ook
   * expliciet op die organisatie filteren. Deze test leest de broncode, want
   * een gemiste filter is precies het soort fout dat een rendertest niet ziet.
   */
  it("D13 — elke dashboardquery filtert expliciet op de actieve organisatie", () => {
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "dashboard", "page.tsx"),
      "utf8",
    );
    const queries = bron.match(/\.from\("([a-z_]+)"\)/g) ?? [];
    const orgFilters = bron.match(/\.eq\("organization_id", org\.id\)/g) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    // Elke .from(...) hoort een organisatiefilter te krijgen.
    expect(orgFilters.length).toBeGreaterThanOrEqual(queries.length);
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
      { id: "f1", building_id: A, year: 2025, start_date: "2025-01-01", end_date: "2025-12-31", status: "closed" },
      { id: "f2", building_id: A, year: 2026, start_date: "2026-01-01", end_date: "2026-12-31", status: "closed" },
    ];
    const ctx = pickFiscalYear(jaren, "2026-06-01");
    expect(ctx.huidig?.year).toBe(2026);
    expect(ctx.aantalOpen).toBe(0);
    expect(ctx.meerdereOpen).toBe(false);
  });

  it("zonder enig boekjaar is er geen context", () => {
    expect(pickFiscalYear([], "2026-06-01").huidig).toBeNull();
  });

  it("kiest het open boekjaar waarin vandaag valt", () => {
    const jaren: FiscalYearRow[] = [
      { id: "f1", building_id: A, year: 2025, start_date: "2025-01-01", end_date: "2025-12-31", status: "open" },
      { id: "f2", building_id: A, year: 2026, start_date: "2026-01-01", end_date: "2026-12-31", status: "open" },
    ];
    const ctx = pickFiscalYear(jaren, "2025-06-01");
    expect(ctx.huidig?.year).toBe(2025);
    expect(ctx.meerdereOpen).toBe(true);
    expect(ctx.aantalOpen).toBe(2);
  });
});

// ── AANDACHTSPUNTEN ─────────────────────────────────────────────────────────

const gezond = {
  restant: 0,
  aantalDebiteuren: 0,
  zonderEigenaar: 0,
  settlementNok: 0,
  allocationNok: 0,
  reconciliatieVerschil: 0,
  meerdereOpenBoekjaren: 1,
  buildingHref: null,
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

  it("waarschuwt bij meerdere open boekjaren", () => {
    const items = buildAttentionItems({ ...gezond, meerdereOpenBoekjaren: 2 });
    expect(items.some((i) => i.labelKey === "multipleOpenFiscalYears")).toBe(true);
  });

  it("toont nooit een interne view- of tabelnaam", () => {
    const items = buildAttentionItems({
      restant: 900,
      aantalDebiteuren: 3,
      zonderEigenaar: 100,
      settlementNok: 1,
      allocationNok: 1,
      reconciliatieVerschil: 5,
      meerdereOpenBoekjaren: 2,
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
      "title", "fiscalYear", "netUnavailable", "multipleOpenBadge",
      "status.open", "status.closed",
      "kpi.called", "kpi.collected", "kpi.outstanding", "kpi.expenses", "kpi.recovery",
      "kpi.recoveryNone", "kpi.sectionTitle",
      "attention.title", "attention.open", "attention.outstanding",
      "attention.settlementMismatch", "attention.allocationMismatch",
      "attention.reconciliationMismatch", "attention.allocationWithoutOwner",
      "attention.multipleOpenFiscalYears",
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
      "attention.multipleOpenFiscalYears",
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

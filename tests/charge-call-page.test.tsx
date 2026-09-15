// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * FAIL-CLOSED op het boekjaarscherm.
 *
 * Een mislukte query mag NOOIT als lege of gezonde data doorgaan. "Nul lots
 * zonder eigenaar" ziet er precies zo uit als "de eigendomsquery faalde", en op
 * dat verschil hangt een financiële handeling die vorderingen en journaalregels
 * aanmaakt. Faalt één van de bronnen waarop de controle vóór aanmaken steunt,
 * dan verschijnt er GEEN aanmaakformulier en GEEN groene gereedmelding, maar
 * een foutmelding.
 *
 * Deze suite draait elke bron één keer stuk en eist elke keer dezelfde uitkomst.
 */

const BLD = "11111111-1111-1111-1111-111111111111";
const FY = "44444444-4444-4444-4444-444444444444";

type Resultaat = { data: unknown; error: unknown };

const state: {
  rol: string;
  tabellen: Record<string, Resultaat>;
  /** Elke tabel die de pagina aanraakt, in volgorde. */
  bevraagd: string[];
} = { rol: "manager", tabellen: {}, bevraagd: [] };

/** Eén vastgelegde oproep, zoals de pagina hem uit de database krijgt. */
function oproep(over: Record<string, unknown> = {}) {
  return {
    id: "cc-1",
    type: "regulier",
    period: "T2 2026",
    label: "Entretien",
    total_amount: 1000,
    call_date: "2026-06-30",
    due_date: "2026-07-31",
    alloc_method: "tantieme",
    alloc_scope: "whole_building",
    alloc_rule_label: "Charges générales",
    alloc_unit_count: 2,
    alloc_partial_denominator: false,
    charge_allocations: [],
    ...over,
  };
}

function standaardTabellen(): Record<string, Resultaat> {
  return {
    buildings: { data: { id: BLD, name: "Résidence Atlas", total_tantiemes: 100 }, error: null },
    fiscal_years: {
      data: { id: FY, building_id: BLD, year: 2026, status: "open", start_date: "2026-01-01", end_date: "2026-12-31" },
      error: null,
    },
    charge_calls: { data: [], error: null },
    units: { data: [{ id: "u1", building_id: BLD, label: "A1", tantiemes: 100, block_id: null }], error: null },
    allocation_rules: {
      data: [
        {
          id: "r1",
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
        },
      ],
      error: null,
    },
    allocation_rule_units: { data: [], error: null },
    allocation_rule_weights: { data: [], error: null },
    ownership: {
      data: [
        {
          id: "own-1",
          unit_id: "u1",
          owner_id: "o1",
          share: 1,
          start_date: "2026-01-01",
          end_date: null,
          is_primary_debtor: true,
          owners: { id: "o1", full_name: "Youssef El Amrani" },
        },
      ],
      error: null,
    },
    charge_call_lines: { data: [], error: null },
    payments: { data: [], error: null },
    journal_entries: { data: [], error: null },
  };
}

/** Chainable én awaitable: de pagina gebruikt beide vormen. */
function keten(resultaat: Resultaat) {
  const c: Record<string, unknown> = {};
  const zelf = () => c;
  Object.assign(c, {
    select: zelf,
    eq: zelf,
    in: zelf,
    is: zelf,
    not: zelf,
    order: zelf,
    limit: zelf,
    maybeSingle: async () => resultaat,
    then: (res: (v: Resultaat) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resultaat).then(res, rej),
  });
  return c;
}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("@/lib/org", () => ({
  requireOrg: async () => ({ role: state.rol, org: { id: "org-1", name: "Org" } }),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => (key: string) =>
    namespace ? `${namespace}.${key}` : key,
  getLocale: async () => "fr",
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabel: string) => {
      state.bevraagd.push(tabel);
      return keten(state.tabellen[tabel] ?? { data: [], error: null });
    },
  }),
}));

vi.mock("@/lib/reversal", () => ({
  fetchReversalIndex: async () => new Map(),
  reversalOf: () => null,
  correctionOf: () => null,
}));

vi.mock("@/components/ActionForm", () => ({
  default: ({ children }: { children: React.ReactNode }) => <form>{children}</form>,
}));

vi.mock("@/components/PaymentReversalActions", () => ({
  default: () => <div data-testid="payment-reversal" />,
}));

vi.mock(
  "@/app/[locale]/(app)/buildings/[id]/boekjaren/[fy_id]/ChargeCallWorkflow",
  () => ({
    default: () => <div data-testid="workflow" />,
  }),
);

vi.mock("@/app/[locale]/(app)/buildings/[id]/boekjaren/actions", () => ({
  createPayment: async () => undefined,
  createChargeCall: async () => undefined,
}));

const { default: FiscalYearDetail } = await import(
  "@/app/[locale]/(app)/buildings/[id]/boekjaren/[fy_id]/page"
);

async function toonPagina() {
  const element = await FiscalYearDetail({
    params: Promise.resolve({ locale: "fr", id: BLD, fy_id: FY }),
  });
  return render(element);
}

/** De bronnen waarop de controle vóór aanmaken steunt. */
const WORKFLOW_BRONNEN = [
  "units",
  "allocation_rules",
  "allocation_rule_units",
  "allocation_rule_weights",
  "ownership",
] as const;

beforeEach(() => {
  state.rol = "manager";
  state.tabellen = standaardTabellen();
  state.bevraagd = [];
});

afterEach(() => {
  cleanup();
});

describe("FC — fail-closed per bron", () => {
  it("FC1 — met gezonde bronnen verschijnt de workflow", async () => {
    await toonPagina();
    expect(screen.getByTestId("workflow")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(WORKFLOW_BRONNEN)(
    "FC2 — een queryfout op %s blokkeert het aanmaken",
    async (tabel) => {
      state.tabellen[tabel] = { data: null, error: { message: "boom" } };
      await toonPagina();

      expect(screen.queryByTestId("workflow"), tabel).toBeNull();
      const melding = screen.getByTestId("workflow-error");
      expect(melding.textContent).toContain("charges.errors.generic");
      // Nooit de databasetekst zelf.
      expect(melding.textContent).not.toContain("boom");
    },
  );

  it("FC3 — een lege maar geslaagde query is GEEN fout: de workflow blijft staan", async () => {
    state.tabellen.ownership = { data: [], error: null };
    state.tabellen.units = { data: [], error: null };
    await toonPagina();
    expect(screen.getByTestId("workflow")).toBeTruthy();
  });

  it("FC4 — een fout in een workflowbron verbergt de vastgelegde oproepen niet", async () => {
    // De twee poorten staan los van elkaar. Wie het formulier niet mag zien
    // omdat de gewichten ontbreken, heeft nog steeds recht op de cijfers die
    // al betrouwbaar in de database staan.
    state.tabellen.charge_calls = { data: [oproep()], error: null };
    state.tabellen.allocation_rule_weights = { data: null, error: { message: "boom" } };

    const { container } = await toonPagina();
    expect(screen.queryByTestId("workflow")).toBeNull();
    expect(screen.getByTestId("workflow-error")).toBeTruthy();

    // De oproep staat er gewoon, met bedrag en aantal.
    expect(screen.queryByTestId("calls-error")).toBeNull();
    const tekst = container.textContent ?? "";
    expect(tekst).toContain("Entretien");
    expect(tekst).toMatch(/charges\.title \(1\)/);
  });
});

describe("RB — rolgebonden zichtbaarheid", () => {
  it("RB1 — een viewer ziet geen aanmaakactie", async () => {
    state.rol = "viewer";
    await toonPagina();
    expect(screen.queryByTestId("workflow")).toBeNull();
    // En ook geen foutmelding: er is niets mis, hij mag alleen niet aanmaken.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("RB2 — elke schrijfrol ziet de aanmaakactie wel", async () => {
    for (const rol of ["owner", "admin", "manager", "accountant"]) {
      cleanup();
      state.rol = rol;
      state.tabellen = standaardTabellen();
      await toonPagina();
      expect(screen.getByTestId("workflow"), rol).toBeTruthy();
    }
  });

  it("RB3 — een gesloten boekjaar toont geen aanmaakactie", async () => {
    state.tabellen.fiscal_years = {
      data: { id: FY, building_id: BLD, year: 2026, status: "closed", start_date: "2026-01-01", end_date: "2026-12-31" },
      error: null,
    };
    await toonPagina();
    expect(screen.queryByTestId("workflow")).toBeNull();
  });
});

describe("SC — het boekjaar moet bij het gebouw uit de URL horen", () => {
  /** Alles wat financieel dragend is en dus niet mag worden aangeraakt. */
  const FINANCIEEL = [
    "charge_calls",
    "charge_call_lines",
    "units",
    "allocation_rules",
    "allocation_rule_units",
    "allocation_rule_weights",
    "ownership",
    "payments",
    "journal_entries",
  ];

  it("SC1 — een gebouw met zijn EIGEN boekjaar rendert gewoon", async () => {
    await toonPagina();
    expect(screen.getByTestId("workflow")).toBeTruthy();
  });

  it("SC2 — een boekjaar van een ANDER gebouw geeft notFound", async () => {
    state.tabellen.fiscal_years = {
      data: {
        id: FY,
        building_id: "99999999-9999-9999-9999-999999999999",
        year: 2026,
        status: "open",
        start_date: "2026-01-01",
        end_date: "2026-12-31",
      },
      error: null,
    };
    await expect(toonPagina()).rejects.toThrow("NOT_FOUND");
  });

  it("SC3 — bij die mismatch wordt geen enkele financiële bron bevraagd", async () => {
    state.tabellen.fiscal_years = {
      data: {
        id: FY,
        building_id: "99999999-9999-9999-9999-999999999999",
        year: 2026,
        status: "open",
        start_date: "2026-01-01",
        end_date: "2026-12-31",
      },
      error: null,
    };
    await expect(toonPagina()).rejects.toThrow("NOT_FOUND");

    for (const tabel of FINANCIEEL) {
      expect(state.bevraagd, tabel).not.toContain(tabel);
    }
    // Alleen de twee lookups die de scope zelf vaststellen.
    expect(new Set(state.bevraagd)).toEqual(new Set(["buildings", "fiscal_years"]));
  });

  it("SC4 — een onbekend boekjaar of gebouw blijft notFound", async () => {
    state.tabellen.fiscal_years = { data: null, error: null };
    await expect(toonPagina()).rejects.toThrow("NOT_FOUND");

    state.tabellen = standaardTabellen();
    state.tabellen.buildings = { data: null, error: null };
    await expect(toonPagina()).rejects.toThrow("NOT_FOUND");
  });
});

describe("DV — definitieve verdeling", () => {
  it("DV1 — bedragen komen uit charge_call_lines, niet uit een herberekening", async () => {
    state.tabellen.charge_calls = {
      data: [
        {
          id: "cc-1",
          type: "regulier",
          period: "T2 2026",
          label: "Entretien",
          total_amount: 1000,
          call_date: "2026-06-30",
          due_date: "2026-07-31",
          alloc_method: "tantieme",
          alloc_scope: "whole_building",
          alloc_rule_label: "Charges générales",
          alloc_unit_count: 2,
          alloc_partial_denominator: false,
          charge_allocations: [],
        },
      ],
      error: null,
    };
    state.tabellen.charge_call_lines = {
      data: [
        { charge_call_id: "cc-1", unit_id: "u1", amount_cents: 66667, units: { label: "A1" } },
        { charge_call_id: "cc-1", unit_id: "u2", amount_cents: 33333, units: { label: "A2" } },
      ],
      error: null,
    };

    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    // 666,67 en 333,33 — exact de opgeslagen centen, inclusief de restcent.
    expect(tekst).toMatch(/666[.,]67/);
    expect(tekst).toMatch(/333[.,]33/);
    expect(tekst).toContain("charges.result.source");
  });
});

// ── BLOKKER 1: de financiële weergave is fail-closed ────────────────────────

/**
 * Een mislukte financiële query mag NOOIT als een betrouwbaar nulbedrag of een
 * lege lijst worden getoond. "0 MAD appelés" en "geen oproepen" zijn beweringen
 * over geld; als de query faalde, kunnen we die niet waarmaken.
 *
 * Deze suite eist per financiële bron: een zichtbare foutmelding, GEEN nul,
 * GEEN aantal en GEEN lege-lijstmelding — en dat los van rol en boekjaarstatus,
 * want een leesrol en een gesloten boekjaar lezen dezelfde cijfers.
 */
describe("FF — fail-closed financiële weergave", () => {
  const STUK = { data: null, error: { message: "boom" } };

  /** Wat er op het scherm mag staan als de oproepen niet geladen zijn. */
  function geenOproepbeweringen(tekst: string) {
    expect(tekst).toContain("charges.errors.callsUnavailable");
    // Geen totaal, in geen enkele opmaak.
    expect(tekst).not.toMatch(/MAD appelés/);
    // Geen aantal achter de kop.
    expect(tekst).not.toMatch(/charges\.title \(/);
    // En vooral niet: "er zijn geen oproepen".
    expect(tekst).not.toContain("charges.noCharges");
    // Nooit de databasetekst zelf.
    expect(tekst).not.toContain("boom");
  }

  it("FF1 — een queryfout op charge_calls meldt de fout, als manager", async () => {
    state.tabellen.charge_calls = STUK;
    const { container } = await toonPagina();
    expect(screen.getByTestId("calls-error")).toBeTruthy();
    geenOproepbeweringen(container.textContent ?? "");
  });

  it("FF2 — diezelfde fout is ook voor een viewer zichtbaar", async () => {
    // De melding mag niet achter schrijfrecht verstopt zitten: wie alleen
    // leest, leest juist deze cijfers.
    state.rol = "viewer";
    state.tabellen.charge_calls = STUK;
    const { container } = await toonPagina();
    expect(screen.getByTestId("calls-error")).toBeTruthy();
    expect(screen.queryByTestId("workflow")).toBeNull();
    geenOproepbeweringen(container.textContent ?? "");
  });

  it("FF3 — en ook op een GESLOTEN boekjaar", async () => {
    state.tabellen.fiscal_years = {
      data: { id: FY, building_id: BLD, year: 2026, status: "closed", start_date: "2026-01-01", end_date: "2026-12-31" },
      error: null,
    };
    state.tabellen.charge_calls = STUK;
    const { container } = await toonPagina();
    expect(screen.getByTestId("calls-error")).toBeTruthy();
    geenOproepbeweringen(container.textContent ?? "");
  });

  it("FF4 — een GESLAAGDE lege query blijft gewoon de lege toestand", async () => {
    // Het verschil dat deze hele suite bewaakt: leeg is niet hetzelfde als stuk.
    state.tabellen.charge_calls = { data: [], error: null };
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(screen.queryByTestId("calls-error")).toBeNull();
    expect(tekst).toContain("charges.noCharges");
    expect(tekst).toMatch(/charges\.title \(0\)/);
  });

  it("FF5 — een fout op charge_call_lines zegt niet 'geen regels'", async () => {
    state.tabellen.charge_calls = { data: [oproep()], error: null };
    state.tabellen.charge_call_lines = STUK;

    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(screen.getByTestId("lines-error")).toBeTruthy();
    expect(tekst).toContain("charges.result.unavailable");
    expect(tekst).not.toContain("charges.result.noLines");
    expect(tekst).not.toContain("boom");
    // De oproep zelf is wél betrouwbaar geladen en blijft staan.
    expect(tekst).toContain("Entretien");
    expect(screen.queryByTestId("calls-error")).toBeNull();
  });

  it("FF6 — een GESLAAGDE lege regelquery blijft 'geen regels'", async () => {
    state.tabellen.charge_calls = { data: [oproep()], error: null };
    state.tabellen.charge_call_lines = { data: [], error: null };
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(screen.queryByTestId("lines-error")).toBeNull();
    expect(tekst).toContain("charges.result.noLines");
  });

  it("FF7 — een fout op charge_allocations toont geen saldo van nul", async () => {
    state.tabellen.charge_calls = { data: [oproep()], error: null };
    state.tabellen.charge_allocations = STUK;

    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(screen.getByTestId("balance-error")).toBeTruthy();
    expect(tekst).toContain("charges.errors.balanceUnavailable");
    expect(tekst).not.toContain("Aucun appel ou propriétaire lié.");
    expect(tekst).not.toContain("boom");
  });

  it("FF8 — een onbetrouwbare oproeplijst maakt ook het saldo onbetrouwbaar", async () => {
    // Het saldo wordt uit de oproep-id's opgebouwd; zonder betrouwbare lijst is
    // "iedereen op nul" een bewering die we niet kunnen waarmaken.
    state.tabellen.charge_calls = STUK;
    const { container } = await toonPagina();
    expect(screen.getByTestId("balance-error")).toBeTruthy();
    expect(container.textContent ?? "").not.toContain("Aucun appel ou propriétaire lié.");
  });

  it("FF9 — een fout op payments toont geen 'Aucun paiement'", async () => {
    state.tabellen.payments = STUK;
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(screen.getByTestId("payments-error")).toBeTruthy();
    expect(tekst).toContain("charges.errors.paymentsUnavailable");
    expect(tekst).not.toContain("Aucun paiement.");
    expect(tekst).not.toContain("boom");
  });

  it("FF10 — elke financiële bron heeft zijn EIGEN melding", async () => {
    // Eén stukke bron mag de andere niet meeslepen: dat zou de gebruiker naar
    // de verkeerde oorzaak sturen.
    state.tabellen.charge_calls = { data: [oproep()], error: null };
    state.tabellen.payments = STUK;
    await toonPagina();
    expect(screen.getByTestId("payments-error")).toBeTruthy();
    expect(screen.queryByTestId("calls-error")).toBeNull();
    expect(screen.queryByTestId("lines-error")).toBeNull();
    expect(screen.queryByTestId("balance-error")).toBeNull();
    // En de aanmaakworkflow staat er nog: zijn eigen bronnen zijn gezond.
    expect(screen.getByTestId("workflow")).toBeTruthy();
  });
});

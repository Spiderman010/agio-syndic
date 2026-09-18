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

type ReversalRij = import("@/lib/reversal").ReversalViewRow;

const state: {
  rol: string;
  tabellen: Record<string, Resultaat>;
  /** Elke tabel die de pagina aanraakt, in volgorde. */
  bevraagd: string[];
  /** Het resultaat van `fetchReversalIndexResult()`; los injecteerbaar. */
  reversals: { rijen: ReversalRij[]; error: unknown };
} = { rol: "manager", tabellen: {}, bevraagd: [], reversals: { rijen: [], error: null } };

/**
 * Eén rij uit `charge_allocations`: de definitieve uitkomst van de
 * centverdeling voor één lot, zoals `fn_alloc_distribute` hem vastlegde.
 */
function allocatie(label: string, amountCents: number, over: Record<string, unknown> = {}) {
  return {
    id: `ca-${label}`,
    amount: amountCents / 100,
    amount_cents: amountCents,
    settled_amount: 0,
    owner_id: "o1",
    units: { label },
    owners: { full_name: "Youssef El Amrani" },
    ...over,
  };
}

/** Eén betaling zoals de pagina hem uit de database krijgt. */
function betaling(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    amount: 300,
    method: "virement",
    value_date: "2026-07-05",
    reference: "VIR-2026-001",
    owners: { full_name: "Youssef El Amrani" },
    payment_allocations: [],
    ...over,
  };
}

/** Eén rij uit `v_financial_reversals`: deze betaling is gestorneerd. */
function storno(over: Partial<ReversalRij> = {}): ReversalRij {
  return {
    reversal_id: "rev-1",
    source_type: "payment",
    source_id: "pay-1",
    correction_source_id: null,
    reason: "Dubbel geboekt door de syndic.",
    effective_date: "2026-07-10",
    is_correctie: false,
    is_correctie_vorig_boekjaar: false,
    ...over,
  };
}

/** Eén journaalpost van een betaling, in een boekjaar met deze status. */
function journaal(status: "open" | "closed", sourceId = "pay-1") {
  return { source_id: sourceId, fiscal_years: { status } };
}

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

/*
  De reversal-engine draait ECHT; alleen het ophalen is injecteerbaar.

  De oude mock gaf altijd `new Map()` terug - succes, altijd leeg, verkeerde
  vorm - en kon de foutklasse daardoor per definitie niet ontdekken. Nu wordt
  uitsluitend `fetchReversalIndexResult()` vervangen, en `buildReversalIndex`,
  `reversalOf` en `correctionOf` zijn de echte functies. Drie toestanden zijn
  los injecteerbaar:

    { rijen: [], error: null }        geslaagd en leeg  -> betrouwbaar leeg
    { rijen: [storno], error: null }  geslaagd met rij  -> markering zichtbaar
    { rijen: [], error: {...} }       mislukt           -> niets bewezen
*/
vi.mock("@/lib/reversal", async (importOriginal) => {
  const echt = await importOriginal<typeof import("@/lib/reversal")>();
  return {
    ...echt,
    fetchReversalIndexResult: async () => {
      const bron = state.reversals;
      if (bron.error) return { index: echt.emptyReversalIndex(), error: bron.error };
      return { index: echt.buildReversalIndex(bron.rijen), error: null };
    },
  };
});

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
  state.reversals = { rijen: [], error: null };
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
  it("DV1 — bedragen komen uit charge_allocations, niet uit een herberekening", async () => {
    // 666,67 + 333,33 is de verdeling MET de restcent, precies zoals
    // `fn_alloc_distribute` hem heeft vastgelegd. Het scherm rekent niets na.
    state.tabellen.charge_calls = {
      data: [
        oproep({
          total_amount: 1000,
          alloc_unit_count: 2,
          charge_allocations: [allocatie("A1", 66667), allocatie("A2", 33333)],
        }),
      ],
      error: null,
    };

    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(tekst).toMatch(/666[.,]67/);
    expect(tekst).toMatch(/333[.,]33/);
    expect(tekst).toContain("charges.result.source");
    expect(tekst).not.toContain("charges.result.noLines");
  });

  it("DV2 — een tantième-oproep ZONDER charge_call_lines toont gewoon zijn verdeling", async () => {
    // De kern van de reviewbevinding: m20 vult `charge_call_lines` alleen bij
    // `method = 'manual'`. Een tantième-, equal- of percentageoproep heeft daar
    // dus NUL rijen, terwijl de verdeling wel degelijk bestaat. Voorheen
    // meldde dit scherm daarom "geen vastgelegde regels" voor precies de
    // methoden die het meest worden gebruikt.
    state.tabellen.charge_call_lines = { data: [], error: null };
    state.tabellen.charge_calls = {
      data: [
        oproep({
          alloc_method: "tantieme",
          alloc_unit_count: 2,
          charge_allocations: [allocatie("A1", 60000), allocatie("A2", 40000)],
        }),
      ],
      error: null,
    };

    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(tekst).not.toContain("charges.result.noLines");
    expect(screen.queryByTestId("lines-error")).toBeNull();
    expect(tekst).toMatch(/600[.,]00/);
    expect(tekst).toMatch(/400[.,]00/);
  });

  it("DV3 — een onvolledige verdeling is GEEN definitief resultaat", async () => {
    // De engine bediende 3 lots (`alloc_unit_count`), we hebben er 2. Een
    // gedeeltelijke lijst tonen alsof hij definitief is, is precies het soort
    // stille financiële onwaarheid dat deze pagina moet uitsluiten.
    state.tabellen.charge_calls = {
      data: [
        oproep({
          alloc_unit_count: 3,
          charge_allocations: [allocatie("A1", 60000), allocatie("A2", 40000)],
        }),
      ],
      error: null,
    };

    const { container } = await toonPagina();
    const melding = screen.getByTestId("lines-error");
    expect(melding.getAttribute("role")).toBe("alert");
    expect(melding.textContent).toContain("charges.result.unavailable");
    const tekst = container.textContent ?? "";
    expect(tekst).not.toContain("charges.result.noLines");
    // En geen halve tabel met een bronvermelding erbij.
    expect(tekst).not.toContain("charges.result.source");
  });
});

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

  it("FF5 — een onvolledige verdeling zegt niet 'geen regels'", async () => {
    // De verdeling komt uit `charge_allocations`, dus uit dezelfde query als de
    // oproep zelf. Wat hier faalbaar blijft is de VOLLEDIGHEID ervan, en die
    // mag nooit als "geen regels" worden gepresenteerd.
    state.tabellen.charge_calls = {
      data: [oproep({ alloc_unit_count: 2, charge_allocations: [allocatie("A1", 100000)] })],
      error: null,
    };

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

  it("FF6 — een volledige verdeling toont de tabel zonder foutmelding", async () => {
    state.tabellen.charge_calls = {
      data: [
        oproep({
          alloc_unit_count: 2,
          charge_allocations: [allocatie("A1", 60000), allocatie("A2", 40000)],
        }),
      ],
      error: null,
    };
    const { container } = await toonPagina();
    expect(screen.queryByTestId("lines-error")).toBeNull();
    expect(container.textContent ?? "").toContain("charges.result.source");
  });

  it("FF7 — een fout op charge_allocations toont geen saldo van nul", async () => {
    state.tabellen.charge_calls = { data: [oproep()], error: null };
    state.tabellen.charge_allocations = STUK;

    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(screen.getByTestId("balance-error")).toBeTruthy();
    expect(tekst).toContain("charges.errors.balanceUnavailable");
    expect(tekst).not.toContain("saldo.noData");
    expect(tekst).not.toContain("boom");
  });

  it("FF8 — een onbetrouwbare oproeplijst maakt ook het saldo onbetrouwbaar", async () => {
    // Het saldo wordt uit de oproep-id's opgebouwd; zonder betrouwbare lijst is
    // "iedereen op nul" een bewering die we niet kunnen waarmaken.
    state.tabellen.charge_calls = STUK;
    const { container } = await toonPagina();
    expect(screen.getByTestId("balance-error")).toBeTruthy();
    expect(container.textContent ?? "").not.toContain("saldo.noData");
  });

  it("FF9 — een fout op payments toont geen 'Aucun paiement'", async () => {
    state.tabellen.payments = STUK;
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";
    expect(screen.getByTestId("payments-error")).toBeTruthy();
    expect(tekst).toContain("charges.errors.paymentsUnavailable");
    expect(tekst).not.toContain("payments.noPayments");
    expect(tekst).not.toContain("boom");
  });

  it("FF10 — elke financiële bron heeft zijn EIGEN melding", async () => {
    // Eén stukke bron mag de andere niet meeslepen: dat zou de gebruiker naar
    // de verkeerde oorzaak sturen.
    state.tabellen.charge_calls = {
      data: [
        oproep({
          alloc_unit_count: 2,
          charge_allocations: [allocatie("A1", 60000), allocatie("A2", 40000)],
        }),
      ],
      error: null,
    };
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

// ── P1: storno- en boekjaarstatus worden fail-closed gelezen ───────────────

/**
 * Een mislukte storno- of journaalquery mag NOOIT worden vertaald naar "geen
 * storno" of "open boekjaar".
 *
 * Het verschil is niet cosmetisch. Een gestorneerde betaling die als actief
 * verschijnt telt in het hoofd van de gebruiker gewoon mee; een correctie die
 * haar relatie met het origineel verliest ziet eruit als een dubbele betaling;
 * en een stornoknop bij een rij uit een gesloten boekjaar suggereert een recht
 * dat `fn_reversal_authorize` weigert.
 */
describe("SR — stornostatus en boekjaarstatus", () => {
  const STUK = { message: "relation \"v_financial_reversals\" does not exist" };

  /** De actieknop van PaymentReversalActions; het component zelf is gemockt. */
  const actieknoppen = () => screen.queryAllByTestId("payment-reversal");

  beforeEach(() => {
    state.tabellen.payments = { data: [betaling()], error: null };
    state.tabellen.journal_entries = { data: [journaal("open")], error: null };
  });

  it("SR1 — een fout op de reversal-view presenteert geen betaling als bewezen actief", async () => {
    state.reversals = { rijen: [], error: STUK };
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";

    // De melding staat er ...
    expect(screen.getByTestId("reversals-error")).toBeTruthy();
    expect(screen.getByTestId("reversals-error").getAttribute("role")).toBe("alert");
    expect(tekst).toContain("reversal.errors.statusUnavailable");

    // ... en de betaling wordt NIET als gezonde, ongestorneerde rij getoond.
    // De referentie is uniek voor de rij; de eigenaarsnaam komt ook elders
    // op de pagina voor en zou hier niets bewijzen.
    expect(tekst).not.toContain("VIR-2026-001");
    expect(tekst).not.toMatch(/\+300/);
    // Ook geen lege toestand: leeg zou net zo goed een bewering zijn.
    expect(tekst).not.toContain("payments.noPayments");
    // En geen enkele storno- of correctieknop.
    expect(actieknoppen()).toHaveLength(0);
  });

  it("SR2 — een GESLAAGDE lege reversal-query laat de betaling gewoon staan", async () => {
    state.reversals = { rijen: [], error: null };
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";

    expect(screen.queryByTestId("reversals-error")).toBeNull();
    expect(tekst).toContain("VIR-2026-001");
    expect(tekst).toMatch(/\+300/);
    // Schrijfrol, open boekjaar: de actie hoort er te zijn.
    expect(actieknoppen()).toHaveLength(1);
  });

  it("SR3 — een GESLAAGDE reversal-query met een storno markeert de betaling", async () => {
    state.reversals = { rijen: [storno()], error: null };
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";

    expect(screen.queryByTestId("reversals-error")).toBeNull();
    expect(tekst).toContain("VIR-2026-001");
    expect(tekst).toContain("reversal.reversed");
    expect(tekst).toContain("Dubbel geboekt door de syndic.");
    // Een al gestorneerde betaling krijgt geen tweede stornoknop.
    expect(actieknoppen()).toHaveLength(0);
  });

  it("SR4 — een correctie houdt haar relatie met het origineel", async () => {
    state.tabellen.payments = {
      data: [betaling(), betaling({ id: "pay-2", amount: 250, reference: "VIR-2026-002" })],
      error: null,
    };
    state.reversals = {
      rijen: [storno({ correction_source_id: "pay-2", is_correctie: true })],
      error: null,
    };
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";

    expect(tekst).toContain("reversal.corrected");
    expect(tekst).toContain("reversal.correctionOf");
  });

  it("SR5 — een fout op journal_entries haalt de actieknoppen weg en meldt dat", async () => {
    state.tabellen.journal_entries = { data: null, error: { message: "boom" } };
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";

    expect(screen.getByTestId("action-status-error")).toBeTruthy();
    expect(screen.getByTestId("action-status-error").getAttribute("role")).toBe("alert");
    expect(tekst).toContain("reversal.errors.actionStatusUnavailable");
    expect(actieknoppen()).toHaveLength(0);

    // De rij zelf blijft wél staan: bedrag en stornostatus zijn betrouwbaar.
    expect(tekst).toContain("VIR-2026-001");
    expect(tekst).toMatch(/\+300/);
  });

  it("SR6 — een GESLAAGDE journal-query met een OPEN boekjaar laat de actie staan", async () => {
    state.tabellen.journal_entries = { data: [journaal("open")], error: null };
    await toonPagina();
    expect(screen.queryByTestId("action-status-error")).toBeNull();
    expect(actieknoppen()).toHaveLength(1);
  });

  it("SR7 — een GESLAAGDE lege journal-query is geldig en geen fout", async () => {
    // Een betaling zonder journaalpost: dan is `closedPayments` terecht leeg.
    state.tabellen.journal_entries = { data: [], error: null };
    await toonPagina();
    expect(screen.queryByTestId("action-status-error")).toBeNull();
    expect(actieknoppen()).toHaveLength(1);
  });

  it("SR8 — bij een GESLOTEN oorspronkelijk boekjaar blijft de rolsemantiek intact", async () => {
    // `canReverse`: gesloten boekjaar -> owner/admin; anders volstaat schrijfrecht.
    state.tabellen.journal_entries = { data: [journaal("closed")], error: null };

    for (const rol of ["owner", "admin"]) {
      cleanup();
      state.rol = rol;
      state.tabellen = standaardTabellen();
      state.tabellen.payments = { data: [betaling()], error: null };
      state.tabellen.journal_entries = { data: [journaal("closed")], error: null };
      state.reversals = { rijen: [], error: null };
      await toonPagina();
      expect(actieknoppen(), rol).toHaveLength(1);
    }

    for (const rol of ["manager", "accountant", "viewer"]) {
      cleanup();
      state.rol = rol;
      state.tabellen = standaardTabellen();
      state.tabellen.payments = { data: [betaling()], error: null };
      state.tabellen.journal_entries = { data: [journaal("closed")], error: null };
      state.reversals = { rijen: [], error: null };
      await toonPagina();
      expect(actieknoppen(), rol).toHaveLength(0);
    }
  });

  it("SR9 — de meldingen zijn ook voor een viewer en op een gesloten boekjaar zichtbaar", async () => {
    // Fail-closed staat los van schrijfrecht: wie alleen leest, leest juist deze rijen.
    state.rol = "viewer";
    state.reversals = { rijen: [], error: STUK };
    await toonPagina();
    expect(screen.getByTestId("reversals-error")).toBeTruthy();

    cleanup();
    state.rol = "manager";
    state.tabellen = standaardTabellen();
    state.tabellen.payments = { data: [betaling()], error: null };
    state.tabellen.fiscal_years = {
      data: { id: FY, building_id: BLD, year: 2026, status: "closed", start_date: "2026-01-01", end_date: "2026-12-31" },
      error: null,
    };
    state.tabellen.journal_entries = { data: null, error: { message: "boom" } };
    state.reversals = { rijen: [], error: null };
    await toonPagina();
    expect(screen.getByTestId("action-status-error")).toBeTruthy();
  });

  it("SR10 — nooit de databasetekst of de technische viewnaam in beeld", async () => {
    state.reversals = { rijen: [], error: STUK };
    state.tabellen.journal_entries = { data: null, error: { message: "permission denied for table journal_entries" } };
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";

    expect(tekst).not.toContain("v_financial_reversals");
    expect(tekst).not.toContain("journal_entries");
    expect(tekst).not.toContain("does not exist");
    expect(tekst).not.toContain("permission denied");
  });
});

// ── C: het formulier voor een nieuwe betaling ──────────────────────────────

/**
 * Boeken zonder betrouwbare betalingenlijst is dubbel boeken; boeken zonder
 * betrouwbare openstaande positie is boeken in het duister. In beide gevallen
 * verdwijnt het formulier en blijft de foutmelding van de stukke bron staan.
 */
describe("NB — formulier nieuwe betaling", () => {
  const STUK = { data: null, error: { message: "boom" } };

  /** Het formulier herken je aan zijn eigen velden, niet aan zijn opmaak. */
  const formulier = (container: HTMLElement) => container.querySelector("#owner_id");

  beforeEach(() => {
    state.tabellen.payments = { data: [betaling()], error: null };
    state.tabellen.journal_entries = { data: [journaal("open")], error: null };
  });

  it("NB1 — met gezonde bronnen en een open boekjaar staat het formulier er", async () => {
    const { container } = await toonPagina();
    expect(formulier(container)).toBeTruthy();
    expect(container.querySelector("#pay_amount")).toBeTruthy();
  });

  it("NB2 — een fout op payments: geen lijst, geen lege toestand, geen formulier", async () => {
    state.tabellen.payments = STUK;
    const { container } = await toonPagina();
    const tekst = container.textContent ?? "";

    expect(screen.getByTestId("payments-error")).toBeTruthy();
    expect(tekst).not.toContain("payments.noPayments");
    expect(tekst).not.toContain("VIR-2026-001");
    expect(formulier(container)).toBeNull();
    expect(container.querySelector("#pay_amount")).toBeNull();
  });

  it("NB3 — een fout op charge_calls haalt het formulier weg", async () => {
    state.tabellen.charge_calls = STUK;
    const { container } = await toonPagina();
    expect(screen.getByTestId("calls-error")).toBeTruthy();
    expect(formulier(container)).toBeNull();
  });

  it("NB4 — een fout op charge_allocations haalt het formulier weg", async () => {
    state.tabellen.charge_calls = { data: [oproep()], error: null };
    state.tabellen.charge_allocations = STUK;
    const { container } = await toonPagina();
    expect(screen.getByTestId("balance-error")).toBeTruthy();
    expect(formulier(container)).toBeNull();
  });

  it("NB5 — een fout op de eigenaarsbron haalt het formulier weg", async () => {
    state.tabellen.ownership = STUK;
    const { container } = await toonPagina();
    expect(formulier(container)).toBeNull();
  });

  it("NB6 — een gesloten boekjaar toont geen formulier", async () => {
    state.tabellen.fiscal_years = {
      data: { id: FY, building_id: BLD, year: 2026, status: "closed", start_date: "2026-01-01", end_date: "2026-12-31" },
      error: null,
    };
    const { container } = await toonPagina();
    expect(formulier(container)).toBeNull();
  });

  it("NB7 — GESLAAGDE lege queries geven geen valse foutmelding", async () => {
    // Alles leeg maar gezond: geen enkele alert, en geen formulier alleen omdat
    // er nog geen eigenaar is vastgelegd.
    state.tabellen.payments = { data: [], error: null };
    state.tabellen.charge_calls = { data: [], error: null };
    state.tabellen.charge_call_lines = { data: [], error: null };
    state.reversals = { rijen: [], error: null };
    const { container } = await toonPagina();

    expect(screen.queryByTestId("payments-error")).toBeNull();
    expect(screen.queryByTestId("calls-error")).toBeNull();
    expect(screen.queryByTestId("lines-error")).toBeNull();
    expect(screen.queryByTestId("balance-error")).toBeNull();
    expect(screen.queryByTestId("reversals-error")).toBeNull();
    expect(screen.queryByTestId("action-status-error")).toBeNull();
    expect(container.textContent ?? "").toContain("payments.noPayments");
    // De eigenaar komt uit ownership en die is gezond, dus het formulier staat er.
    expect(formulier(container)).toBeTruthy();
  });
});

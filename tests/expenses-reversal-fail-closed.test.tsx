// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";

/**
 * FAIL-CLOSED op het uitgavenscherm — de reversal-index.
 *
 * DE FOUT DIE HIER WORDT AFGEDEKT
 *
 * De pagina gebruikte `fetchReversalIndex()`, de fail-open variant: bij een
 * leesfout kreeg zij een LEGE index in plaats van een fout. Een lege index is
 * hier niet onschuldig. `netTotal()` telt dan niets af en levert exact het
 * BRUTO bedrag, terwijl het label en de hint dat getal als NETTO presenteren.
 * Een correctie van 1200 naar 900 verscheen daardoor als 2100 op precies de
 * plek die zegt "dit is de stand".
 *
 * Tegelijk verdween de storno-markering uit de lijst, zag een gestorneerde
 * uitgave er actief uit, en kwam er een stornoknop bij een rij die de database
 * zeker weigert.
 *
 * Alle drie de toestanden worden los getoetst:
 *
 *   geslaagd en leeg      betrouwbaar leeg  -> lege toestand mag verschijnen
 *   geslaagd met rijen    markering zichtbaar, totaal netto
 *   mislukt               niets bewezen     -> geen bedrag, geen rijen, melding
 */

const BLD = "11111111-1111-1111-1111-111111111111";

type Resultaat = { data: unknown; error: unknown };
type ReversalRij = import("@/lib/reversal").ReversalViewRow;

const state: {
  rol: string;
  tabellen: Record<string, Resultaat>;
  reversals: { rijen: ReversalRij[]; error: unknown };
} = { rol: "manager", tabellen: {}, reversals: { rijen: [], error: null } };

/** Eén uitgave zoals de pagina hem uit de database krijgt. */
function uitgave(id: string, amount: number, over: Record<string, unknown> = {}) {
  return {
    id,
    supplier: "Sté Ménage SARL",
    description: null,
    amount,
    expense_date: "2026-05-12",
    receipt_path: null,
    receipt_url: null,
    fiscal_year_id: "fy-1",
    category_id: null,
    expense_categories: null,
    ...over,
  };
}

/** Eén rij uit `v_financial_reversals`: deze uitgave is gecorrigeerd. */
function correctie(over: Partial<ReversalRij> = {}): ReversalRij {
  return {
    reversal_id: "rev-1",
    source_type: "expense",
    source_id: "exp-1",
    correction_source_id: "exp-2",
    reason: "Verkeerd bedrag overgenomen uit de factuur.",
    effective_date: "2026-05-20",
    is_correctie: true,
    is_correctie_vorig_boekjaar: false,
    ...over,
  };
}

function standaardTabellen(): Record<string, Resultaat> {
  return {
    buildings: { data: { id: BLD, name: "Résidence Atlas" }, error: null },
    expense_categories: { data: [], error: null },
    expenses: { data: [], error: null },
    fiscal_years: { data: [{ id: "fy-1", year: 2026, status: "open" }], error: null },
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
    or: zelf,
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
    from: (tabel: string) => keten(state.tabellen[tabel] ?? { data: [], error: null }),
  }),
}));

/* De reversal-engine draait ECHT; alleen het ophalen is injecteerbaar. */
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

vi.mock("@/components/ReceiptLink", () => ({ default: () => <span /> }));

vi.mock("@/components/ExpenseReversalActions", () => ({
  default: () => <div data-testid="expense-reversal" />,
}));

vi.mock("@/app/[locale]/(app)/buildings/[id]/expenses/actions", () => ({
  createExpense: async () => undefined,
  createExpenseCategory: async () => undefined,
}));

const { default: ExpensesPage } = await import(
  "@/app/[locale]/(app)/buildings/[id]/expenses/page"
);

async function toonPagina() {
  const element = await ExpensesPage({ params: Promise.resolve({ id: BLD }) });
  return render(element);
}

/** Alle zichtbare tekst zonder spaties, zodat cijfergroepering niet stoort. */
function cijfertekst() {
  return (document.body.textContent ?? "").replace(/[\s\u00a0\u202f.]/g, "");
}

/**
 * Alle zichtbare tekst zonder witruimte, MET de punten. Voor asserties op
 * vertaalsleutels als `reversal.netLabel`, die zelf een punt bevatten.
 */
function platteTekst() {
  return (document.body.textContent ?? "").replace(/[\s\u00a0\u202f]/g, "");
}

beforeEach(() => {
  state.rol = "manager";
  state.tabellen = standaardTabellen();
  state.reversals = { rijen: [], error: null };
  document.body.innerHTML = "";
});

describe("uitgavenscherm — betrouwbare stornostatus", () => {
  it("R1 toont de lege toestand bij een geslaagde, lege query", async () => {
    await toonPagina();
    expect(screen.getByText("expenses.noExpenses")).toBeTruthy();
    expect(screen.queryByTestId("reversals-error")).toBeNull();
  });

  it("R2 telt zonder storno's bruto en netto gelijk op, zonder nettolabel", async () => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200), uitgave("exp-3", 300)], error: null };
    await toonPagina();
    expect(screen.getByTestId("expenses-total")).toBeTruthy();
    expect(cijfertekst()).toContain("1500,00MAD");
    // Zonder storno's is er niets te netten, dus ook geen nettolabel.
    expect(platteTekst()).not.toContain("reversal.netLabel");
    expect(screen.queryByTestId("reversals-error")).toBeNull();
  });

  it("R3 toont bij een correctie het NETTO totaal en het nettolabel", async () => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200), uitgave("exp-2", 900)], error: null };
    state.reversals = { rijen: [correctie()], error: null };
    await toonPagina();
    // 1200 is gestorneerd, 900 is de vervangende rij: netto 900, niet 2100.
    expect(cijfertekst()).toContain("900,00MAD");
    expect(cijfertekst()).not.toContain("2100,00");
    // Het label staat tussen haakjes in de opmaak, dus op tekstinhoud toetsen.
    expect(platteTekst()).toContain("reversal.netLabel");
  });

  it("R4 houdt de volledige lijst zichtbaar met markering (klasse A)", async () => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200), uitgave("exp-2", 900)], error: null };
    state.reversals = { rijen: [correctie()], error: null };
    await toonPagina();
    expect(screen.getByText("reversal.corrected")).toBeTruthy();
    expect(screen.getByText("reversal.isCorrection")).toBeTruthy();
  });
});

describe("uitgavenscherm — de reversal-index faalt", () => {
  const fout = { code: "42501", message: "permission denied for view v_financial_reversals" };

  beforeEach(() => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200), uitgave("exp-2", 900)], error: null };
    state.reversals = { rijen: [], error: fout };
  });

  it("F1 toont GEEN totaalbedrag", async () => {
    await toonPagina();
    expect(screen.queryByTestId("expenses-total")).toBeNull();
  });

  it("F2 toont nergens het brutobedrag als totaal", async () => {
    await toonPagina();
    // 1200 + 900 = 2100: precies het getal dat de fail-open variant opleverde.
    expect(cijfertekst()).not.toContain("2100,00");
  });

  it("F3 toont een vertaalde melding met role=alert", async () => {
    await toonPagina();
    const melding = screen.getByTestId("reversals-error");
    expect(melding.getAttribute("role")).toBe("alert");
    expect(melding.textContent).toBe("reversal.errors.expenseStatusUnavailable");
  });

  it("F4 onderdrukt de uitgaverijen in plaats van ze half correct te tonen", async () => {
    await toonPagina();
    expect(screen.queryByText("Sté Ménage SARL")).toBeNull();
  });

  it("F5 toont GEEN lege toestand — dat zou een onwaarheid zijn", async () => {
    await toonPagina();
    expect(screen.queryByText("expenses.noExpenses")).toBeNull();
  });

  it("F6 biedt geen storno- of correctieactie aan", async () => {
    await toonPagina();
    expect(screen.queryByTestId("expense-reversal")).toBeNull();
  });

  it("F7 lekt geen databasefout, viewnaam of technische code", async () => {
    await toonPagina();
    const tekst = document.body.textContent ?? "";
    for (const verboden of ["42501", "permission denied", "v_financial_reversals", "PGRST"]) {
      expect(tekst).not.toContain(verboden);
    }
  });

  it("F9 toont ook zonder uitgaven geen lege toestand zolang de status onbekend is", async () => {
    // Productie bereikt dit niet: bij nul bron-id's doet de helper geen query
    // en levert hij `error: null`. De poort blijft staan als bescherming tegen
    // een toekomstige wijziging van die vroege terugkeer, en deze test houdt
    // hem vast — zonder haar is de poort ongetoetst en dus stil te slopen.
    state.tabellen.expenses = { data: [], error: null };
    await toonPagina();
    expect(screen.queryByText("expenses.noExpenses")).toBeNull();
    expect(screen.getByTestId("reversals-error")).toBeTruthy();
  });

  it("F8 laat het aanmaakformulier staan — dat hangt niet van de storno's af", async () => {
    await toonPagina();
    // Op de knop toetsen: "addExpense" staat ook boven het categorieformulier.
    expect(screen.getByText("expenses.createBtn")).toBeTruthy();
  });
});

/**
 * De overige bronnen op hetzelfde scherm. `data ?? []` maakte van elke mislukte
 * query een lege lijst, en leeg is hier nooit neutraal — het is een BEWERING:
 *
 *   expenses      "geen uitgaven" is een uitspraak over geld;
 *   categories    een formulier zonder categorieën stuurt invoer die de
 *                 database weigert, en de aanmaakknop suggereert dat het kan;
 *   fiscal_years  "geen afgesloten boekjaren" laat een storno in een gesloten
 *                 boekjaar eruitzien als een gewone ingreep voor een manager.
 */
describe("uitgavenscherm — de uitgavenquery faalt", () => {
  const fout = { code: "57014", message: "canceling statement due to statement timeout" };

  beforeEach(() => {
    state.tabellen.expenses = { data: null, error: fout };
  });

  it("Q1 toont geen totaal", async () => {
    await toonPagina();
    expect(screen.queryByTestId("expenses-total")).toBeNull();
  });

  it("Q2 toont geen lege toestand — dat zou een onwaarheid zijn", async () => {
    await toonPagina();
    expect(screen.queryByText("expenses.noExpenses")).toBeNull();
  });

  it("Q3 toont een vertaalde melding met role=alert", async () => {
    await toonPagina();
    const melding = screen.getByTestId("expenses-error");
    expect(melding.getAttribute("role")).toBe("alert");
    expect(melding.textContent).toBe("expenses.errors.listUnavailable");
  });

  it("Q4 lekt geen technische fouttekst", async () => {
    await toonPagina();
    const tekst = document.body.textContent ?? "";
    for (const verboden of ["57014", "statement timeout", "expenses(", "PGRST"]) {
      expect(tekst).not.toContain(verboden);
    }
  });

  it("Q5 laat het aanmaakformulier staan — dat hangt niet van de lijst af", async () => {
    await toonPagina();
    expect(screen.getByText("expenses.createBtn")).toBeTruthy();
  });
});

describe("uitgavenscherm — de categoriequery faalt", () => {
  const fout = { code: "42501", message: "permission denied for table expense_categories" };

  beforeEach(() => {
    state.tabellen.expense_categories = { data: null, error: fout };
  });

  it("C1 toont geen uitgaveformulier en geen aanmaakknop", async () => {
    await toonPagina();
    expect(screen.queryByText("expenses.createBtn")).toBeNull();
    expect(screen.queryByText("expenses.addCategory")).toBeNull();
  });

  it("C2 toont geen lege categorielijst als bewering", async () => {
    await toonPagina();
    expect(screen.queryByText("expenses.noCategories")).toBeNull();
  });

  it("C3 toont twee vertaalde meldingen met role=alert", async () => {
    await toonPagina();
    expect(screen.getByTestId("form-error").textContent).toBe("expenses.errors.formUnavailable");
    expect(screen.getByTestId("form-error").getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("categories-error").textContent).toBe(
      "expenses.errors.categoriesUnavailable",
    );
  });

  it("C4 lekt geen technische fouttekst", async () => {
    await toonPagina();
    const tekst = document.body.textContent ?? "";
    for (const verboden of ["42501", "permission denied", "expense_categories"]) {
      expect(tekst).not.toContain(verboden);
    }
  });

  it("C6 vertrouwt de rijen niet wanneer er OOK een fout meekomt", async () => {
    // Een respons met data én een error hoort niet voor te komen, en juist
    // daarom is dit de scherpste toets: de fout maakt de payload onbetrouwbaar,
    // ongeacht wat eraan hangt. Zonder deze test is de poort op de lijst
    // ongetoetst, want een mislukte query levert normaal toch al `null`.
    state.tabellen.expense_categories = {
      data: [{ id: "c1", name: "Ménage", default_account_id: null }],
      error: { code: "42501", message: "permission denied" },
    };
    await toonPagina();
    expect(screen.queryByText("Ménage")).toBeNull();
    expect(screen.getByTestId("categories-error")).toBeTruthy();
  });

  it("C5 laat de uitgavenlijst en het totaal staan — die hangen er niet van af", async () => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200)], error: null };
    await toonPagina();
    expect(screen.getByTestId("expenses-total")).toBeTruthy();
    expect(screen.getByText("Sté Ménage SARL")).toBeTruthy();
  });
});

describe("uitgavenscherm — de boekjaarquery faalt", () => {
  const fout = { code: "08006", message: "connection failure to fiscal_years" };

  it("B1 biedt geen storno- of correctieactie aan bij onbekende status", async () => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200)], error: null };
    state.tabellen.fiscal_years = { data: null, error: fout };
    await toonPagina();
    expect(screen.queryByTestId("expense-reversal")).toBeNull();
  });

  it("B2 toont een vertaalde melding over de boekjaarstatus", async () => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200)], error: null };
    state.tabellen.fiscal_years = { data: null, error: fout };
    await toonPagina();
    const melding = screen.getByTestId("fy-status-error");
    expect(melding.getAttribute("role")).toBe("alert");
    expect(melding.textContent).toBe("expenses.errors.fiscalYearStatusUnavailable");
  });

  it("B3 toont geen uitgaveformulier: de open boekjaren zijn onbekend", async () => {
    state.tabellen.fiscal_years = { data: null, error: fout };
    await toonPagina();
    expect(screen.queryByText("expenses.createBtn")).toBeNull();
    expect(screen.getByTestId("form-error")).toBeTruthy();
  });

  it("B4 houdt de uitgavenlijst en het totaal wél zichtbaar", async () => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200)], error: null };
    state.tabellen.fiscal_years = { data: null, error: fout };
    await toonPagina();
    expect(screen.getByTestId("expenses-total")).toBeTruthy();
    expect(screen.getByText("Sté Ménage SARL")).toBeTruthy();
  });

  it("B5 lekt geen technische fouttekst", async () => {
    state.tabellen.fiscal_years = { data: null, error: fout };
    await toonPagina();
    const tekst = document.body.textContent ?? "";
    for (const verboden of ["08006", "connection failure", "fiscal_years"]) {
      expect(tekst).not.toContain(verboden);
    }
  });
});

describe("uitgavenscherm — gecombineerde fouten", () => {
  it("K1 onderdrukt bij ALLE bronnen stuk elke bewering, en toont vier meldingen", async () => {
    state.tabellen.expenses = { data: null, error: { code: "1", message: "a" } };
    state.tabellen.expense_categories = { data: null, error: { code: "2", message: "b" } };
    state.tabellen.fiscal_years = { data: null, error: { code: "3", message: "c" } };
    state.reversals = { rijen: [], error: { code: "4", message: "d" } };
    await toonPagina();

    expect(screen.queryByTestId("expenses-total")).toBeNull();
    expect(screen.queryByText("expenses.noExpenses")).toBeNull();
    expect(screen.queryByText("expenses.noCategories")).toBeNull();
    expect(screen.queryByText("expenses.createBtn")).toBeNull();
    expect(screen.queryByTestId("expense-reversal")).toBeNull();

    expect(screen.getByTestId("expenses-error")).toBeTruthy();
    expect(screen.getByTestId("form-error")).toBeTruthy();
    expect(screen.getByTestId("categories-error")).toBeTruthy();
    // De stornomelding wijkt voor de zwaardere uitgavenmelding: zonder lijst
    // valt er over storno's sowieso niets te zeggen.
    expect(screen.queryByTestId("reversals-error")).toBeNull();
  });

  it("K2 toont bij uitgaven- én stornofout precies één lijstmelding", async () => {
    state.tabellen.expenses = { data: null, error: { code: "1", message: "a" } };
    state.reversals = { rijen: [], error: { code: "2", message: "b" } };
    await toonPagina();
    expect(screen.getByTestId("expenses-error")).toBeTruthy();
    expect(screen.queryByTestId("reversals-error")).toBeNull();
  });

  it("K3 raakt bij een categoriefout de storno-actie niet kwijt", async () => {
    state.tabellen.expenses = { data: [uitgave("exp-1", 1200)], error: null };
    state.tabellen.expense_categories = { data: null, error: { code: "2", message: "b" } };
    await toonPagina();
    expect(screen.getByTestId("expense-reversal")).toBeTruthy();
  });

  it("K4 lekt ook gecombineerd geen enkele technische code", async () => {
    state.tabellen.expenses = { data: null, error: { code: "57014", message: "timeout" } };
    state.tabellen.expense_categories = { data: null, error: { code: "42501", message: "denied" } };
    state.tabellen.fiscal_years = { data: null, error: { code: "08006", message: "conn" } };
    state.reversals = { rijen: [], error: { code: "42P01", message: "undefined table" } };
    await toonPagina();
    const tekst = document.body.textContent ?? "";
    for (const verboden of ["57014", "42501", "08006", "42P01", "timeout", "denied", "undefined table"]) {
      expect(tekst).not.toContain(verboden);
    }
  });
});

describe("uitgavenscherm — bronvereisten (mutatietoets)", () => {
  const bron = readFileSync(
    "src/app/[locale]/(app)/buildings/[id]/expenses/page.tsx",
    "utf8",
  );

  it("M1 gebruikt de strikte helper en niet de fail-open variant", () => {
    expect(bron).toContain("fetchReversalIndexResult");
    // `\b...\b(?!Result)` vangt precies de fail-open naam, niet de strikte.
    expect(bron).not.toMatch(/\bfetchReversalIndex\b(?!Result)/);
  });

  it("M2 koppelt totaal, lijst en lege toestand aan de foutstatus", () => {
    expect(bron).toMatch(/const\s+reversalsOk\s*=\s*!reversalError/);
    // Het totaal mag niet onvoorwaardelijk worden berekend. `listOk` bundelt de
    // uitgavenquery EN de stornostatus: beide moeten kloppen voor een bedrag.
    expect(bron).toMatch(/listOk\s*\?\s*netTotal\(/);
  });

  it("M3 toont de melding via een vertaalsleutel, niet als vaste tekst", () => {
    expect(bron).toContain('tr("errors.expenseStatusUnavailable")');
  });

  it("M4 legt van elke bron de foutstatus vast", () => {
    for (const poort of [
      /const\s+expensesOk\s*=\s*!expError/,
      /const\s+categoriesOk\s*=\s*!catError/,
      /const\s+openFyOk\s*=\s*!openFyError/,
      /const\s+fyStatusOk\s*=\s*!fyStatusError/,
    ]) {
      expect(bron).toMatch(poort);
    }
  });

  it("M5 gebruikt nergens een kale `?? []` als enige poort op een bewering", () => {
    // De vangnetten mogen blijven staan, maar elke BEWERING hangt aan een
    // expliciete Ok-vlag. Dit pint de vier samengestelde poorten vast.
    expect(bron).toMatch(/const\s+formOk\s*=\s*categoriesOk\s*&&\s*openFyOk/);
    expect(bron).toMatch(/const\s+listOk\s*=\s*expensesOk\s*&&\s*reversalsOk/);
    expect(bron).toMatch(/listOk\s*&&\s*expenses\.length === 0/);
    expect(bron).toMatch(/fyStatusOk\s*&&/);
  });
});

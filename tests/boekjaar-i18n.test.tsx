// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

/**
 * I18N — het boekjaarscherm in FR, NL en AR.
 *
 * Deze suite gebruikt bewust NIET de sleutelstub van de andere paginatests,
 * maar de ECHTE next-intl-pipeline op de echte berichtenbestanden. Alleen zo
 * kan hij bewijzen wat de Preview-QA vond: dat een Nederlandse route Franse
 * koppen, statussen en formulierlabels toonde. Een stub die de sleutelnaam
 * teruggeeft zou daar per definitie blind voor zijn.
 */

const BLD = "11111111-1111-1111-1111-111111111111";
const FY = "44444444-4444-4444-4444-444444444444";

type Resultaat = { data: unknown; error: unknown };

const TALEN = { fr, nl, ar } as Record<string, Record<string, unknown>>;

const state: { locale: string; rol: string; tabellen: Record<string, Resultaat> } = {
  locale: "fr",
  rol: "manager",
  tabellen: {},
};

function allocatie(label: string, cents: number) {
  return {
    id: `ca-${label}`,
    amount: cents / 100,
    amount_cents: cents,
    settled_amount: 0,
    owner_id: "o1",
    units: { label },
    owners: { full_name: "Youssef El Amrani" },
  };
}

function standaardTabellen(): Record<string, Resultaat> {
  return {
    buildings: { data: { id: BLD, name: "Résidence Atlas", total_tantiemes: 100 }, error: null },
    fiscal_years: {
      data: {
        id: FY,
        building_id: BLD,
        year: 2026,
        status: "open",
        start_date: "2026-01-01",
        end_date: "2026-12-31",
      },
      error: null,
    },
    charge_calls: {
      data: [
        {
          id: "cc-1",
          type: "regulier",
          period: "T2 2026",
          label: null,
          total_amount: 1000,
          call_date: "2026-06-30",
          due_date: "2026-07-31",
          alloc_method: "tantieme",
          alloc_scope: "whole_building",
          alloc_rule_label: "Charges générales",
          alloc_unit_count: 2,
          alloc_partial_denominator: false,
          charge_allocations: [allocatie("A1", 60000), allocatie("A2", 40000)],
        },
      ],
      error: null,
    },
    units: {
      data: [{ id: "u1", building_id: BLD, label: "A1", tantiemes: 100, block_id: null }],
      error: null,
    },
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
    payments: { data: [], error: null },
    journal_entries: { data: [], error: null },
    charge_allocations: { data: [], error: null },
  };
}

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

/* De ECHTE ICU-pipeline op de echte berichtenbestanden. */
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => {
    const maak = createTranslator as unknown as (o: {
      locale: string;
      messages: unknown;
      namespace?: string;
    }) => (k: string, v?: Record<string, unknown>) => string;
    return maak({ locale: state.locale, messages: TALEN[state.locale], namespace });
  },
  getLocale: async () => state.locale,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabel: string) => keten(state.tabellen[tabel] ?? { data: [], error: null }),
  }),
}));

vi.mock("@/lib/reversal", async (importOriginal) => {
  const echt = await importOriginal<typeof import("@/lib/reversal")>();
  return {
    ...echt,
    fetchReversalIndexResult: async () => ({ index: echt.emptyReversalIndex(), error: null }),
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
  () => ({ default: () => <div data-testid="workflow" /> }),
);

vi.mock("@/app/[locale]/(app)/buildings/[id]/boekjaren/actions", () => ({
  createPayment: async () => undefined,
  createChargeCall: async () => undefined,
}));

const { default: FiscalYearDetail } = await import(
  "@/app/[locale]/(app)/buildings/[id]/boekjaren/[fy_id]/page"
);

async function toon(locale: string) {
  state.locale = locale;
  const element = await FiscalYearDetail({
    params: Promise.resolve({ locale, id: BLD, fy_id: FY }),
  });
  return render(element);
}

/** De Franse teksten die de Preview-QA op de NL- en AR-route aantrof. */
const FRANS_UIT_DE_QA = [
  "Exercice 2026",
  "Ouvert",
  "Paiements",
  "Aucun paiement",
  "Enregistrer un paiement",
  "Propriétaire",
  "Montant",
  "Référence",
  "Solde par propriétaire",
  "Aucun appel ou propriétaire lié",
];

beforeEach(() => {
  state.rol = "manager";
  state.locale = "fr";
  state.tabellen = standaardTabellen();
});

afterEach(() => cleanup());

describe("I18N — geen hardcoded Frans meer in de bron", () => {
  it("I1 — page.tsx bevat de Franse QA-teksten niet meer letterlijk", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
    const bron = readFileSync(
      join(
        repo,
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
    for (const tekst of [
      "Exercice {",
      ">Ouvert<",
      "Clôturé",
      ">Paiements<",
      "Aucun paiement",
      "Enregistrer un paiement",
      ">Propriétaire<",
      "Montant (MAD)",
      ">Référence<",
      "Solde par propriétaire",
      "Aucun appel ou propriétaire lié",
      ">Virement<",
      "en attente",
    ]) {
      expect(bron.includes(tekst), `nog hardcoded in page.tsx: "${tekst}"`).toBe(false);
    }
  });
});

describe("I18N — de pagina rendert per taal", () => {
  it("I2 — FR blijft correct Frans", async () => {
    const { container } = await toon("fr");
    const tekst = container.textContent ?? "";
    expect(tekst).toContain("Exercice 2026");
    expect(tekst).toContain("Ouvert");
    expect(tekst).toContain("Paiements");
    expect(tekst).toContain("Aucun paiement.");
    expect(tekst).toContain("Solde par copropriétaire");
  });

  it("I3 — NL bevat geen Franse interface meer", async () => {
    const { container } = await toon("nl");
    const tekst = container.textContent ?? "";
    for (const frans of FRANS_UIT_DE_QA) {
      expect(tekst.includes(frans), `NL toont nog Frans: "${frans}"`).toBe(false);
    }
    expect(tekst).toContain("Boekjaar 2026");
    expect(tekst).toContain("Open");
    expect(tekst).toContain("Betalingen");
    expect(tekst).toContain("Nog geen betalingen.");
    expect(tekst).toContain("Saldo per eigenaar");
  });

  it("I4 — AR bevat geen Franse interface meer", async () => {
    const { container } = await toon("ar");
    const tekst = container.textContent ?? "";
    for (const frans of FRANS_UIT_DE_QA) {
      expect(tekst.includes(frans), `AR toont nog Frans: "${frans}"`).toBe(false);
    }
    expect(tekst).toContain("السنة المالية 2026");
    expect(tekst).toContain("المدفوعات");
    expect(tekst).toContain("الرصيد لكل مالك");
  });

  it("I5 — de open/gesloten status wordt per taal vertaald", async () => {
    const verwacht: Record<string, [string, string]> = {
      fr: ["Ouvert", "Clôturé"],
      nl: ["Open", "Gesloten"],
      ar: ["مفتوح", "مغلق"],
    };
    for (const [taal, [open, dicht]] of Object.entries(verwacht)) {
      cleanup();
      state.tabellen = standaardTabellen();
      expect((await toon(taal)).container.textContent, `${taal} open`).toContain(open);

      cleanup();
      state.tabellen = standaardTabellen();
      state.tabellen.fiscal_years = {
        data: {
          id: FY,
          building_id: BLD,
          year: 2026,
          status: "closed",
          start_date: "2026-01-01",
          end_date: "2026-12-31",
        },
        error: null,
      };
      expect((await toon(taal)).container.textContent, `${taal} gesloten`).toContain(dicht);
    }
  });

  it("I6 — het betalingsformulier is per taal volledig vertaald", async () => {
    const verwacht: Record<string, string[]> = {
      fr: ["Enregistrer un paiement", "Copropriétaire", "Montant (MAD)", "Mode", "Virement"],
      nl: ["Betaling registreren", "Eigenaar", "Bedrag (MAD)", "Methode", "Overboeking"],
      ar: ["تسجيل دفعة", "المالك", "المبلغ (MAD)", "طريقة الدفع", "تحويل"],
    };
    for (const [taal, woorden] of Object.entries(verwacht)) {
      cleanup();
      state.tabellen = standaardTabellen();
      const { container } = await toon(taal);
      for (const w of woorden) {
        expect(container.textContent ?? "", `${taal}: "${w}"`).toContain(w);
      }
    }
  });

  it("I7 — de saldosectie is per taal volledig vertaald", async () => {
    const verwacht: Record<string, string[]> = {
      fr: ["Solde par copropriétaire", "Aucun appel de charges"],
      nl: ["Saldo per eigenaar", "Nog geen lastenoproepen"],
      ar: ["الرصيد لكل مالك", "لا توجد استدعاءات"],
    };
    for (const [taal, woorden] of Object.entries(verwacht)) {
      cleanup();
      state.tabellen = standaardTabellen();
      const { container } = await toon(taal);
      for (const w of woorden) {
        expect(container.textContent ?? "", `${taal}: "${w}"`).toContain(w);
      }
    }
  });

  it("I8 — elke gebruikte sleutel bestaat in FR, NL en AR", () => {
    const paden = [
      ["fy", "heading"],
      ["boekjaren", "called"],
      ["boekjaren", "status.open"],
      ["boekjaren", "status.closed"],
      ["charges", "callLabel"],
      ["charges", "types.regulier"],
      ["charges", "types.exceptionnel"],
      ["charges", "date"],
      ["charges", "dueLabel"],
      ["charges", "late"],
      ["charges", "verdeling"],
      ["payments", "title"],
      ["payments", "noPayments"],
      ["payments", "registerPayment"],
      ["payments", "owner"],
      ["payments", "amount"],
      ["payments", "date"],
      ["payments", "method"],
      ["payments", "reference"],
      ["payments", "referencePlaceholder"],
      ["payments", "registerBtn"],
      ["payments", "methods.virement"],
      ["payments", "methods.especes"],
      ["payments", "methods.cheque"],
      ["payments", "methods.carte"],
      ["saldo", "title"],
      ["saldo", "noData"],
      ["saldo", "owner"],
      ["saldo", "called"],
      ["saldo", "paid"],
      ["saldo", "open"],
      ["saldo", "lateSuffix"],
      ["saldo", "total"],
      ["common", "paid"],
      ["common", "late"],
      ["common", "partial"],
      ["common", "pending"],
    ];
    for (const [taal, berichten] of Object.entries(TALEN)) {
      for (const [ns, pad] of paden) {
        const waarde = pad
          .split(".")
          .reduce<unknown>(
            (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
            berichten[ns],
          );
        expect(waarde, `${taal}: ${ns}.${pad} ontbreekt`).toBeTruthy();
        expect(typeof waarde, `${taal}: ${ns}.${pad}`).toBe("string");
      }
    }
  });

  it("I9 — geen technische tabel-, view- of foutcodenaam in de vertalingen", () => {
    const verboden =
      /(charge_call_lines|charge_allocations|v_financial_reversals|journal_entries|PGRST|ALLOC_[A-Z_]+|amount_cents)/;
    for (const [taal, berichten] of Object.entries(TALEN)) {
      const loop = (o: unknown, pad: string): void => {
        if (typeof o === "string") {
          expect(verboden.test(o), `${taal}.${pad}: "${o}"`).toBe(false);
          return;
        }
        if (o && typeof o === "object") {
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) loop(v, `${pad}.${k}`);
        }
      };
      for (const ns of ["charges", "payments", "saldo", "fy", "boekjaren", "common", "reversal"]) {
        loop(berichten[ns], ns);
      }
    }
  });

  it("I11 — AR blijft RTL en de pagina gebruikt geen fysieke richting", async () => {
    const { localeDirection } = await import("@/lib/direction");
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("nl")).toBe("ltr");
    expect(localeDirection("fr")).toBe("ltr");

    // De schil zet `dir` op <html>; de pagina moet dat respecteren door LOGISCHE
    // opmaak te gebruiken. Een links/rechts-eigenschap zou in het Arabisch de
    // verkeerde kant op staan, ongeacht wat de schil doet.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
    const bron = readFileSync(
      join(
        repo,
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
    // De nieuwe/aangeraakte opmaak gebruikt logische Tailwind-klassen.
    expect(bron).not.toMatch(/\bclassName="[^"]*\b(ml-\d|mr-\d|pl-\d|pr-\d|text-left|text-right)\b/);

    // En de AR-render komt er zonder Franse resten doorheen.
    cleanup();
    state.tabellen = standaardTabellen();
    const { container } = await toon("ar");
    expect(container.textContent ?? "").toContain("السنة المالية 2026");
  });

  it("I10 — de fail-closed meldingen blijven intact en vertaald", async () => {
    // De i18n-ronde mag de eerder gerepareerde poorten niet uithollen.
    for (const taal of ["fr", "nl", "ar"]) {
      cleanup();
      state.tabellen = standaardTabellen();
      state.tabellen.charge_calls = { data: null, error: { message: "boom" } };
      const { container } = await toon(taal);
      const melding = screen.getByTestId("calls-error");
      expect(melding.getAttribute("role"), taal).toBe("alert");
      const verwacht = (TALEN[taal].charges as { errors: Record<string, string> }).errors
        .callsUnavailable;
      expect(melding.textContent, taal).toBe(verwacht);
      expect(container.textContent ?? "", taal).not.toContain("boom");
    }
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

/**
 * De toestanden van de lotslijst.
 *
 * WAT HIER "BESTAAND GEDRAG" IS EN WAT NIEUW — dat onderscheid staat per test
 * in de naam, en het is geen formaliteit.
 *
 *   B1..B7   BESTAAND GEDRAG VASTLEGGEN. Het fail-closed onderscheid tussen
 *            "mislukt" en "leeg" zat er al, via twee early returns. Het was
 *            alleen nergens op paginaniveau getoetst, dus niets hield tegen
 *            dat iemand die returns wegnam. De mutatietoets draait precies
 *            die bestaande returns terug.
 *
 *   N1..N8   NIEUW. De alleen-lezenmelding bestond niet: een lezer zag de
 *            schrijf-UI zwijgend verdwijnen. En het serverlog maakte geen
 *            onderscheid tussen een mislukte gebouwquery en een mislukte
 *            bronquery, terwijl de gebruiker terecht één en dezelfde melding
 *            krijgt.
 *
 * WAT DEZE SUITE NIET BEWIJST: hoe dit eruitziet. jsdom doet geen layout en
 * evalueert geen media queries. Over RTL, breedtes of leesbaarheid doet geen
 * enkele assertie hier een uitspraak.
 */

const BLD = "11111111-1111-1111-1111-111111111111";

type Resultaat = { data: unknown; error: unknown };

const state: {
  rol: string;
  tabellen: Record<string, Resultaat>;
  zoekterm?: string;
} = { rol: "manager", tabellen: {} };

/** Een databasefout zoals PostgREST hem teruggeeft, mét vuile tekst. */
function dbFout(code: string) {
  return {
    code,
    message: 'relation "public.units" does not exist — org 9f3c, building Résidence Atlas',
    details: "Perhaps you meant the table public.unit",
    hint: null,
  };
}

function unit(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    building_id: BLD,
    label: `A${id}`,
    unit_type: "appartement",
    tantiemes: 100,
    floor: "1",
    area_m2: 75,
    ...over,
  };
}

function standaardTabellen(): Record<string, Resultaat> {
  return {
    buildings: { data: { id: BLD, name: "Résidence Atlas", total_tantiemes: 100 }, error: null },
    units: { data: [unit("1")], error: null },
    ownership: { data: [], error: null },
    owners: { data: [], error: null },
  };
}

/** Chainable én awaitable, net als de echte PostgREST-bouwer. */
function keten(resultaat: Resultaat) {
  const c: Record<string, unknown> = {};
  const zelf = () => c;
  Object.assign(c, {
    select: zelf,
    eq: zelf,
    in: zelf,
    order: zelf,
    maybeSingle: async () => resultaat,
    then: (res: (v: Resultaat) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resultaat).then(res, rej),
  });
  return c;
}

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => (key: string, waarden?: Record<string, unknown>) => {
    const basis = namespace ? `${namespace}.${key}` : key;
    return waarden ? `${basis}(${Object.values(waarden).join(",")})` : basis;
  },
  getLocale: async () => "fr",
}));

vi.mock("@/lib/org", () => ({
  requireOrg: async () => ({ role: state.rol, org: { id: "org-1", name: "Org" } }),
}));

vi.mock("@/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabel: string) => keten(state.tabellen[tabel] ?? { data: [], error: null }),
  }),
}));

// De formulieren zijn zelf async server components met een eigen suite; hier
// gaat het om de toestandskeuze van de PAGINA. Stubs houden dat scherp.
vi.mock("../src/app/[locale]/(app)/buildings/[id]/lots/LotForm", () => ({
  default: () => <div data-testid="lot-form" />,
}));
vi.mock("../src/app/[locale]/(app)/buildings/[id]/lots/OwnershipForms", () => ({
  LinkFirstOwnerForm: () => <div data-testid="link-form" />,
  TransferOwnershipForm: () => <div data-testid="transfer-form" />,
}));
vi.mock("../src/app/[locale]/(app)/buildings/[id]/lots/actions", () => ({
  createLot: async () => undefined,
  updateLot: async () => undefined,
  linkFirstOwner: async () => undefined,
  transferOwnership: async () => undefined,
}));

import LotsPage from "../src/app/[locale]/(app)/buildings/[id]/lots/page";

async function toon(q?: string) {
  const el = await LotsPage({
    params: Promise.resolve({ locale: "fr", id: BLD }),
    searchParams: Promise.resolve(q === undefined ? {} : { q }),
  });
  return render(el);
}

function tekst() {
  return (document.body.textContent ?? "").replace(/\s+/g, " ");
}

let logs: string[] = [];

beforeEach(() => {
  state.rol = "manager";
  state.tabellen = standaardTabellen();
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ══════════════════════════════════ NA DE SPLITSING: DE WAARSCHUWINGEN
/**
 * W* — de tantièmewaarschuwingen, GERENDERD.
 *
 * `M14` en `GR3` in `ownership.test.ts` toetsen dat de drie condities los in de
 * bron staan. Dat is noodzakelijk maar niet voldoende: een mutatie die
 * `!overzicht.eigendomVeilig` verandert in `false && !overzicht.eigendomVeilig`
 * laat die tekenreeks intact en blijft daar groen, terwijl de waarschuwing van
 * het scherm verdwijnt. Deze tests kijken naar wat er werkelijk staat.
 *
 * Ze horen ook bij de splitsing zelf: `LotsStats` is nu een eigen component, en
 * hier wordt bewezen dat de pagina en die component SAMEN dezelfde zichtbare
 * inhoud opleveren als voorheen.
 */
describe("W — de waarschuwingen staan er werkelijk, met hun eigen rol", () => {
  /** Een gebouw met alle drie de problemen tegelijk. */
  function drieProblemen() {
    state.tabellen.buildings = {
      data: { id: BLD, name: "Résidence Atlas", total_tantiemes: 1000 },
      error: null,
    };
    state.tabellen.units = {
      data: [unit("1", { tantiemes: 400 }), unit("2", { tantiemes: 0 })],
      error: null,
    };
    // Lot 1 heeft twee actieve eigenaars zonder aangewezen debiteur -> ambigu.
    state.tabellen.ownership = {
      data: [
        { id: "ow1", unit_id: "1", owner_id: "o1", share: 0.5, start_date: "2026-01-01", end_date: null, is_primary_debtor: false },
        { id: "ow2", unit_id: "1", owner_id: "o2", share: 0.5, start_date: "2026-01-01", end_date: null, is_primary_debtor: false },
        { id: "ow3", unit_id: "2", owner_id: "o1", share: 1, start_date: "2026-01-01", end_date: null, is_primary_debtor: true },
      ],
      error: null,
    };
    state.tabellen.owners = {
      data: [
        { id: "o1", full_name: "Youssef El Amrani", is_company: false, email: null, phone: null, language: "fr", is_mre: false },
        { id: "o2", full_name: "Fatima Zahra Bennani", is_company: false, email: null, phone: null, language: "fr", is_mre: false },
      ],
      error: null,
    };
  }

  it("W1 — alle drie de waarschuwingen staan tegelijk op het scherm", async () => {
    drieProblemen();
    await toon();

    // Eén oorzaak oplossen en tegen de volgende aanlopen is precies wat deze
    // drie onafhankelijke blokken moeten voorkomen.
    expect(tekst()).toContain("lots.tantiemes.warningOwnership");
    expect(tekst()).toContain("lots.tantiemes.warningZeroTantieme");
    expect(tekst()).toContain("lots.tantiemes.warningTantiemes");
  });

  it("W2 — de twee onvoorwaardelijke waarschuwingen zijn alerts, het controletotaal niet", async () => {
    drieProblemen();
    await toon();

    const alerts = [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent ?? "");
    const statussen = [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? "");

    expect(alerts.some((x) => x.includes("warningOwnership"))).toBe(true);
    expect(alerts.some((x) => x.includes("warningZeroTantieme"))).toBe(true);
    // Het controletotaal kent een gedocumenteerde afwijking in de engine.
    expect(statussen.some((x) => x.includes("warningTantiemes"))).toBe(true);
    expect(alerts.some((x) => x.includes("warningTantiemes"))).toBe(false);
  });

  it("W3 — een gezond gebouw toont GEEN enkele waarschuwing", async () => {
    // Bewijst dat W1 niet toevallig groen is: dezelfde assertie moet kunnen falen.
    state.tabellen.buildings = {
      data: { id: BLD, name: "Résidence Atlas", total_tantiemes: 100 },
      error: null,
    };
    state.tabellen.ownership = {
      data: [
        { id: "ow1", unit_id: "1", owner_id: "o1", share: 1, start_date: "2026-01-01", end_date: null, is_primary_debtor: true },
      ],
      error: null,
    };
    state.tabellen.owners = {
      data: [{ id: "o1", full_name: "Youssef El Amrani", is_company: false, email: null, phone: null, language: "fr", is_mre: false }],
      error: null,
    };
    await toon();

    for (const sleutel of ["warningOwnership", "warningZeroTantieme", "warningTantiemes"]) {
      expect(tekst(), sleutel).not.toContain(`lots.tantiemes.${sleutel}`);
    }
  });

  it("W4 — geldige mede-eigendom geeft een toelichting, geen waarschuwing", async () => {
    state.tabellen.buildings = {
      data: { id: BLD, name: "Résidence Atlas", total_tantiemes: 100 },
      error: null,
    };
    state.tabellen.ownership = {
      data: [
        { id: "ow1", unit_id: "1", owner_id: "o1", share: 0.5, start_date: "2026-01-01", end_date: null, is_primary_debtor: true },
        { id: "ow2", unit_id: "1", owner_id: "o2", share: 0.5, start_date: "2026-01-01", end_date: null, is_primary_debtor: false },
      ],
      error: null,
    };
    state.tabellen.owners = {
      data: [
        { id: "o1", full_name: "Youssef El Amrani", is_company: false, email: null, phone: null, language: "fr", is_mre: false },
        { id: "o2", full_name: "Fatima Zahra Bennani", is_company: false, email: null, phone: null, language: "fr", is_mre: false },
      ],
      error: null,
    };
    await toon();

    expect(tekst()).toContain("lots.tantiemes.coOwnershipNote");
    expect(tekst()).not.toContain("lots.tantiemes.warningOwnership");
  });

  it("W5 — de tabel en de actielijst tonen hetzelfde lot, uit hetzelfde viewmodel", async () => {
    drieProblemen();
    await toon();

    // De tabelrij van lot 1 én zijn actiekaart; twee secties, één bron.
    expect(screen.getAllByText("A1").length).toBeGreaterThanOrEqual(2);
    expect(tekst()).toContain("lots.status.ambigu");
    // De debiteurmarkering hoort NIET bij een ambigu lot zonder primaire rij.
    expect(tekst()).not.toContain("lots.primaryDebtor");
  });
});

// ══════════════════════════════════ BESTAAND GEDRAG VASTLEGGEN
describe("B — bestaand gedrag vastleggen: mislukt is nooit leeg", () => {
  it("B1 (bestaand) — een mislukte gebouwquery toont de foutmelding, geen lege lijst", async () => {
    state.tabellen.buildings = { data: null, error: dbFout("42P01") };
    await toon();

    expect(screen.getByTestId("lots-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("lots-empty")).toBeNull();
    expect(screen.queryByTestId("lots-no-results")).toBeNull();
    expect(document.querySelector("table")).toBeNull();
  });

  it("B2 (bestaand) — een mislukte unitsquery leest NOOIT als 'geen lots'", async () => {
    state.tabellen.units = { data: null, error: dbFout("42501") };
    await toon();

    expect(screen.getByTestId("lots-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("lots-empty")).toBeNull();
    expect(tekst()).not.toContain("lots.empty.title");
  });

  it("B3 (bestaand) — een mislukte eigendomsquery toont nooit 'geen eigenaar'", async () => {
    state.tabellen.ownership = { data: null, error: dbFout("42501") };
    await toon();

    expect(screen.getByTestId("lots-unavailable")).toBeTruthy();
    expect(tekst()).not.toContain("lots.noOwner");
    expect(document.querySelector("table")).toBeNull();
  });

  it("B4 (bestaand) — een mislukte eigenarenquery onderdrukt eveneens alles", async () => {
    state.tabellen.owners = { data: null, error: dbFout("08006") };
    await toon();

    expect(screen.getByTestId("lots-unavailable")).toBeTruthy();
    expect(document.querySelector("table")).toBeNull();
  });

  it("B5 (bestaand) — nul lots met geslaagde queries is de LEGE toestand", async () => {
    state.tabellen.units = { data: [], error: null };
    await toon();

    expect(screen.getByTestId("lots-empty")).toBeTruthy();
    expect(screen.queryByTestId("lots-unavailable")).toBeNull();
    expect(tekst()).toContain("lots.empty.title");
  });

  it("B6 (bestaand) — een zoekterm zonder treffer is iets anders dan leeg", async () => {
    await toon("bestaat-niet");

    expect(screen.getByTestId("lots-no-results")).toBeTruthy();
    expect(screen.queryByTestId("lots-empty")).toBeNull();
    expect(screen.queryByTestId("lots-unavailable")).toBeNull();
  });

  it("B7 (bestaand) — een onbekend gebouw is geen storing maar een eigen melding", async () => {
    state.tabellen.buildings = { data: null, error: null };
    await toon();

    expect(tekst()).toContain("lots.notFound");
    expect(screen.queryByTestId("lots-unavailable")).toBeNull();
  });
});

// ══════════════════════════════════ NIEUW
describe("N — nieuw: alleen-lezen en het gesaneerde log", () => {
  it("N1 (nieuw) — een lezer krijgt uitleg in plaats van stilte", async () => {
    state.rol = "reader";
    await toon();

    const melding = screen.getByTestId("lots-readonly");
    expect(melding.getAttribute("role")).toBe("status");
    expect(tekst()).toContain("lots.readOnly.title");
    expect(tekst()).toContain("lots.readOnly.body");
  });

  it("N2 (nieuw) — de melding is geen alert: lezen is een geldige rol", async () => {
    state.rol = "reader";
    await toon();
    expect(screen.getByTestId("lots-readonly").getAttribute("role")).not.toBe("alert");
  });

  it("N3 (nieuw) — een schrijver ziet de melding niet, en houdt zijn formulier", async () => {
    state.rol = "manager";
    await toon();

    expect(screen.queryByTestId("lots-readonly")).toBeNull();
    expect(screen.getAllByTestId("lot-form").length).toBeGreaterThan(0);
  });

  it("N4 (nieuw) — de poort blijft ongewijzigd: een lezer krijgt geen enkel formulier", async () => {
    state.rol = "reader";
    await toon();

    expect(screen.queryByTestId("lot-form")).toBeNull();
    expect(screen.queryByTestId("link-form")).toBeNull();
    expect(screen.queryByTestId("transfer-form")).toBeNull();
  });

  it("N5 (nieuw) — elke schrijvende rol houdt schrijfrecht, alleen reader niet", async () => {
    for (const rol of ["owner", "admin", "manager", "accountant"]) {
      cleanup();
      state.rol = rol;
      await toon();
      expect(screen.queryByTestId("lots-readonly"), rol).toBeNull();
    }
    cleanup();
    state.rol = "reader";
    await toon();
    expect(screen.getByTestId("lots-readonly")).toBeTruthy();
  });

  it("N6 (nieuw) — de drie toestanden zijn niet verwisselbaar", async () => {
    const gevallen: Array<[string, () => void, string, string[]]> = [
      [
        "leeg",
        () => {
          state.tabellen.units = { data: [], error: null };
        },
        "lots.empty.title",
        ["lots.loadError.title", "lots.search.none"],
      ],
      [
        "onbeschikbaar",
        () => {
          state.tabellen.units = { data: null, error: dbFout("42501") };
        },
        "lots.loadError.title",
        ["lots.empty.title", "lots.search.none"],
      ],
    ];

    for (const [naam, opzet, eigen, vreemd] of gevallen) {
      cleanup();
      state.tabellen = standaardTabellen();
      opzet();
      await toon();
      expect(tekst(), `${naam} mist zijn eigen sleutel`).toContain(eigen);
      for (const anders of vreemd) {
        expect(tekst(), `${naam} leent de sleutel van ${anders}`).not.toContain(anders);
      }
    }

    // De derde apart: die heeft een zoekterm nodig.
    cleanup();
    state.tabellen = standaardTabellen();
    await toon("bestaat-niet");
    expect(tekst()).toContain("lots.search.none");
    expect(tekst()).not.toContain("lots.empty.title");
    expect(tekst()).not.toContain("lots.loadError.title");
  });

  it("N7 (nieuw) — het serverlog onderscheidt gebouwquery van bronquery", async () => {
    state.tabellen.buildings = { data: null, error: dbFout("42P01") };
    await toon();
    expect(logs.join(" ")).toContain("scope=building");
    expect(logs.join(" ")).toContain("buildings:42P01");

    cleanup();
    logs = [];
    state.tabellen = standaardTabellen();
    state.tabellen.ownership = { data: null, error: dbFout("42501") };
    await toon();
    expect(logs.join(" ")).toContain("scope=sources");
    expect(logs.join(" ")).toContain("ownership:42501");
    expect(logs.join(" ")).not.toContain("scope=building");
  });

  it("N8 (nieuw) — het log lekt geen databasetekst, geen namen, geen id's", async () => {
    state.tabellen.units = { data: null, error: dbFout("42501") };
    await toon();

    const alles = logs.join(" ");
    expect(alles).not.toContain("does not exist");
    expect(alles).not.toContain("Résidence Atlas");
    expect(alles).not.toContain("Perhaps you meant");
    expect(alles).not.toContain(BLD);
    expect(alles).not.toContain("org-1");
  });

  it("N9 (nieuw) — de GEBRUIKER ziet in beide gevallen dezelfde melding", async () => {
    state.tabellen.buildings = { data: null, error: dbFout("42P01") };
    await toon();
    const viaGebouw = tekst();

    cleanup();
    state.tabellen = standaardTabellen();
    state.tabellen.owners = { data: null, error: dbFout("08006") };
    await toon();

    // Welke tabel faalde is interne structuur; dat hoort niet op het scherm.
    expect(tekst()).toContain("lots.loadError.title");
    expect(viaGebouw).toContain("lots.loadError.title");
    for (const woord of ["buildings", "units", "ownership", "owners", "42P01", "08006"]) {
      expect(tekst(), `"${woord}" lekt naar het scherm`).not.toContain(woord);
    }
  });

  it("N10 (nieuw) — lots.readOnly bestaat in FR, NL en AR en is echt vertaald", () => {
    const talen: Array<[string, Record<string, unknown>]> = [
      ["fr", fr as Record<string, unknown>],
      ["nl", nl as Record<string, unknown>],
      ["ar", ar as Record<string, unknown>],
    ];

    for (const sleutel of ["title", "body"]) {
      const waarden = talen.map(([, taal]) => {
        const lots = taal.lots as Record<string, unknown>;
        return (lots.readOnly as Record<string, string>)?.[sleutel];
      });
      for (const [i, w] of waarden.entries()) {
        expect(typeof w, `${talen[i][0]}.readOnly.${sleutel}`).toBe("string");
        expect((w as string).trim().length).toBeGreaterThan(0);
      }
      expect(new Set(waarden).size, `readOnly.${sleutel} is niet in drie talen vertaald`).toBe(3);
    }

    const arLots = (ar as Record<string, unknown>).lots as Record<string, unknown>;
    expect((arLots.readOnly as Record<string, string>).title).toMatch(/[؀-ۿ]/);
  });
});

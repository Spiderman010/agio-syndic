// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";
import { bouwChecklist, type Checklist, type StapSleutel } from "@/lib/wizard";
import type { BlockRow, LayoutUnitRow } from "@/lib/layout";
import type { OwnershipRow } from "@/lib/ownership";

/**
 * De INSTELCHECKLIST van één gebouw.
 *
 * Twee lagen, bewust gescheiden:
 *
 *   W*  de rekenkern (`bouwChecklist`). Elke stapstand is een pure functie van
 *       de data en wordt hier rechtstreeks getoetst — zonder render, zonder
 *       mocks.
 *
 *   P*  de pagina. Daar gaat het om het DATAPAD (onderdrukt één mislukking
 *       werkelijk de hele checklist?) en om het feit dat dit scherm NIETS
 *       muteert.
 *
 * WAT HIER NIET WORDT BEWEZEN: hoe dit eruitziet. jsdom doet geen layout en
 * evalueert geen media queries. Over de voortgangsbalk, de kolommen op 360px of
 * de RTL-spiegeling doet geen enkele assertie hier een uitspraak.
 */

const REPO = join(__dirname, "..");
const BLD = "11111111-1111-1111-1111-111111111111";
const ANDER = "22222222-2222-2222-2222-222222222222";

function blok(over: Partial<BlockRow> & { id: string }): BlockRow {
  return {
    building_id: BLD,
    code: over.id.toUpperCase(),
    name: null,
    sort_order: 0,
    archived_at: null,
    ...over,
  };
}

function unit(over: Partial<LayoutUnitRow> & { id: string }): LayoutUnitRow {
  return {
    building_id: BLD,
    block_id: null,
    label: over.id.toUpperCase(),
    unit_type: "appartement",
    tantiemes: 100,
    ...over,
  };
}

function own(over: Partial<OwnershipRow> & { id: string; unit_id: string }): OwnershipRow {
  return {
    owner_id: "o1",
    share: 1,
    start_date: "2026-01-01",
    end_date: null,
    is_primary_debtor: true,
    ...over,
  } as OwnershipRow;
}

function checklist(over: Partial<Parameters<typeof bouwChecklist>[0]> = {}): Checklist {
  return bouwChecklist({
    buildingId: BLD,
    blocks: [],
    units: [],
    ownership: [],
    aantalEigenaren: 0,
    ...over,
  });
}

const stap = (c: Checklist, sleutel: StapSleutel) =>
  c.stappen.find((s) => s.sleutel === sleutel)!;
const stand = (c: Checklist, sleutel: StapSleutel) => stap(c, sleutel).stand;

// ══════════════════════════════════════════════════════ rekenkern
describe("W — de stappen en hun volgorde", () => {
  it("W1 — vijf stappen, in vaste volgorde, met oplopende nummers", () => {
    const c = checklist();
    expect(c.stappen.map((s) => s.sleutel)).toEqual([
      "gebouw",
      "blokken",
      "lots",
      "eigenaren",
      "koppelen",
    ]);
    expect(c.stappen.map((s) => s.nummer)).toEqual([1, 2, 3, 4, 5]);
    expect(c.totaal).toBe(5);
  });

  it("W2 — elke stap wijst naar een BESTAAND scherm, nooit naar de wizard zelf", () => {
    const c = checklist();
    expect(stap(c, "gebouw").href).toBe(`/buildings/${BLD}`);
    expect(stap(c, "blokken").href).toBe(`/buildings/${BLD}/indeling`);
    expect(stap(c, "lots").href).toBe(`/buildings/${BLD}/indeling`);
    expect(stap(c, "eigenaren").href).toBe("/owners");
    expect(stap(c, "koppelen").href).toBe(`/buildings/${BLD}/lots`);
    for (const s of c.stappen) {
      expect(s.href, s.sleutel).not.toContain("/wizard");
    }
  });

  it("W3 — stap 1 is af zodra deze checklist bestaat", () => {
    // De pagina rendert alleen voor een gebouw dat bestaat; dan is stap 1 af.
    expect(stand(checklist(), "gebouw")).toBe("klaar");
  });
});

describe("W — blokken zijn optioneel, nooit een fout", () => {
  it("W4 — nul blokken is OPTIONEEL, niet 'te doen' en niet fout", () => {
    const s = stand(checklist(), "blokken");
    expect(s).toBe("optioneel");
    // Expliciet: geen van de standen die werk of een probleem suggereren.
    expect(s).not.toBe("tedoen");
    expect(s).not.toBe("bezig");
  });

  it("W5 — nul blokken telt toch als 'gedaan' voor de voortgang", () => {
    // Anders zou een gebouw zonder blokken nooit 5 van 5 kunnen halen.
    const c = checklist({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1" })],
      aantalEigenaren: 1,
    });
    expect(stand(c, "blokken")).toBe("optioneel");
    expect(c.gedaan).toBe(5);
    expect(c.compleet).toBe(true);
  });

  it("W6 — met blokken is de stap klaar en staat het aantal erbij", () => {
    const c = checklist({ blocks: [blok({ id: "a" }), blok({ id: "b" })] });
    expect(stand(c, "blokken")).toBe("klaar");
    expect(stap(c, "blokken").waarden.aantal).toBe(2);
  });

  it("W7 — een GEARCHIVEERD blok telt niet als 'heeft blokken'", () => {
    const c = checklist({
      blocks: [blok({ id: "oud", archived_at: "2026-01-01T00:00:00Z" })],
    });
    expect(stand(c, "blokken")).toBe("optioneel");
    expect(stap(c, "blokken").waarden.aantal).toBe(0);
  });
});

describe("W — lots en eigenaren", () => {
  it("W8 — nul lots is 'nog te doen'", () => {
    expect(stand(checklist(), "lots")).toBe("tedoen");
    expect(stap(checklist(), "lots").waarden.aantal).toBe(0);
  });

  it("W9 — het lotsaantal komt uit de data", () => {
    const c = checklist({ units: [unit({ id: "u1" }), unit({ id: "u2" }), unit({ id: "u3" })] });
    expect(stand(c, "lots")).toBe("klaar");
    expect(stap(c, "lots").waarden.aantal).toBe(3);
  });

  it("W10 — eigenaren worden ORGANISATIEBREED geteld, niet per gebouw", () => {
    // Een eigenaar bestaat los van een gebouw; de vraag is of er iemand is om
    // te koppelen. Zou dit per gebouw tellen, dan zou stap 4 na het eerste
    // gebouw altijd opnieuw "te doen" worden.
    const c = checklist({ aantalEigenaren: 4 });
    expect(stand(c, "eigenaren")).toBe("klaar");
    expect(stap(c, "eigenaren").waarden.aantal).toBe(4);
    expect(stand(checklist({ aantalEigenaren: 0 }), "eigenaren")).toBe("tedoen");
  });
});

describe("W — koppelen", () => {
  const drieLots = [unit({ id: "u1" }), unit({ id: "u2" }), unit({ id: "u3" })];

  it("W11 — x van y en z vrij komen uit de eigendomsrijen", () => {
    const c = checklist({
      units: drieLots,
      ownership: [own({ id: "ow1", unit_id: "u1" }), own({ id: "ow2", unit_id: "u2" })],
      aantalEigenaren: 2,
    });
    expect(stap(c, "koppelen").waarden).toEqual({ gekoppeld: 2, totaal: 3, vrij: 1 });
    expect(stand(c, "koppelen")).toBe("bezig");
  });

  it("W12 — alles gekoppeld is klaar", () => {
    const c = checklist({
      units: drieLots,
      ownership: drieLots.map((u, i) => own({ id: `ow${i}`, unit_id: u.id })),
      aantalEigenaren: 1,
    });
    expect(stand(c, "koppelen")).toBe("klaar");
    expect(stap(c, "koppelen").waarden.vrij).toBe(0);
  });

  it("W13 — een BEËINDIGDE eigendom telt niet als gekoppeld", () => {
    const c = checklist({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1", end_date: "2026-06-01" })],
      aantalEigenaren: 1,
    });
    expect(stap(c, "koppelen").waarden.gekoppeld).toBe(0);
    expect(stand(c, "koppelen")).toBe("tedoen");
  });

  it("W14 — een niet-hoofdelijke eigendom wijst hier geen eigenaar aan", () => {
    // Dezelfde regel als op het indelingsscherm; die komt uit `actueleEigendom`
    // en wordt hier niet opnieuw bedacht.
    const c = checklist({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1", is_primary_debtor: false })],
      aantalEigenaren: 1,
    });
    expect(stap(c, "koppelen").waarden.gekoppeld).toBe(0);
  });

  it("W15 — zonder lots is koppelen niet 'te doen' maar 'later'", () => {
    // Iemand naar het koppelscherm sturen waar niets te koppelen valt, is een
    // taak die niet bestaat.
    const c = checklist({ aantalEigenaren: 3 });
    expect(stand(c, "koppelen")).toBe("wacht");
  });

  it("W16 — zonder ook maar één eigenaar evenmin", () => {
    const c = checklist({ units: drieLots, aantalEigenaren: 0 });
    expect(stand(c, "koppelen")).toBe("wacht");
  });

  it("W17 — 'later' telt NIET als gedaan", () => {
    const c = checklist({ units: drieLots, aantalEigenaren: 0 });
    expect(stand(c, "koppelen")).toBe("wacht");
    expect(c.compleet).toBe(false);
  });
});

describe("W — gebouwscope", () => {
  it("W18 — blokken, lots en eigendom van een ANDER gebouw tellen niet mee", () => {
    const c = checklist({
      blocks: [blok({ id: "eigen" }), blok({ id: "vreemd", building_id: ANDER })],
      units: [unit({ id: "u1" }), unit({ id: "vreemd", building_id: ANDER })],
      ownership: [
        own({ id: "ow1", unit_id: "u1" }),
        // Eigendom op een lot van een ander gebouw: mag de teller niet raken.
        own({ id: "ow2", unit_id: "vreemd" }),
      ],
      aantalEigenaren: 1,
    });

    expect(stap(c, "blokken").waarden.aantal).toBe(1);
    expect(stap(c, "lots").waarden.aantal).toBe(1);
    expect(stap(c, "koppelen").waarden).toEqual({ gekoppeld: 1, totaal: 1, vrij: 0 });
  });

  it("W19 — eigendom op een ONBEKEND lot verhoogt de teller niet", () => {
    const c = checklist({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "bestaat-niet" })],
      aantalEigenaren: 1,
    });
    expect(stap(c, "koppelen").waarden.gekoppeld).toBe(0);
  });
});

describe("W — voortgang", () => {
  it("W20 — gedaan telt alleen klaar en optioneel", () => {
    const c = checklist();
    // gebouw klaar + blokken optioneel = 2; lots/eigenaren tedoen, koppelen wacht.
    expect(c.gedaan).toBe(2);
    expect(c.compleet).toBe(false);
  });

  it("W21 — compleet is precies alle stappen gedaan", () => {
    const c = checklist({
      blocks: [blok({ id: "a" })],
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1" })],
      aantalEigenaren: 1,
    });
    expect(c.gedaan).toBe(5);
    expect(c.compleet).toBe(true);
  });
});

// ══════════════════════════════════════════════════════ pagina
type Resultaat = { data: unknown; error: unknown };

const state: { tabellen: Record<string, Resultaat>; rol: string } = { tabellen: {}, rol: "manager" };

function dbFout(code: string) {
  return {
    code,
    message: 'relation "public.blocks" does not exist — org 9f3c, Résidence Atlas',
    details: "Perhaps you meant public.block",
    hint: null,
  };
}

function standaard(): Record<string, Resultaat> {
  return {
    buildings: { data: { id: BLD, name: "Résidence Atlas" }, error: null },
    blocks: { data: [blok({ id: "a" })], error: null },
    units: { data: [unit({ id: "u1" }), unit({ id: "u2" })], error: null },
    ownership: { data: [own({ id: "ow1", unit_id: "u1" })], error: null },
    owners: { data: [{ id: "o1", full_name: "Youssef El Amrani" }], error: null },
  };
}

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
  getTranslations: async (ns?: string) => (key: string, waarden?: Record<string, unknown>) => {
    const basis = ns ? `${ns}.${key}` : key;
    return waarden ? `${basis}(${Object.values(waarden).join(",")})` : basis;
  },
  getLocale: async () => "fr",
}));

vi.mock("@/lib/org", () => ({
  requireOrg: async () => ({ role: state.rol, org: { id: "org-1", name: "Org" } }),
}));

vi.mock("@/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabel: string) => keten(state.tabellen[tabel] ?? { data: [], error: null }),
  }),
}));

import WizardPage from "../src/app/[locale]/(app)/buildings/[id]/wizard/page";

async function toon() {
  return render(await WizardPage({ params: Promise.resolve({ id: BLD }) }));
}

const tekst = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const standVan = (sleutel: string) =>
  screen.getByTestId(`wizard-stap-${sleutel}`).getAttribute("data-stand");

let logs: string[] = [];

beforeEach(() => {
  state.rol = "manager";
  state.tabellen = standaard();
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("P — het datapad is fail-closed", () => {
  for (const bron of ["blocks", "units", "ownership", "owners"]) {
    it(`P1.${bron} — een mislukte ${bron}-query onderdrukt de HELE checklist`, async () => {
      state.tabellen[bron] = { data: null, error: dbFout("42501") };
      await toon();

      expect(screen.getByTestId("wizard-unavailable")).toBeTruthy();
      // En vooral: NERGENS een valse nulstand of "niets te doen".
      expect(document.querySelector("[data-testid^='wizard-stap-']")).toBeNull();
      expect(screen.queryByTestId("wizard-voortgang")).toBeNull();
    });
  }

  it("P2 — een mislukte lotsquery zegt NIET 'nog geen lots'", async () => {
    // Dit is de hele reden voor fail-closed op dit scherm: wie 28 lots heeft en
    // "nog geen lots — voeg toe" leest, voert ze opnieuw in.
    state.tabellen.units = { data: null, error: dbFout("42501") };
    await toon();

    expect(screen.queryByTestId("wizard-stap-lots")).toBeNull();
    expect(tekst()).not.toContain("steps.lots.tedoen");
    expect(tekst()).toContain("wizard.loadError.title");
  });

  it("P3 — een mislukte eigendomsquery zet NIET alles op 'nog te koppelen'", async () => {
    state.tabellen.ownership = { data: null, error: dbFout("42501") };
    await toon();
    expect(screen.queryByTestId("wizard-stap-koppelen")).toBeNull();
    expect(tekst()).not.toContain("steps.koppelen.tedoen");
  });

  it("P4 — geslaagd en leeg is iets anders dan mislukt", async () => {
    state.tabellen.blocks = { data: [], error: null };
    state.tabellen.units = { data: [], error: null };
    state.tabellen.ownership = { data: [], error: null };
    state.tabellen.owners = { data: [], error: null };
    await toon();

    expect(screen.queryByTestId("wizard-unavailable")).toBeNull();
    expect(standVan("blokken")).toBe("optioneel");
    expect(standVan("lots")).toBe("tedoen");
  });

  it("P5 — de fouttoestand is een alert", async () => {
    state.tabellen.owners = { data: null, error: dbFout("08006") };
    await toon();
    expect(screen.getByTestId("wizard-unavailable").getAttribute("role")).toBe("alert");
  });

  it("P6 — een onbekend gebouw is geen storing", async () => {
    state.tabellen.buildings = { data: null, error: null };
    await toon();
    expect(screen.getByTestId("wizard-notfound").getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("wizard-unavailable")).toBeNull();
  });

  it("P7 — een mislukte gebouwquery is er WEL een", async () => {
    state.tabellen.buildings = { data: null, error: dbFout("42P01") };
    await toon();
    expect(screen.getByTestId("wizard-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("wizard-notfound")).toBeNull();
  });
});

describe("P — wat er op het scherm komt", () => {
  it("P8 — alle vijf stappen met hun stand uit de data", async () => {
    await toon();
    expect(standVan("gebouw")).toBe("klaar");
    expect(standVan("blokken")).toBe("klaar");
    expect(standVan("lots")).toBe("klaar");
    expect(standVan("eigenaren")).toBe("klaar");
    // Eén van twee lots gekoppeld.
    expect(standVan("koppelen")).toBe("bezig");
  });

  it("P9 — de samenvatting draagt de getallen", async () => {
    await toon();
    // 1 gekoppeld, 2 totaal, 1 vrij — in die volgorde uit `waarden`.
    expect(tekst()).toContain("steps.koppelen.bezig(1,2,1)");
  });

  it("P10 — de links wijzen naar de bestaande schermen", async () => {
    await toon();
    expect(screen.getByTestId("wizard-link-blokken").getAttribute("href")).toBe(
      `/buildings/${BLD}/indeling`,
    );
    expect(screen.getByTestId("wizard-link-eigenaren").getAttribute("href")).toBe("/owners");
    expect(screen.getByTestId("wizard-link-koppelen").getAttribute("href")).toBe(
      `/buildings/${BLD}/lots`,
    );
  });

  it("P11 — de afrondlink verschijnt alleen als alles af is", async () => {
    await toon();
    expect(screen.queryByTestId("wizard-compleet")).toBeNull();

    cleanup();
    state.tabellen.ownership = {
      data: [own({ id: "ow1", unit_id: "u1" }), own({ id: "ow2", unit_id: "u2" })],
      error: null,
    };
    await toon();
    expect(screen.getByTestId("wizard-naar-indeling").getAttribute("href")).toBe(
      `/buildings/${BLD}/indeling`,
    );
  });

  it("P12 — GEBOUWSCOPE: een lot van een ander gebouw komt niet in de tellingen", async () => {
    state.tabellen.units = {
      data: [unit({ id: "u1" }), unit({ id: "vreemd", building_id: ANDER })],
      error: null,
    };
    await toon();
    expect(tekst()).toContain("steps.lots.klaar(1)");
    expect(tekst()).not.toContain("steps.lots.klaar(2)");
  });
});

describe("P — dit scherm muteert niets", () => {
  it("P13 — er staat geen enkel formulier en geen submitknop op de pagina", async () => {
    await toon();
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("button[type='submit']")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
  });

  it("P14 — de bron importeert geen enkele server action", () => {
    // Structureel, niet via render: een import die er niet is, kan ook niet per
    // ongeluk aangeroepen worden. Dit is de belofte van deze hele PR.
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "wizard", "page.tsx"),
      "utf8",
    );
    expect(bron).not.toMatch(/from\s+"\.\.?\/.*actions"/);
    expect(bron).not.toContain("ActionForm");
    expect(bron).not.toContain("SubmitButton");
    // En ook geen directe schrijfoperatie op de database.
    for (const verboden of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(bron, `${verboden} hoort hier niet`).not.toContain(verboden);
    }
  });

  it("P15 — een LEZER ziet dezelfde checklist, met een leesmelding", async () => {
    state.rol = "reader";
    await toon();

    // De stand weten is geen schrijfrecht.
    expect(standVan("lots")).toBe("klaar");
    expect(screen.getByTestId("wizard-readonly").getAttribute("role")).toBe("status");
    expect(document.querySelector("form")).toBeNull();
  });

  it("P16 — een lezer krijgt 'bekijken'-teksten, geen 'toevoegen'", async () => {
    // Iemand naar "blok toevoegen" sturen terwijl hij dat niet mag, is een val.
    state.rol = "reader";
    await toon();
    expect(tekst()).toContain("steps.blokken.view");
    expect(tekst()).not.toContain("steps.blokken.action");

    cleanup();
    state.rol = "manager";
    await toon();
    expect(tekst()).toContain("steps.blokken.action");
    expect(tekst()).not.toContain("steps.blokken.view");
  });

  it("P21 — nul blokken krijgt GEEN waarschuwings- of fouttoon", async () => {
    /**
     * De STAND is `optioneel` (W4 pint dat). Maar een badge met `warn` of `crit`
     * zou een gebouw zonder blokken alsnog als probleem tonen, en dan maakt de
     * naam van de stand niets uit. Daarom wordt hier de werkelijk gerenderde
     * toon getoetst, niet de stand.
     *
     * jsdom evalueert geen CSS, dus dit zegt niets over de KLEUR — alleen dat de
     * klasse die naar waarschuwing of fout wijst er niet op staat.
     */
    state.tabellen.blocks = { data: [], error: null };
    // Ook geen lots: die stap dient hieronder als CONTRAST, en die moet dan
    // werkelijk "nog te doen" zijn in plaats van "klaar".
    state.tabellen.units = { data: [], error: null };
    await toon();

    const kaart = screen.getByTestId("wizard-stap-blokken");
    expect(kaart.getAttribute("data-stand")).toBe("optioneel");

    const badge = kaart.querySelector(".badge");
    expect(badge, "de blokkenstap hoort een badge te hebben").toBeTruthy();
    const klassen = badge?.className ?? "";
    for (const toon of ["text-warn", "bg-warn-soft", "text-crit", "bg-crit-soft"]) {
      expect(klassen, `nul blokken krijgt "${toon}"`).not.toContain(toon);
    }

    // En om te bewijzen dat deze assertie kán falen: een stap die WEL werk
    // vraagt, krijgt die toon juist wel.
    const lots = screen.getByTestId("wizard-stap-lots");
    expect(lots.getAttribute("data-stand")).toBe("tedoen");
    expect(lots.querySelector(".badge")?.className ?? "").toContain("text-warn");
  });

  it("P17 — een schrijver krijgt géén leesmelding", async () => {
    await toon();
    expect(screen.queryByTestId("wizard-readonly")).toBeNull();
  });
});

describe("P — het log lekt niets", () => {
  it("P18 — bron en SQLSTATE worden onderscheiden", async () => {
    state.tabellen.buildings = { data: null, error: dbFout("42P01") };
    await toon();
    expect(logs.join(" ")).toContain("scope=building");
    expect(logs.join(" ")).toContain("buildings:42P01");

    cleanup();
    logs = [];
    state.tabellen = standaard();
    state.tabellen.units = { data: null, error: dbFout("42501") };
    await toon();
    expect(logs.join(" ")).toContain("scope=sources");
    expect(logs.join(" ")).toContain("units:42501");
  });

  it("P19 — geen databasetekst, geen namen, geen id's in het log", async () => {
    state.tabellen.ownership = { data: null, error: dbFout("42501") };
    await toon();
    const alles = logs.join(" ");
    for (const verboden of [
      "does not exist",
      "Résidence Atlas",
      "Perhaps you meant",
      BLD,
      "org-1",
    ]) {
      expect(alles, `"${verboden}" lekt naar het log`).not.toContain(verboden);
    }
  });

  it("P20 — en niets daarvan naar het scherm", async () => {
    state.tabellen.owners = { data: null, error: dbFout("08006") };
    await toon();
    for (const verboden of ["blocks", "units", "ownership", "owners", "42501", "08006", "does not exist"]) {
      expect(tekst(), `"${verboden}" lekt naar het scherm`).not.toContain(verboden);
    }
  });
});

// ══════════════════════════════════════════════════════ vertalingen
describe("I — vertalingen", () => {
  const TALEN: Array<[string, Record<string, unknown>]> = [
    ["fr", fr as Record<string, unknown>],
    ["nl", nl as Record<string, unknown>],
    ["ar", ar as Record<string, unknown>],
  ];

  const plat = (o: Record<string, unknown>, pad = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? plat(v as Record<string, unknown>, `${pad}${k}.`)
        : [`${pad}${k}`],
    );

  const ns = (berichten: Record<string, unknown>) => berichten.wizard as Record<string, unknown>;

  it("I1 — de wizard-namespace heeft in alle drie de talen dezelfde sleutels", () => {
    const verwacht = plat(ns(TALEN[0][1])).sort();
    expect(verwacht.length).toBeGreaterThan(30);
    for (const [naam, berichten] of TALEN) {
      expect(plat(ns(berichten)).sort(), naam).toEqual(verwacht);
    }
  });

  it("I2 — ELKE stand van elke stap heeft een zin", () => {
    // De pagina bouwt de sleutel op als `steps.<stap>.<stand>`. Ontbreekt er
    // één combinatie, dan krijgt een gebruiker de sleutelnaam te zien — en
    // alleen in precies die toestand, dus dat valt anders pas laat op.
    const STAPPEN = ["gebouw", "blokken", "lots", "eigenaren", "koppelen"];
    const STANDEN = ["klaar", "bezig", "tedoen", "optioneel", "wacht"];
    for (const [naam, berichten] of TALEN) {
      const steps = ns(berichten).steps as Record<string, Record<string, unknown>>;
      for (const s of STAPPEN) {
        for (const stnd of [...STANDEN, "title", "action", "view"]) {
          expect(typeof steps[s]?.[stnd], `${naam}: steps.${s}.${stnd}`).toBe("string");
        }
      }
      const standen = ns(berichten).stand as Record<string, unknown>;
      for (const stnd of STANDEN) {
        expect(typeof standen[stnd], `${naam}: stand.${stnd}`).toBe("string");
      }
    }
  });

  it("I3 — geen lege waarde, geen onvertaalde kopie tussen fr en nl", () => {
    const frW = plat(ns(fr as Record<string, unknown>));
    const lees = (berichten: Record<string, unknown>, pad: string) =>
      pad.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], ns(berichten));

    for (const pad of frW) {
      const a = String(lees(fr as Record<string, unknown>, pad));
      const b = String(lees(nl as Record<string, unknown>, pad));
      expect(a.trim(), `fr.wizard.${pad} is leeg`).not.toBe("");
      expect(b.trim(), `nl.wizard.${pad} is leeg`).not.toBe("");
      // Alleen meerwoordige, letterhoudende waarden — en een interpolatie is
      // GEEN woord. `"{aantal} lot(s)."` is in het Frans en Nederlands terecht
      // gelijk: "lot" is in beide talen hetzelfde woord. Zonder deze regel
      // eist de test een verschil dat er niet hoort te zijn.
      const woorden = a.replace(/\{[^}]*\}/g, " ").trim();
      if (!/\p{L}/u.test(woorden) || woorden.split(/\s+/).length < 2) continue;
      expect(b, `nl.wizard.${pad} is niet vertaald`).not.toBe(a);
    }
  });

  it("I4 — de interpolaties overleven de vertaling", () => {
    const paren: Array<[string, string[]]> = [
      ["subtitle", ["{building}"]],
      ["stepLabel", ["{nummer}"]],
      ["progress.count", ["{gedaan}", "{totaal}"]],
      ["steps.blokken.klaar", ["{aantal}"]],
      ["steps.lots.klaar", ["{aantal}"]],
      ["steps.eigenaren.klaar", ["{aantal}"]],
      ["steps.koppelen.bezig", ["{gekoppeld}", "{totaal}", "{vrij}"]],
    ];
    for (const [naam, berichten] of TALEN) {
      for (const [pad, tokens] of paren) {
        const waarde = String(
          pad.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], ns(berichten)),
        );
        for (const token of tokens) {
          expect(waarde, `${naam}: wizard.${pad} mist ${token}`).toContain(token);
        }
      }
    }
  });

  it("I7 — geen enkele zin vraagt een waarde die zijn stap niet meestuurt", () => {
    /**
     * De pagina roept `t("steps.<stap>.<stand>", stap.waarden)` aan. Staat er in
     * een vertaling een `{token}` die die stap niet levert, dan gooit next-intl —
     * en alleen in precies die stand. Dat is een fout die maanden kan sluimeren
     * en dan opduikt bij de ene klant met nul blokken.
     *
     * Hieronder staan de waarden die `bouwChecklist` per stap WERKELIJK meegeeft,
     * uit de kern gelezen en niet overgetypt.
     */
    const geleverd: Record<StapSleutel, string[]> = {
      gebouw: Object.keys(stap(checklist(), "gebouw").waarden),
      blokken: Object.keys(stap(checklist(), "blokken").waarden),
      lots: Object.keys(stap(checklist(), "lots").waarden),
      eigenaren: Object.keys(stap(checklist(), "eigenaren").waarden),
      koppelen: Object.keys(stap(checklist(), "koppelen").waarden),
    };
    const STANDEN = ["klaar", "bezig", "tedoen", "optioneel", "wacht"];

    for (const [naam, berichten] of TALEN) {
      const steps = ns(berichten).steps as Record<string, Record<string, string>>;
      for (const [sleutel, waarden] of Object.entries(geleverd) as Array<
        [StapSleutel, string[]]
      >) {
        for (const stnd of STANDEN) {
          const zin = steps[sleutel][stnd];
          const gevraagd = [...zin.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
          for (const token of gevraagd) {
            expect(
              waarden,
              `${naam}: steps.${sleutel}.${stnd} vraagt {${token}}, maar die stap levert alleen ${waarden.join(", ") || "niets"}`,
            ).toContain(token);
          }
        }
      }
    }
  });

  it("I5 — het Arabisch is daadwerkelijk Arabisch schrift", () => {
    const arabisch = /[؀-ۿ]/;
    const arW = ns(ar as Record<string, unknown>);
    const loop = (o: Record<string, unknown>, pad = "") => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object") loop(v as Record<string, unknown>, `${pad}${k}.`);
        else if (typeof v === "string" && /\p{L}/u.test(v)) {
          expect(arabisch.test(v), `wizard.${pad}${k}: ${v}`).toBe(true);
        }
      }
    };
    loop(arW);
  });

  it("I6 — het navigatielabel bestaat in alle drie de talen", () => {
    for (const [naam, berichten] of TALEN) {
      const nav = berichten.nav as Record<string, unknown>;
      expect(typeof nav.setup, `${naam} nav.setup`).toBe("string");
    }
  });
});

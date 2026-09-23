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
/**
 * `count` is optioneel in de fixture. Blijft hij weg, dan doet de nepserver wat
 * een echte doet bij een volledige tabel: hij meldt precies zoveel rijen als hij
 * levert. Zet een test hem HOGER dan de rijen die hij teruggeeft, dan bootst dat
 * een afkapping na — de server zegt "er zijn er zeven", levert er twee, en heeft
 * er daarna geen meer.
 */
type Resultaat = { data: unknown; error: unknown; count?: number };

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
  // De nepserver snijdt op dezelfde inclusieve grenzen als PostgREST en meldt
  // altijd zijn `count`. Zonder het snijden zou elke pagina dezelfde rijen
  // teruggeven en zou de lus nooit iets kunnen bewijzen.
  let van = 0;
  let tot = Number.MAX_SAFE_INTEGER;
  const c: Record<string, unknown> = {};
  const zelf = () => c;
  const lever = (): Resultaat => {
    if (resultaat.error || !Array.isArray(resultaat.data)) return resultaat;
    const alles = resultaat.data as unknown[];
    const count = typeof resultaat.count === "number" ? resultaat.count : alles.length;
    return { data: alles.slice(van, tot + 1), error: null, count };
  };
  Object.assign(c, {
    select: zelf,
    eq: zelf,
    in: zelf,
    order: zelf,
    range: (a: number, b: number) => {
      van = a;
      tot = b;
      return c;
    },
    maybeSingle: async () => resultaat,
    then: (res: (v: Resultaat) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(lever()).then(res, rej),
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

  it("P22 — er worden geen eigenaarsNAMEN opgehaald, alleen een aantal", () => {
    /**
     * Stap 4 toont een getal. `full_name` meelezen zou van elke eigenaar in de
     * organisatie een persoonsgegeven naar de server halen waar niets mee
     * gebeurt — en die payload groeit mee met het klantenbestand.
     *
     * Structureel getoetst: een kolom die niet wordt opgevraagd, kan ook niet
     * per ongeluk ergens terechtkomen.
     */
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "wizard", "page.tsx"),
      "utf8",
    );
    const ownersQuery = bron.slice(bron.indexOf('.from("owners")'));
    // Niet op `")` eindigen: de select draagt sinds de paginering een tweede
    // argument (`{ count: "exact" }`). De kolomlijst blijft het eerste.
    const select = /\.select\("([^"]*)"/.exec(ownersQuery)?.[1];
    expect(select, "de owners-query hoort een select te hebben").toBeTruthy();
    expect(select).toBe("id");
    for (const kolom of ["full_name", "email", "phone"]) {
      expect(select, `${kolom} wordt niet gebruikt en hoort niet opgehaald`).not.toContain(kolom);
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

/**
 * C — de checklist belooft niets wat het scherm erachter niet kan.
 *
 * Stap 1 verwees naar de gebouwpagina met de tekst "gegevens bewerken" en de
 * belofte dat naam, adres en het verklaarde tantièmetotaal nog aan te passen
 * waren. Dat is niet zo: de enige `buildings`-update in de hele applicatie zet
 * `bank_name` en `bank_rib`. Wie de checklist volgde om een tantièmetotaal te
 * corrigeren, liep vast.
 *
 * C1/C2 sluiten de oude bewering uit, C3 pint de nieuwe betekenis vast en C4
 * houdt die eerlijk: verandert de bewerkbaarheid ooit, dan valt C4 en is dat
 * het moment om de tekst mee te veranderen — niet andersom.
 */
describe("C — de belofte van stap 1 klopt met de werkelijkheid", () => {
  const TALEN: Array<[string, Record<string, unknown>]> = [
    ["fr", fr as Record<string, unknown>],
    ["nl", nl as Record<string, unknown>],
    ["ar", ar as Record<string, unknown>],
  ];

  const stapGebouw = (berichten: Record<string, unknown>) =>
    ((berichten.wizard as Record<string, unknown>).steps as Record<
      string,
      Record<string, string>
    >).gebouw;

  /** Letterlijk de zinnen zoals ze vóór deze reparatie in de bundel stonden. */
  const OUD: Record<string, string[]> = {
    fr: [
      "Vous pouvez encore corriger le nom, l'adresse ou les tantièmes déclarés.",
      "Modifier les données",
    ],
    nl: [
      "Naam, adres en het verklaarde tantièmetotaal kunt u nog aanpassen.",
      "Gegevens bewerken",
    ],
    ar: ["ولا يزال بإمكانك تعديل الاسم والعنوان ومجموع الأنصبة المعلَن.", "تعديل البيانات"],
  };

  it("C1 — de oude, misleidende bewering staat in geen enkele taal meer", () => {
    for (const [naam, berichten] of TALEN) {
      const alles = JSON.stringify(stapGebouw(berichten));
      for (const zin of OUD[naam]) {
        expect(alles, `${naam}: oude tekst nog aanwezig — "${zin}"`).not.toContain(zin);
      }
    }
  });

  it("C2 — geen enkele stand belooft bewerken van naam, adres of tantièmes", () => {
    // Per taal het werkwoord dat bewerken belooft, samen met het object dat
    // niet bewerkbaar is. Beide in één zin is de fout; los van elkaar niet.
    const VERBODEN: Record<string, { werkwoord: RegExp; object: RegExp }> = {
      fr: { werkwoord: /modifier|corriger|éditer/i, object: /nom|adresse|tantièmes/i },
      nl: { werkwoord: /bewerk|aanpass|wijzig/i, object: /naam|adres|tantième/i },
      ar: { werkwoord: /تعديل|تغيير/, object: /الاسم|العنوان|الأنصبة/ },
    };
    for (const [naam, berichten] of TALEN) {
      const { werkwoord, object } = VERBODEN[naam];
      for (const [sleutel, waarde] of Object.entries(stapGebouw(berichten))) {
        if (typeof waarde !== "string") continue;
        const belooft = werkwoord.test(waarde) && object.test(waarde);
        expect(
          belooft,
          `${naam}: steps.gebouw.${sleutel} belooft bewerken van niet-bewerkbare velden — "${waarde}"`,
        ).toBe(false);
      }
    }
  });

  it("C3 — de actie benoemt het enige dat op die pagina wél te wijzigen is", () => {
    const BANK: Record<string, RegExp> = {
      fr: /bancaires/i,
      nl: /bankgegevens/i,
      ar: /البنكية/,
    };
    for (const [naam, berichten] of TALEN) {
      const stap = stapGebouw(berichten);
      expect(stap.action, `${naam}: action benoemt de bankgegevens niet`).toMatch(BANK[naam]);
      expect(stap.klaar, `${naam}: klaar benoemt de bankgegevens niet`).toMatch(BANK[naam]);
      // De leeslink blijft beschrijven wat er te zien is, zonder bewerkbelofte.
      expect(typeof stap.view).toBe("string");
      expect(stap.view.trim().length).toBeGreaterThan(0);
    }
  });

  it("C4 — de gebouwpagina kan werkelijk alleen de bankgegevens wijzigen", () => {
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "actions.ts"),
      "utf8",
    );
    // Elke update op `buildings` in de gebouwacties, met de velden die hij zet.
    const updates = [
      ...bron.matchAll(/\.from\(\s*"buildings"\s*\)\s*\.update\(\s*\{([^}]*)\}/g),
    ].map((m) => m[1].trim());
    expect(updates.length, "geen enkele buildings-update gevonden").toBe(1);
    expect(updates[0]).toBe("bank_name, bank_rib");
    // Zo lang dit klopt, is C3 een eerlijke belofte. Verandert het, dan hoort
    // de tekst van stap 1 in dezelfde wijziging mee te bewegen.
    expect(bron).not.toMatch(/\.from\(\s*"buildings"\s*\)[\s\S]{0,120}total_tantiemes/);
  });
});

/**
 * R — de rolpoort van de checklist.
 *
 * De grens zelf ligt in de database (`can_write`, SECURITY DEFINER, binnen elke
 * RPC). `canWrite()` uit `@/lib/roles` spiegelt die lijst en bestaat alleen om
 * geen belofte te doen waarvan we weten dat de server hem weigert. Deze tests
 * toetsen dus de BELOFTE, niet de beveiliging: een lezer mag nergens worden
 * uitgenodigd iets in te vullen.
 *
 * Let op R5: de standzin van een stap is rolONafhankelijk — iedereen ziet
 * dezelfde zin. Staat er "vult u in", dan doet die zin een schrijfbelofte aan
 * een lezer, hoe keurig de linktekst eronder ook is.
 */
describe("R — een lezer wordt nergens tot schrijven uitgenodigd", () => {
  const SCHRIJFROLLEN = ["owner", "admin", "manager", "accountant"];

  it.each(SCHRIJFROLLEN)("R1 — %s ziet de schrijfactie van stap 1", async (rol) => {
    state.rol = rol;
    await toon();
    expect(tekst()).toContain("steps.gebouw.action");
    expect(tekst()).not.toContain("steps.gebouw.view");
  });

  it("R2 — een lezer ziet de schrijfactie van stap 1 NIET", async () => {
    state.rol = "reader";
    await toon();
    expect(tekst()).not.toContain("steps.gebouw.action");
  });

  it("R3 — een lezer krijgt de neutrale bekijkactie op stap 1", async () => {
    state.rol = "reader";
    await toon();
    expect(tekst()).toContain("steps.gebouw.view");
  });

  it("R4 — de bestemming van stap 1 is voor beide rollen de gebouwpagina", async () => {
    state.rol = "reader";
    await toon();
    expect(screen.getByTestId("wizard-link-gebouw").getAttribute("href")).toBe(
      `/buildings/${BLD}`,
    );

    cleanup();
    state.rol = "manager";
    await toon();
    expect(screen.getByTestId("wizard-link-gebouw").getAttribute("href")).toBe(
      `/buildings/${BLD}`,
    );
  });

  it("R5 — geen enkele standzin doet een schrijfbelofte aan wie niet mag schrijven", () => {
    // De zin wordt aan ELKE rol getoond, dus hij mag de lezer niet aanspreken
    // met een handeling die hij niet mag uitvoeren.
    const BELOFTE: Record<string, RegExp> = {
      fr: /\bvous (pouvez|saisissez|créez|ajoutez|modifiez|corrigez)\b/i,
      nl: /\b(vult u|maakt u|voegt u|wijzigt u|past u|u vult|u maakt|u voegt|u wijzigt|u past)\b/i,
      // GEEN \b hier: Arabische letters zijn voor JS geen \w, dus een
      // woordgrens matcht er nooit en de hele regex zou stilletjes niets doen.
      ar: /تُدخِل|تُدخل|تُنشئ|تُضيف|تُعدّل|تُعدل/,
    };
    const STANDEN = ["klaar", "bezig", "tedoen", "optioneel", "wacht"];
    for (const [naam, berichten] of [
      ["fr", fr],
      ["nl", nl],
      ["ar", ar],
    ] as Array<[string, Record<string, unknown>]>) {
      const steps = (berichten.wizard as Record<string, unknown>).steps as Record<
        string,
        Record<string, string>
      >;
      for (const [stap, velden] of Object.entries(steps)) {
        for (const stand of STANDEN) {
          const zin = velden[stand];
          expect(
            BELOFTE[naam].test(zin),
            `${naam}: steps.${stap}.${stand} belooft een lezer een handeling — "${zin}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("R6 — elke stap heeft in elke taal een eigen schrijf- én bekijktekst", () => {
    for (const [naam, berichten] of [
      ["fr", fr],
      ["nl", nl],
      ["ar", ar],
    ] as Array<[string, Record<string, unknown>]>) {
      const steps = (berichten.wizard as Record<string, unknown>).steps as Record<
        string,
        Record<string, string>
      >;
      for (const [stap, velden] of Object.entries(steps)) {
        expect(velden.action?.trim(), `${naam}: steps.${stap}.action`).toBeTruthy();
        expect(velden.view?.trim(), `${naam}: steps.${stap}.view`).toBeTruthy();
        // Zijn ze gelijk, dan verandert de rol niets en is de poort schijn.
        expect(velden.action, `${naam}: steps.${stap} action == view`).not.toBe(velden.view);
      }
    }
  });

  it("R8 — de bekijkteksten beloven zelf geen enkele handeling", () => {
    // De tegenhanger van R6: die ziet alleen dat action en view verschillen. Deze
    // pint vast WAT view mag zeggen — anders volstaat een tweede schrijfzin.
    const SCHRIJFWERKWOORD: Record<string, RegExp> = {
      fr: /saisir|créer|ajouter|modifier|corriger|attribuer|lier/i,
      nl: /invullen|aanmaken|toevoegen|wijzigen|bewerken|koppelen|aanpassen/i,
      ar: /إدخال|إنشاء|إضافة|تعديل|ربط/,
    };
    for (const [naam, berichten] of [
      ["fr", fr],
      ["nl", nl],
      ["ar", ar],
    ] as Array<[string, Record<string, unknown>]>) {
      const steps = (berichten.wizard as Record<string, unknown>).steps as Record<
        string,
        Record<string, string>
      >;
      for (const [stap, velden] of Object.entries(steps)) {
        expect(
          SCHRIJFWERKWOORD[naam].test(velden.view),
          `${naam}: steps.${stap}.view belooft een handeling — "${velden.view}"`,
        ).toBe(false);
        // En de schrijfactie moet er juist wél een benoemen, anders is het
        // onderscheid leeg.
        expect(
          SCHRIJFWERKWOORD[naam].test(velden.action),
          `${naam}: steps.${stap}.action benoemt geen handeling — "${velden.action}"`,
        ).toBe(true);
      }
    }
  });

  it("R7 — geen technische rolnaam komt op het scherm", async () => {
    for (const rol of [...SCHRIJFROLLEN, "reader"]) {
      cleanup();
      state.rol = rol;
      await toon();
      const zichtbaar = tekst();
      for (const naam of ["owner", "admin", "manager", "accountant", "reader", "can_write"]) {
        expect(zichtbaar, `rolnaam "${naam}" zichtbaar bij rol ${rol}`).not.toContain(naam);
      }
    }
  });
});

/**
 * T — een afgekapte bron mag nooit als complete checklist doorgaan.
 *
 * PostgREST kapt af op zijn `max-rows` zonder dat te melden: het verzoek slaagt
 * en je krijgt een prefix. Voor een lijstscherm is dat hinderlijk, hier is het
 * gevaarlijk — twintig opgehaalde lots die toevallig allemaal gekoppeld zijn,
 * zouden "5/5, alles klaar" opleveren terwijl er tachtig zonder eigenaar staan.
 *
 * De fixture bootst dat na met een `count` die hoger ligt dan het aantal rijen
 * dat de nepserver werkelijk levert: de server zegt "er zijn er zeven", levert
 * er twee, en heeft er daarna geen meer.
 */
describe("T — afkapping is fail-closed", () => {
  const compleet = () => ({
    buildings: { data: { id: BLD, name: "Résidence Atlas" }, error: null },
    blocks: { data: [blok({ id: "a" })], error: null },
    units: { data: [unit({ id: "u1" }), unit({ id: "u2" })], error: null },
    ownership: {
      data: [own({ id: "ow1", unit_id: "u1" }), own({ id: "ow2", unit_id: "u2" })],
      error: null,
    },
    owners: { data: [{ id: "o1" }], error: null },
  });

  it("T1 — een VOLLEDIGE dataset haalt gewoon 5 van 5", async () => {
    state.tabellen = compleet();
    await toon();
    expect(screen.queryByTestId("wizard-unavailable")).toBeNull();
    expect(tekst()).toContain("progress.count(5,5)");
    expect(screen.getByTestId("wizard-compleet")).toBeTruthy();
  });

  // Elke bron apart: telling hoger dan de geleverde rijen = afkapping.
  for (const bron of ["units", "ownership", "owners", "blocks"]) {
    it(`T2.${bron} — een afgekapte ${bron}-bron haalt NOOIT 5 van 5`, async () => {
      state.tabellen = compleet();
      const huidig = state.tabellen[bron] as { data: unknown[]; error: unknown };
      state.tabellen[bron] = { ...huidig, count: huidig.data.length + 5 };

      await toon();

      expect(screen.getByTestId("wizard-unavailable")).toBeTruthy();
      expect(tekst()).not.toContain("progress.count(5,5)");
      expect(screen.queryByTestId("wizard-compleet")).toBeNull();
      // En geen enkele stap wordt als stand getoond.
      expect(screen.queryByTestId("wizard-stap-lots")).toBeNull();
    });
  }

  /**
   * T3 is het afhankelijkheidspunt. De eigendomsquery vraagt de rijen op van de
   * unit-ids die `units` opleverde. Levert `ownership` dan keurig ALLE rijen van
   * die halve lotlijst, dan is die bron op zichzelf "compleet" — en toch is het
   * antwoord onbruikbaar, want de ontbrekende lots zijn juist de niet-gekoppelde.
   */
  it("T3 — een volledige ownership over een AFGEKAPTE lotlijst telt niet als compleet", async () => {
    state.tabellen = compleet();
    const u = state.tabellen.units as { data: unknown[]; error: unknown };
    state.tabellen.units = { ...u, count: u.data.length + 3 };
    // ownership zelf is intern consistent: count == rijen.
    const o = state.tabellen.ownership as { data: unknown[]; error: unknown };
    state.tabellen.ownership = { ...o, count: o.data.length };

    await toon();
    expect(screen.getByTestId("wizard-unavailable")).toBeTruthy();
    expect(tekst()).not.toContain("progress.count(5,5)");
  });

  it("T4 — een queryfout blijft fail-closed, net als voorheen", async () => {
    state.tabellen = compleet();
    state.tabellen.units = { data: null, error: dbFout("42P01") };
    await toon();
    expect(screen.getByTestId("wizard-unavailable")).toBeTruthy();
    expect(tekst()).not.toContain("progress.count");
  });

  it("T5 — bij afkapping lekt geen tabelnaam, SQLSTATE of databasetekst naar het scherm", async () => {
    state.tabellen = compleet();
    const u = state.tabellen.units as { data: unknown[]; error: unknown };
    state.tabellen.units = { ...u, count: 99 };

    await toon();
    const zichtbaar = tekst();
    for (const verboden of [
      "units",
      "ownership",
      "owners",
      "blocks",
      "PGRST",
      "42P01",
      "max-rows",
      "count",
      "range",
      "truncat",
    ]) {
      expect(zichtbaar, `"${verboden}" staat op het scherm`).not.toContain(verboden);
    }
    // Wat de gebruiker wél krijgt is de vertaalde, neutrale melding.
    expect(zichtbaar).toContain("loadError.title");
    expect(zichtbaar).toContain("loadError.body");
  });

  it("T6 — het SERVERLOG benoemt de bron wel, en blijft gesaneerd", async () => {
    state.tabellen = compleet();
    const u = state.tabellen.units as { data: unknown[]; error: unknown };
    state.tabellen.units = { ...u, count: 99 };

    await toon();
    const log = logs.join(" ");
    expect(log).toContain("scope=sources");
    expect(log).toContain("units:incomplete");
    // Geen Postgres-tekst, geen gebouwnaam, geen id's — zelfde conventie als altijd.
    expect(log).not.toContain("does not exist");
    expect(log).not.toContain("Résidence Atlas");
    expect(log).not.toContain(BLD);
  });

  /**
   * T9 — de telling bewijst alleen volledigheid bij een STABIELE ordening.
   *
   * Zonder ORDER BY laat SQL de rijvolgorde ongespecificeerd, en twee losse
   * `.range()`-verzoeken zijn twee losse queries: de tweede mag rijen herhalen
   * die de eerste al gaf en andere overslaan. Het aantal klopt dan nog met
   * `count` — evenveel rijen, niet dezelfde — en een overgeslagen niet-gekoppeld
   * lot, vervangen door een dubbel gekoppeld lot, levert alsnog 5/5 op.
   *
   * Dat valt niet met een nepserver te bewijzen (die kiest zelf zijn volgorde),
   * dus wordt hier de VOORWAARDE getoetst: elke gepagineerde bron ordent op een
   * unieke sleutel voordat hij een bereik neemt.
   */
  it("T9 — elke gepagineerde bron ordent op een unieke sleutel vóór .range()", () => {
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "wizard", "page.tsx"),
      "utf8",
    );
    const lezingen = [...bron.matchAll(/leesVolledig<[^>]*>\(\s*\(van, tot\) =>([\s\S]*?)\),\n/g)];
    expect(lezingen.length, "geen enkele gepagineerde bron gevonden").toBe(4);
    for (const [, blok] of lezingen) {
      const ordening = /\.order\("([^"]+)"/.exec(blok)?.[1];
      expect(ordening, `bron zonder .order(): ${blok.slice(0, 80)}`).toBeTruthy();
      // Alleen een unieke kolom maakt de ordening totaal; `label` of `sort_order`
      // kan dubbelen en laat dezelfde herhaal-en-sla-over-fout bestaan.
      expect(ordening, "ordening is niet op een unieke sleutel").toBe("id");
      // En de ordening moet VOOR het bereik staan.
      expect(blok.indexOf('.order("id"')).toBeLessThan(blok.indexOf(".range("));
    }
  });

  it("T7 — de foutmelding bestaat in fr, nl en ar", () => {
    for (const [naam, berichten] of [
      ["fr", fr],
      ["nl", nl],
      ["ar", ar],
    ] as Array<[string, Record<string, unknown>]>) {
      const fout = (berichten.wizard as Record<string, unknown>).loadError as Record<
        string,
        string
      >;
      expect(fout?.title?.trim(), `${naam}: wizard.loadError.title`).toBeTruthy();
      expect(fout?.body?.trim(), `${naam}: wizard.loadError.body`).toBeTruthy();
      for (const verboden of ["SQL", "PGRST", "max-rows", "PostgREST", "null"]) {
        expect(`${fout.title} ${fout.body}`, `${naam}: technische term`).not.toContain(verboden);
      }
    }
  });

  it("T8 — een gewone kleine dataset gedraagt zich onveranderd", async () => {
    // Geen expliciete count: de nepserver meldt er precies zoveel als hij levert,
    // net als een echte server bij een tabel die in één pagina past.
    state.tabellen = standaard();
    await toon();
    expect(screen.queryByTestId("wizard-unavailable")).toBeNull();
    expect(standVan("lots")).toBe("klaar");
    expect(standVan("koppelen")).toBe("bezig");
  });
});

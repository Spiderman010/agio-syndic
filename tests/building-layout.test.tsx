// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";
import {
  actueleEigendom,
  bouwIndeling,
  heeftTantieme,
  type BlockRow,
  type LayoutUnitRow,
} from "@/lib/layout";
import type { OwnershipRow } from "@/lib/ownership";

/**
 * De indeling van één gebouw.
 *
 * Twee lagen, bewust gescheiden:
 *
 *   L*  de rekenkern (`bouwIndeling`). Groepering, standen, tellingen en
 *       subtotalen zijn pure functies van hun invoer en worden hier
 *       rechtstreeks getoetst — zonder render, zonder mocks.
 *
 *   P*  de pagina. Daar gaat het uitsluitend om het DATAPAD: haalt hij vier
 *       bronnen op, onderdrukt één mislukking werkelijk alles, en lekt er niets
 *       naar scherm of log.
 *
 *   M*  het BEHEER, alleen als compositie: wie krijgt welk paneel, en met welke
 *       gegevens. Wat de acties dóen staat in `tests/block-lot-actions.test.ts`,
 *       waar de echte guards meelopen.
 *
 * WAT HIER NIET WORDT BEWEZEN: hoe dit eruitziet. jsdom doet geen layout en
 * evalueert geen media queries. Over de bezettingsbalk, de kolommen op 360px
 * of de RTL-spiegeling doet geen enkele assertie hier een uitspraak.
 */

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

const EIGENAARS = [
  { id: "o1", full_name: "Youssef El Amrani" },
  { id: "o2", full_name: "Fatima Zahra Bennani" },
];

function indeling(over: Partial<Parameters<typeof bouwIndeling>[0]> = {}) {
  return bouwIndeling({
    buildingId: BLD,
    blocks: [],
    units: [],
    ownership: [],
    owners: EIGENAARS,
    totalTantiemes: 0,
    ...over,
  });
}

const sleutels = (r: ReturnType<typeof bouwIndeling>) => r.groepen.map((g) => g.sleutel);
const labelsVan = (r: ReturnType<typeof bouwIndeling>, sleutel: string) =>
  r.groepen.find((g) => g.sleutel === sleutel)?.lots.map((l) => l.label) ?? [];

// ══════════════════════════════════════════════════════ rekenkern
describe("L — blokken en groepering", () => {
  it("L1 — blokken staan op sort_order, niet op code of ophaalvolgorde", () => {
    // De codes spreken de sort_order BEWUST tegen. Met oplopende codes zou
    // deze test ook slagen als er helemaal niet op sort_order werd gesorteerd
    // maar op code — dan bewijst hij niets.
    const r = indeling({
      blocks: [
        blok({ id: "derde", code: "A", sort_order: 30 }),
        blok({ id: "eerste", code: "Z", sort_order: 10 }),
        blok({ id: "tweede", code: "M", sort_order: 20 }),
      ],
    });
    expect(sleutels(r)).toEqual(["eerste", "tweede", "derde"]);
  });

  it("L2 — bij gelijke sort_order beslist de code, zodat de volgorde stabiel is", () => {
    const r = indeling({
      blocks: [
        blok({ id: "z", code: "Z", sort_order: 0 }),
        blok({ id: "a", code: "A", sort_order: 0 }),
      ],
    });
    expect(sleutels(r)).toEqual(["a", "z"]);
  });

  it("L3 — een gearchiveerd blok verschijnt niet", () => {
    const r = indeling({
      blocks: [blok({ id: "a" }), blok({ id: "b", archived_at: "2026-05-01T00:00:00Z" })],
    });
    expect(sleutels(r)).toEqual(["a"]);
    expect(r.samenvatting.blokken).toBe(1);
  });

  it("L4 — units staan onder hun eigen blok", () => {
    const r = indeling({
      blocks: [blok({ id: "a" }), blok({ id: "b", sort_order: 1 })],
      units: [
        unit({ id: "u1", block_id: "a", label: "A-01" }),
        unit({ id: "u2", block_id: "b", label: "B-01" }),
        unit({ id: "u3", block_id: "a", label: "A-02" }),
      ],
    });
    expect(labelsVan(r, "a")).toEqual(["A-01", "A-02"]);
    expect(labelsVan(r, "b")).toEqual(["B-01"]);
  });

  it("L5 — block_id NULL krijgt een eigen groep en verdwijnt niet", () => {
    const r = indeling({
      blocks: [blok({ id: "a" })],
      units: [unit({ id: "u1", block_id: "a" }), unit({ id: "u2", block_id: null })],
    });
    expect(sleutels(r)).toEqual(["a", "zonder-blok"]);
    expect(r.samenvatting.lots).toBe(2);
  });

  it("L6 — een lot dat naar een GEARCHIVEERD blok wijst wordt niet verborgen", () => {
    // Archiveren zet alleen `archived_at`; `units.block_id` blijft staan.
    // Groeperen op uitsluitend zichtbare blokken zou dit lot laten verdampen.
    const r = indeling({
      blocks: [blok({ id: "a" }), blok({ id: "oud", archived_at: "2026-01-01T00:00:00Z" })],
      units: [
        unit({ id: "u1", block_id: "a", label: "A-01" }),
        unit({ id: "u2", block_id: "oud", label: "OUD-01" }),
      ],
    });
    expect(sleutels(r)).toEqual(["a", "onbereikbaar"]);
    expect(labelsVan(r, "onbereikbaar")).toEqual(["OUD-01"]);
    expect(r.samenvatting.lots).toBe(2);
  });

  it("L7 — een lot met een ONBEKEND block_id verdwijnt evenmin", () => {
    const r = indeling({
      blocks: [blok({ id: "a" })],
      units: [unit({ id: "u1", block_id: "spookblok", label: "X-01" })],
    });
    expect(labelsVan(r, "onbereikbaar")).toEqual(["X-01"]);
    expect(r.samenvatting.lots).toBe(1);
  });

  it("L8 — de uitzonderingsgroepen verschijnen alleen als ze lots bevatten", () => {
    const r = indeling({ blocks: [blok({ id: "a" })], units: [unit({ id: "u1", block_id: "a" })] });
    expect(sleutels(r)).toEqual(["a"]);
  });

  it("L9 — een leeg blok blijft zichtbaar; het bestaat immers", () => {
    const r = indeling({ blocks: [blok({ id: "a" })] });
    expect(sleutels(r)).toEqual(["a"]);
    expect(r.groepen[0].lots).toEqual([]);
  });
});

describe("L — standen per lot", () => {
  it("L10 — zonder actuele eigendom is een lot VRIJ, niet fout", () => {
    const r = indeling({ units: [unit({ id: "u1" })] });
    expect(r.groepen[0].lots[0].staat).toBe("vrij");
    expect(r.groepen[0].lots[0].eigenaarId).toBeNull();
  });

  it("L11 — met een actuele hoofdelijke eigenaar staat de juiste naam erbij", () => {
    const r = indeling({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1", owner_id: "o2" })],
    });
    expect(r.groepen[0].lots[0].staat).toBe("gekoppeld");
    expect(r.groepen[0].lots[0].eigenaarNaam).toBe("Fatima Zahra Bennani");
  });

  it("L12 — een BEËINDIGDE eigendom telt niet als eigenaar", () => {
    const r = indeling({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1", end_date: "2026-03-01" })],
    });
    expect(r.groepen[0].lots[0].staat).toBe("vrij");
  });

  it("L13 — een niet-hoofdelijke eigendom wijst hier geen debiteur aan", () => {
    const r = indeling({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1", is_primary_debtor: false })],
    });
    expect(r.groepen[0].lots[0].staat).toBe("vrij");
  });

  it("L14 — een eigenaar die niet te herleiden is, is NOOIT 'vrij'", () => {
    // Anders nodigt het scherm uit een eigenaar te koppelen die er al is.
    const r = indeling({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1", owner_id: "verdwenen" })],
      owners: [],
    });
    const lot = r.groepen[0].lots[0];
    expect(lot.staat).toBe("gekoppeld");
    expect(lot.eigenaarId).toBe("verdwenen");
    expect(lot.eigenaarNaam).toBeNull();
  });

  it("L15 — ontbrekend of nul tantième maakt een lot ONVOLLEDIG", () => {
    const r = indeling({
      units: [
        unit({ id: "u1", tantiemes: 0, label: "A" }),
        unit({ id: "u2", tantiemes: null, label: "B" }),
      ],
    });
    expect(r.groepen[0].lots.map((l) => l.staat)).toEqual(["onvolledig", "onvolledig"]);
    expect(heeftTantieme(0)).toBe(false);
    expect(heeftTantieme(null)).toBe(false);
    expect(heeftTantieme(1)).toBe(true);
  });

  it("L16 — onvolledig weegt zwaarder dan vrij, en de standen sluiten elkaar uit", () => {
    const r = indeling({
      units: [
        unit({ id: "u1", tantiemes: 0, label: "A" }),
        unit({ id: "u2", label: "B" }),
        unit({ id: "u3", label: "C" }),
      ],
      ownership: [own({ id: "ow1", unit_id: "u3" })],
    });
    const g = r.groepen[0];
    expect(g.telling).toEqual({ onvolledig: 1, vrij: 1, gekoppeld: 1 });
    expect(g.telling.onvolledig + g.telling.vrij + g.telling.gekoppeld).toBe(g.lots.length);
  });

  it("L17 — bij meerdere hoofdelijke rijen is de uitkomst deterministisch", () => {
    const rijen = [
      own({ id: "ow-b", unit_id: "u1", owner_id: "o2" }),
      own({ id: "ow-a", unit_id: "u1", owner_id: "o1" }),
    ];
    expect(actueleEigendom(rijen)?.id).toBe("ow-a");
    expect(actueleEigendom([...rijen].reverse())?.id).toBe("ow-a");
  });
});

describe("L — subtotalen en samenvatting", () => {
  it("L18 — het subtotaal telt alleen bruikbare tantièmes en markeert de rest", () => {
    const r = indeling({
      blocks: [blok({ id: "a" })],
      units: [
        unit({ id: "u1", block_id: "a", tantiemes: 300 }),
        unit({ id: "u2", block_id: "a", tantiemes: 0 }),
      ],
    });
    expect(r.groepen[0].tantiemeSubtotaal).toBe(300);
    expect(r.groepen[0].subtotaalOnvolledig).toBe(true);
  });

  it("L19 — een volledig blok is niet gemarkeerd", () => {
    const r = indeling({
      blocks: [blok({ id: "a" })],
      units: [unit({ id: "u1", block_id: "a", tantiemes: 500 })],
    });
    expect(r.groepen[0].subtotaalOnvolledig).toBe(false);
  });

  it("L20 — het gebouwtotaal wordt tegen total_tantiemes gelegd", () => {
    const sluit = indeling({
      units: [unit({ id: "u1", tantiemes: 600 }), unit({ id: "u2", tantiemes: 400 })],
      totalTantiemes: 1000,
    });
    expect(sluit.samenvatting.tantiemesToegekend).toBe(1000);
    expect(sluit.samenvatting.tantiemesSluiten).toBe(true);

    const wijktAf = indeling({
      units: [unit({ id: "u1", tantiemes: 600 })],
      totalTantiemes: 1000,
    });
    expect(wijktAf.samenvatting.tantiemesToegekend).toBe(600);
    expect(wijktAf.samenvatting.tantiemesVerklaard).toBe(1000);
    expect(wijktAf.samenvatting.tantiemesSluiten).toBe(false);
  });

  it("L21 — eigenaren worden ontdubbeld", () => {
    const r = indeling({
      units: [unit({ id: "u1" }), unit({ id: "u2" }), unit({ id: "u3" })],
      ownership: [
        own({ id: "ow1", unit_id: "u1", owner_id: "o1" }),
        own({ id: "ow2", unit_id: "u2", owner_id: "o1" }),
        own({ id: "ow3", unit_id: "u3", owner_id: "o2" }),
      ],
    });
    expect(r.samenvatting.eigenaren).toBe(2);
  });

  it("L22 — GEBOUWSCOPE: lots en blokken van een ander gebouw komen er niet in", () => {
    const r = indeling({
      blocks: [blok({ id: "a" }), blok({ id: "vreemd", building_id: ANDER })],
      units: [
        unit({ id: "u1", block_id: "a", label: "EIGEN" }),
        unit({ id: "vreemd-1", building_id: ANDER, label: "VREEMD" }),
      ],
    });
    expect(sleutels(r)).toEqual(["a"]);
    expect(r.samenvatting.lots).toBe(1);
    expect(r.groepen.flatMap((g) => g.lots).map((l) => l.label)).toEqual(["EIGEN"]);
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
    buildings: { data: { id: BLD, name: "Résidence Atlas", total_tantiemes: 1000 }, error: null },
    blocks: { data: [blok({ id: "a", code: "A" })], error: null },
    units: { data: [unit({ id: "u1", block_id: "a", label: "A-01", tantiemes: 1000 })], error: null },
    ownership: { data: [own({ id: "ow1", unit_id: "u1", owner_id: "o1" })], error: null },
    owners: { data: EIGENAARS, error: null },
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

vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => {
    const fn = (key: string, waarden?: Record<string, unknown>) => {
      const basis = ns ? `${ns}.${key}` : key;
      return waarden ? `${basis}(${Object.values(waarden).join(",")})` : basis;
    };
    return Object.assign(fn, { rich: fn, markup: fn, raw: fn, has: () => true });
  },
  useLocale: () => "fr",
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Async server components kunnen niet rechtstreeks door `render()` heen; en
// ze hebben hun eigen dekking. Hier gaat het om de COMPOSITIE: wie krijgt
// welk paneel te zien, en met welke gegevens.
vi.mock("../src/app/[locale]/(app)/buildings/[id]/indeling/BlokBeheer", () => ({
  BlokAanmaken: () => <div data-testid="stub-blok-aanmaken" />,
  BlokBewerken: ({ blok }: { blok: { id: string } }) => (
    <div data-testid="stub-blok-bewerken" data-blok={blok.id} />
  ),
}));
vi.mock("../src/app/[locale]/(app)/buildings/[id]/indeling/LotBewerken", () => ({
  default: ({ lot, blokken }: { lot: { id: string }; blokken: { id: string }[] }) => (
    <div
      data-testid="stub-lot-bewerken"
      data-lot={lot.id}
      data-blokken={blokken.map((b) => b.id).join(",")}
    />
  ),
}));
vi.mock("../src/app/[locale]/(app)/buildings/[id]/indeling/BulkLots", () => ({
  default: ({ blokken, reedsToegekend }: { blokken: { id: string }[]; reedsToegekend: number }) => (
    <div
      data-testid="stub-bulk"
      data-blokken={blokken.map((b) => b.id).join(",")}
      data-toegekend={reedsToegekend}
    />
  ),
}));

vi.mock("../src/app/[locale]/(app)/buildings/[id]/indeling/actions", () => ({
  createBlock: async () => undefined,
  updateBlock: async () => undefined,
  setBlockArchived: async () => undefined,
  createLotsBulk: async () => undefined,
  updateLotLayout: async () => undefined,
}));

// De echte `Link` geeft onbekende props door aan het anker. Deze stub moet dat
// ook doen, anders verdwijnt `data-testid` en toetsen de M-tests niets.
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

import IndelingPage from "../src/app/[locale]/(app)/buildings/[id]/indeling/page";

async function toon(zoek: { blok?: string; edit?: string } = {}) {
  return render(
    await IndelingPage({
      params: Promise.resolve({ id: BLD }),
      searchParams: Promise.resolve(zoek),
    }),
  );
}

const tekst = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

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
    it(`P1.${bron} — een mislukte ${bron}-query onderdrukt de HELE indeling`, async () => {
      state.tabellen[bron] = { data: null, error: dbFout("42501") };
      await toon();

      expect(screen.getByTestId("indeling-unavailable")).toBeTruthy();
      expect(screen.queryByTestId("indeling-empty")).toBeNull();
      expect(document.querySelector("[data-testid^='indeling-blok-']")).toBeNull();
      expect(document.querySelector("[data-testid^='indeling-lot-']")).toBeNull();
    });
  }

  it("P2 — een mislukte gebouwquery toont de fouttoestand, geen lege indeling", async () => {
    state.tabellen.buildings = { data: null, error: dbFout("42P01") };
    await toon();
    expect(screen.getByTestId("indeling-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("indeling-empty")).toBeNull();
  });

  it("P3 — een mislukte eigendomsquery zet NOOIT alle lots op 'vrij'", async () => {
    state.tabellen.ownership = { data: null, error: dbFout("42501") };
    await toon();
    expect(screen.getByTestId("indeling-unavailable")).toBeTruthy();
    expect(tekst()).not.toContain("indeling.status.vrij");
  });

  it("P4 — geslaagd en leeg is iets anders dan mislukt", async () => {
    state.tabellen.blocks = { data: [], error: null };
    state.tabellen.units = { data: [], error: null };
    await toon();
    expect(screen.getByTestId("indeling-empty")).toBeTruthy();
    expect(screen.queryByTestId("indeling-unavailable")).toBeNull();
  });

  it("P5 — de fouttoestand is een alert, de lege toestand niet", async () => {
    state.tabellen.units = { data: null, error: dbFout("42501") };
    await toon();
    expect(screen.getByTestId("indeling-unavailable").getAttribute("role")).toBe("alert");

    cleanup();
    state.tabellen = standaard();
    state.tabellen.blocks = { data: [], error: null };
    state.tabellen.units = { data: [], error: null };
    await toon();
    expect(screen.getByTestId("indeling-empty").getAttribute("role")).not.toBe("alert");
  });

  it("P6 — een onbekend gebouw is geen storing", async () => {
    state.tabellen.buildings = { data: null, error: null };
    await toon();
    expect(screen.getByTestId("indeling-notfound")).toBeTruthy();
    expect(screen.queryByTestId("indeling-unavailable")).toBeNull();
  });
});

describe("P — wat er wél op het scherm komt", () => {
  it("P7 — blok, lot, eigenaar en stand verschijnen", async () => {
    await toon();
    expect(screen.getByTestId("indeling-blok-a")).toBeTruthy();
    const lot = screen.getByTestId("indeling-lot-u1");
    expect(lot.getAttribute("data-staat")).toBe("gekoppeld");
    expect(tekst()).toContain("Youssef El Amrani");
  });

  it("P8 — het tantièmeverschil wordt gemarkeerd", async () => {
    state.tabellen.units = {
      data: [unit({ id: "u1", block_id: "a", tantiemes: 600 })],
      error: null,
    };
    await toon();
    expect(tekst()).toContain("indeling.summary.tantiemesMismatch(600,1000)");

    cleanup();
    state.tabellen = standaard();
    await toon();
    expect(tekst()).not.toContain("indeling.summary.tantiemesMismatch");
  });

  it("P9 — GEBOUWSCOPE: een lot van een ander gebouw komt niet in beeld", async () => {
    state.tabellen.units = {
      data: [
        unit({ id: "u1", block_id: "a", label: "EIGEN", tantiemes: 1000 }),
        unit({ id: "vreemd", building_id: ANDER, label: "VREEMD" }),
      ],
      error: null,
    };
    await toon();
    expect(screen.getByTestId("indeling-lot-u1")).toBeTruthy();
    expect(screen.queryByTestId("indeling-lot-vreemd")).toBeNull();
    expect(tekst()).not.toContain("VREEMD");
  });

  it("P10 — een lot onder een gearchiveerd blok blijft zichtbaar en krijgt uitleg", async () => {
    state.tabellen.blocks = {
      data: [blok({ id: "oud", archived_at: "2026-01-01T00:00:00Z" })],
      error: null,
    };
    state.tabellen.units = {
      data: [unit({ id: "u1", block_id: "oud", label: "OUD-01", tantiemes: 1000 })],
      error: null,
    };
    await toon();
    expect(screen.getByTestId("indeling-lot-u1")).toBeTruthy();
    expect(tekst()).toContain("indeling.block.unavailableHint");
  });
});

describe("P — het log lekt niets", () => {
  it("P11 — bron en SQLSTATE worden onderscheiden", async () => {
    state.tabellen.buildings = { data: null, error: dbFout("42P01") };
    await toon();
    expect(logs.join(" ")).toContain("scope=building");
    expect(logs.join(" ")).toContain("buildings:42P01");

    cleanup();
    logs = [];
    state.tabellen = standaard();
    state.tabellen.blocks = { data: null, error: dbFout("42501") };
    await toon();
    expect(logs.join(" ")).toContain("scope=sources");
    expect(logs.join(" ")).toContain("blocks:42501");
  });

  it("P12 — geen databasetekst, geen namen, geen id's in het log", async () => {
    state.tabellen.units = { data: null, error: dbFout("42501") };
    await toon();
    const alles = logs.join(" ");
    for (const verboden of ["does not exist", "Résidence Atlas", "Perhaps you meant", BLD, "org-1"]) {
      expect(alles, `"${verboden}" lekt naar het log`).not.toContain(verboden);
    }
  });

  it("P13 — en al helemaal niets daarvan naar het scherm", async () => {
    state.tabellen.owners = { data: null, error: dbFout("08006") };
    await toon();
    for (const verboden of ["blocks", "units", "ownership", "owners", "42501", "08006", "does not exist"]) {
      expect(tekst(), `"${verboden}" lekt naar het scherm`).not.toContain(verboden);
    }
  });
});

// ══════════════════════════════════════════════════════ beheer
/**
 * M* — de COMPOSITIE van het beheer. Niet wat de acties doen (dat staat in
 * `tests/block-lot-actions.test.ts`, waar de echte guards meelopen), maar wie
 * welk paneel te zien krijgt en met welke gegevens dat paneel wordt gevuld.
 *
 * De panelen zelf zijn hier gestubt. Dat is bewust: het enige wat deze laag
 * kan beslissen is aanbieden-of-niet en welke props eruit gaan, en juist daar
 * zit de rolgrens en de gebouwscope.
 */
describe("M — wie mag beheren", () => {
  it("M1 — een lezer krijgt geen enkel beheeronderdeel, maar wél uitleg", async () => {
    state.rol = "reader";
    await toon();

    expect(screen.queryByTestId("stub-blok-aanmaken")).toBeNull();
    expect(screen.queryByTestId("stub-bulk")).toBeNull();
    expect(document.querySelector("[data-testid^='blok-bewerk-']")).toBeNull();
    expect(document.querySelector("[data-testid^='lot-bewerk-']")).toBeNull();

    // Stilzwijgend weglaten is de fout die we niet nog eens maken.
    expect(screen.getByTestId("indeling-readonly")).toBeTruthy();
    expect(screen.getByTestId("indeling-readonly").getAttribute("role")).toBe("status");
  });

  it("M2 — een schrijver krijgt het beheer en juist géén leesmelding", async () => {
    // Zonder deze test zou M1 ook slagen als het beheer voor niemand zou
    // renderen; dan bewijst M1 niets over de rolgrens.
    await toon();

    expect(screen.getByTestId("stub-blok-aanmaken")).toBeTruthy();
    expect(screen.getByTestId("stub-bulk")).toBeTruthy();
    expect(screen.getByTestId("blok-bewerk-a")).toBeTruthy();
    expect(screen.getByTestId("lot-bewerk-u1")).toBeTruthy();
    expect(screen.queryByTestId("indeling-readonly")).toBeNull();
  });

  it("M3 — elke schrijfrol ziet het beheer, elke leesrol niet", async () => {
    for (const rol of ["owner", "admin", "manager", "accountant"]) {
      cleanup();
      state.rol = rol;
      await toon();
      expect(screen.queryByTestId("stub-blok-aanmaken"), `${rol} hoort te mogen`).toBeTruthy();
    }
    cleanup();
    state.rol = "reader";
    await toon();
    expect(screen.queryByTestId("stub-blok-aanmaken")).toBeNull();
  });
});

describe("M — de panelen volgen de URL", () => {
  it("M4 — ?blok= opent het blokpaneel en niets anders", async () => {
    await toon({ blok: "a" });
    const paneel = screen.getByTestId("stub-blok-bewerken");
    expect(paneel.getAttribute("data-blok")).toBe("a");
    expect(screen.queryByTestId("stub-lot-bewerken")).toBeNull();
  });

  it("M5 — ?edit= opent het lotpaneel en niets anders", async () => {
    await toon({ edit: "u1" });
    const paneel = screen.getByTestId("stub-lot-bewerken");
    expect(paneel.getAttribute("data-lot")).toBe("u1");
    expect(screen.queryByTestId("stub-blok-bewerken")).toBeNull();
  });

  it("M6 — zonder parameter staat er helemaal geen paneel", async () => {
    await toon();
    expect(document.querySelector("#indeling-paneel")).toBeNull();
  });

  it("M7 — een blok van een ANDER gebouw opent geen paneel", async () => {
    // De keten-fake negeert `.eq()`, dus dit is precies de rij die een
    // ontbrekende serverfilter zou doorlaten. De pagina moet zelf weigeren.
    state.tabellen.blocks = {
      data: [blok({ id: "a", code: "A" }), blok({ id: "vreemd", building_id: ANDER })],
      error: null,
    };
    await toon({ blok: "vreemd" });
    expect(screen.queryByTestId("stub-blok-bewerken")).toBeNull();
    expect(document.querySelector("#indeling-paneel")).toBeNull();
  });

  it("M8 — een lot van een ANDER gebouw opent geen paneel", async () => {
    state.tabellen.units = {
      data: [
        unit({ id: "u1", block_id: "a", label: "A-01", tantiemes: 1000 }),
        unit({ id: "vreemd", building_id: ANDER, label: "VREEMD" }),
      ],
      error: null,
    };
    await toon({ edit: "vreemd" });
    expect(screen.queryByTestId("stub-lot-bewerken")).toBeNull();
    expect(document.querySelector("#indeling-paneel")).toBeNull();
  });

  it("M9 — een onbestaand id opent geen leeg paneel", async () => {
    await toon({ blok: "bestaat-niet", edit: "bestaat-ook-niet" });
    expect(document.querySelector("#indeling-paneel")).toBeNull();
  });

  it("M10 — een LEZER krijgt geen paneel, ook niet met een geldige parameter", async () => {
    state.rol = "reader";
    await toon({ blok: "a", edit: "u1" });
    expect(screen.queryByTestId("stub-blok-bewerken")).toBeNull();
    expect(screen.queryByTestId("stub-lot-bewerken")).toBeNull();
    expect(document.querySelector("#indeling-paneel")).toBeNull();
  });
});

describe("M — welke gegevens de panelen krijgen", () => {
  function drieBlokken() {
    state.tabellen.blocks = {
      data: [
        blok({ id: "b", code: "B", sort_order: 20 }),
        blok({ id: "a", code: "A", sort_order: 10 }),
        blok({ id: "oud", code: "OUD", archived_at: "2026-01-01T00:00:00Z" }),
        blok({ id: "vreemd", code: "V", building_id: ANDER }),
      ],
      error: null,
    };
  }

  it("M11 — de bulkkeuze bevat alleen de ACTIEVE blokken van dit gebouw", async () => {
    drieBlokken();
    await toon();
    expect(screen.getByTestId("stub-bulk").getAttribute("data-blokken")).toBe("a,b");
  });

  it("M12 — het lotpaneel krijgt dezelfde keuze, in dezelfde volgorde", async () => {
    drieBlokken();
    await toon({ edit: "u1" });
    expect(screen.getByTestId("stub-lot-bewerken").getAttribute("data-blokken")).toBe("a,b");
  });

  it("M13 — de bulkvorm krijgt het al toegekende tantième mee", async () => {
    state.tabellen.units = {
      data: [
        unit({ id: "u1", block_id: "a", label: "A-01", tantiemes: 400 }),
        unit({ id: "u2", block_id: "a", label: "A-02", tantiemes: 250 }),
      ],
      error: null,
    };
    await toon();
    expect(screen.getByTestId("stub-bulk").getAttribute("data-toegekend")).toBe("650");
  });
});

describe("M — alleen een echt blok is bewerkbaar", () => {
  it("M14 — de afgeleide groepen krijgen geen bewerklink", async () => {
    state.tabellen.blocks = { data: [blok({ id: "a", code: "A" })], error: null };
    state.tabellen.units = {
      data: [
        unit({ id: "u1", block_id: "a", label: "A-01", tantiemes: 500 }),
        unit({ id: "u2", block_id: null, label: "LOS", tantiemes: 500 }),
        unit({ id: "u3", block_id: "weg", label: "WEG", tantiemes: 0 }),
      ],
      error: null,
    };
    await toon();

    // Alle drie de groepen staan er; alleen de echte is bewerkbaar.
    expect(screen.getByTestId("indeling-blok-a")).toBeTruthy();
    expect(screen.getByTestId("indeling-blok-zonder-blok")).toBeTruthy();
    expect(screen.getByTestId("indeling-blok-onbereikbaar")).toBeTruthy();

    expect(screen.getByTestId("blok-bewerk-a")).toBeTruthy();
    expect(screen.queryByTestId("blok-bewerk-zonder-blok")).toBeNull();
    expect(screen.queryByTestId("blok-bewerk-onbereikbaar")).toBeNull();

    // Een lot is wél altijd bewerkbaar — óók een los of onbereikbaar lot;
    // dat is juist het lot dat een blok toegewezen moet krijgen.
    for (const id of ["u1", "u2", "u3"]) {
      expect(screen.getByTestId(`lot-bewerk-${id}`), `${id} hoort bewerkbaar`).toBeTruthy();
    }
  });

  it("M17 — een GEARCHIVEERD blok blijft bereikbaar, anders is archiveren eenrichtingsverkeer", async () => {
    // Een gearchiveerd blok staat niet in de indeling; zonder deze lijst zou
    // het paneel met de heractiveerknop alleen nog via een getypte URL te
    // bereiken zijn.
    state.tabellen.blocks = {
      data: [
        blok({ id: "a", code: "A" }),
        blok({ id: "oud", code: "OUD", archived_at: "2026-01-01T00:00:00Z" }),
        blok({ id: "vreemd", code: "V", building_id: ANDER, archived_at: "2026-01-01T00:00:00Z" }),
      ],
      error: null,
    };
    await toon();

    const link = screen.getByTestId("blok-gearchiveerd-oud");
    expect(link.getAttribute("href")).toBe(
      `/buildings/${BLD}/indeling?blok=oud#indeling-paneel`,
    );
    // Actief blok: hoort hier niet. Vreemd gebouw: al helemaal niet.
    expect(screen.queryByTestId("blok-gearchiveerd-a")).toBeNull();
    expect(screen.queryByTestId("blok-gearchiveerd-vreemd")).toBeNull();
  });

  it("M18 — zonder gearchiveerde blokken staat die lijst er niet, en een lezer ziet hem nooit", async () => {
    await toon();
    expect(screen.queryByTestId("indeling-gearchiveerd")).toBeNull();

    cleanup();
    state.rol = "reader";
    state.tabellen.blocks = {
      data: [blok({ id: "oud", code: "OUD", archived_at: "2026-01-01T00:00:00Z" })],
      error: null,
    };
    await toon();
    expect(screen.queryByTestId("indeling-gearchiveerd")).toBeNull();
  });

  it("M19 — het paneel van een gearchiveerd blok opent wél", async () => {
    state.tabellen.blocks = {
      data: [blok({ id: "oud", code: "OUD", archived_at: "2026-01-01T00:00:00Z" })],
      error: null,
    };
    await toon({ blok: "oud" });
    expect(screen.getByTestId("stub-blok-bewerken").getAttribute("data-blok")).toBe("oud");
  });

  it("M15 — de bewerklinks wijzen naar het paneel op deze route", async () => {
    await toon();
    expect(screen.getByTestId("blok-bewerk-a").getAttribute("href")).toBe(
      `/buildings/${BLD}/indeling?blok=a#indeling-paneel`,
    );
    expect(screen.getByTestId("lot-bewerk-u1").getAttribute("href")).toBe(
      `/buildings/${BLD}/indeling?edit=u1#indeling-paneel`,
    );
  });

  it("M16 — bij een storing verschijnt er geen beheer om iets in te typen", async () => {
    state.tabellen.units = { data: null, error: dbFout("42501") };
    await toon({ blok: "a", edit: "u1" });

    expect(screen.getByTestId("indeling-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("stub-blok-aanmaken")).toBeNull();
    expect(screen.queryByTestId("stub-bulk")).toBeNull();
    expect(document.querySelector("#indeling-paneel")).toBeNull();
  });
});

describe("I — vertalingen", () => {
  const TALEN: Array<[string, Record<string, unknown>]> = [
    ["fr", fr as Record<string, unknown>],
    ["nl", nl as Record<string, unknown>],
    ["ar", ar as Record<string, unknown>],
  ];

  const plat = (o: Record<string, unknown>, pad = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object"
        ? plat(v as Record<string, unknown>, `${pad}${k}.`)
        : [`${pad}${k}`],
    );

  it("I1 — de indeling-namespace heeft in alle drie de talen dezelfde sleutels", () => {
    const referentie = plat((fr as Record<string, unknown>).indeling as Record<string, unknown>).sort();
    expect(referentie.length).toBeGreaterThan(20);
    for (const [naam, taal] of TALEN) {
      expect(plat(taal.indeling as Record<string, unknown>).sort(), naam).toEqual(referentie);
    }
  });

  it("I2 — geen lege waarde, geen onvertaalde kopie", () => {
    /**
     * Waarom dit niet "alle drie verschillen" is.
     *
     * Een losse VAKTERM mag in twee talen samenvallen: "Lots" is in het
     * Nederlands net zo goed "Lots" — `nav.lots` doet dat al. Een hele ZIN kan
     * dat niet; identieke zinnen betekenen een vergeten vertaling.
     *
     * Dus: het Arabisch moet altijd afwijken (ander schrift, dus een kopie
     * valt meteen op), en Frans en Nederlands moeten afwijken zodra de waarde
     * uit meer dan één woord bestaat.
     */
    const referentie = plat((fr as Record<string, unknown>).indeling as Record<string, unknown>);
    for (const sleutel of referentie) {
      const waarden = TALEN.map(([, taal]) =>
        sleutel.split(".").reduce<unknown>(
          (o, k) => (o as Record<string, unknown>)?.[k],
          taal.indeling,
        ),
      );
      for (const [i, w] of waarden.entries()) {
        expect(typeof w, `${TALEN[i][0]}.${sleutel}`).toBe("string");
        expect((w as string).trim().length, `${TALEN[i][0]}.${sleutel} is leeg`).toBeGreaterThan(0);
      }
      const [fr_, nl_, ar_] = waarden as string[];
      // Een waarde zonder letters draagt geen taal: `manage.pending` is "…"
      // en hoort in alle drie de talen identiek te zijn. Zo'n token als
      // "onvertaald" bestempelen zou de test laten piepen om niets.
      if (!/\p{L}/u.test(fr_)) continue;
      expect(ar_, `ar.${sleutel} is een kopie van het Frans`).not.toBe(fr_);
      expect(ar_, `ar.${sleutel} is een kopie van het Nederlands`).not.toBe(nl_);
      if (fr_.includes(" ")) {
        expect(nl_, `nl.${sleutel} is een kopie van het Frans`).not.toBe(fr_);
      }
    }
  });

  it("I3 — de interpolaties overleven de vertaling", () => {
    for (const [naam, taal] of TALEN) {
      const ind = taal.indeling as Record<string, Record<string, string>>;
      expect(ind.subtitle as unknown as string, `${naam}.subtitle`).toMatch(/\{building\}/);
      expect(ind.summary.tantiemesMismatch, `${naam}.tantiemesMismatch`).toMatch(/\{toegekend\}/);
      expect(ind.summary.tantiemesMismatch, `${naam}.tantiemesMismatch`).toMatch(/\{verklaard\}/);
      expect(ind.block.subtotal, `${naam}.block.subtotal`).toMatch(/\{tantiemes\}/);
      expect(ind.lot.tantiemes, `${naam}.lot.tantiemes`).toMatch(/\{tantiemes\}/);
    }
  });

  it("I4 — het Arabisch is daadwerkelijk Arabisch schrift", () => {
    const ind = (ar as Record<string, unknown>).indeling as Record<string, string>;
    for (const sleutel of ["title", "notFound", "backToBuildings"]) {
      expect(ind[sleutel], `ar.indeling.${sleutel}`).toMatch(/[؀-ۿ]/);
    }
    expect(((ar as Record<string, unknown>).nav as Record<string, string>).layout).toMatch(
      /[؀-ۿ]/,
    );
  });
});

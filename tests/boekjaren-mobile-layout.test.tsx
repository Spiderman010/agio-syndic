// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

/**
 * RESPONSIVE LAYOUT — de boekjarenlijst en het formulier "nieuw boekjaar".
 *
 * HET BEWEZEN DEFECT
 *
 * Het formulier stond op `gridTemplateColumns: "1fr 1fr 1fr"`. Een kaal `1fr`
 * is `minmax(auto, 1fr)`, en die `auto` is de MIN-CONTENT-breedte van de
 * inhoud. Voor drie datum-/nummervelden ligt die samen ruim boven 360px, dus
 * het raster kromp niet mee: jaar, startdatum en einddatum bleven naast elkaar
 * staan, velden en foutmeldingen werden afgesneden en de pagina kreeg
 * horizontale overflow. In RTL viel daardoor een groot deel van kaart en
 * formulier buiten beeld.
 *
 * De lijstkaart had hetzelfde probleem in flex-vorm: `justify-between` zonder
 * `flex-wrap`, met bedrag, status en pijl in de rechterhelft.
 *
 * WAT DEZE SUITE WEL EN NIET BEWIJST — dit moet eerlijk blijven:
 *
 *  WEL: het layoutCONTRACT. Staat er precies één kolom zonder breekpunt, komt
 *       de driekolomsvorm uitsluitend achter een breekpunt vandaan, blijft het
 *       maximum drie, kunnen de tracks krimpen (`min-w-0`), staat er nergens
 *       een vaste minimumbreedte, en wordt er nergens fysiek (links/rechts)
 *       gepositioneerd in plaats van logisch (start/end). Plus: dat de
 *       submit- en validatiesemantiek van het formulier onaangeroerd is.
 *
 *  NIET: de gerenderde breedte in pixels. jsdom doet geen layout en evalueert
 *        geen media queries; een test die beweert "op 360px past het" zou hier
 *        liegen. Dat is in Chromium gemeten op 360/640/768/1440px, in NL, FR
 *        en AR/RTL, en staat in het takenrapport — niet hier.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = join(REPO, "src/app/[locale]/(app)/buildings/[id]/boekjaren");
const FORM_SRC = readFileSync(join(MAP, "BoekjaarForm.tsx"), "utf8");
const PAGE_SRC = readFileSync(join(MAP, "page.tsx"), "utf8");

const BLD = "11111111-1111-1111-1111-111111111111";

/** De breekpunten die Tailwind in dit project kent. */
const BREEKPUNTEN = ["sm", "md", "lg", "xl", "2xl"] as const;

/**
 * Bron zonder JSX- en blokcommentaar.
 *
 * De toelichtingen in deze twee bestanden CITEREN de klassen en attributen
 * waar het hier over gaat. Zonder deze stap zou een test over `dir="ltr"`
 * of over fysieke klassen aanslaan op zijn eigen uitleg.
 */
function zonderCommentaar(bron: string): string {
  return bron.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Losse utility-klassen van een element. */
function klassen(el: Element | null): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** Elke `className="..."`-waarde uit een bronbestand, als losse klassen. */
function klassenUitBron(bron: string): string[] {
  const uit: string[] = [];
  for (const m of bron.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    for (const stuk of (m[1] ?? m[2] ?? "").split(/\s+/)) {
      // Interpolaties (`${...}`) leveren geen letterlijke klasse op.
      if (stuk && !stuk.includes("$")) uit.push(stuk);
    }
  }
  return uit;
}

/** `sm:grid-cols-3` -> { prefix: "sm", basis: "grid-cols-3" } */
function splits(klasse: string): { prefix: string | null; basis: string } {
  const i = klasse.lastIndexOf(":");
  return i === -1
    ? { prefix: null, basis: klasse }
    : { prefix: klasse.slice(0, i), basis: klasse.slice(i + 1) };
}

// ---------------------------------------------------------------- mocks

const acties: FormData[] = [];

vi.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => {
    const fn = (key: string, waarden?: Record<string, unknown>) => {
      const basis = namespace ? `${namespace}.${key}` : key;
      return waarden ? `${basis}(${Object.values(waarden).join(",")})` : basis;
    };
    return Object.assign(fn, { rich: fn, markup: fn, raw: fn, has: () => true });
  },
  useLocale: () => "fr",
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => (key: string) =>
    namespace ? `${namespace}.${key}` : key,
  getLocale: async () => "fr",
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/navigation", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} onClick={(e) => e.preventDefault()} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("../src/app/[locale]/(app)/buildings/[id]/boekjaren/actions", () => ({
  createFiscalYear: async (formData: FormData) => {
    acties.push(formData);
    return undefined;
  },
}));

vi.mock("@/app/[locale]/(app)/buildings/[id]/boekjaren/actions", () => ({
  createFiscalYear: async (formData: FormData) => {
    acties.push(formData);
    return undefined;
  },
}));

type Resultaat = { data: unknown; error: unknown };

const state: { tabellen: Record<string, Resultaat> } = { tabellen: {} };

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

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabel: string) => keten(state.tabellen[tabel] ?? { data: [], error: null }),
  }),
}));

import BoekjaarForm from "../src/app/[locale]/(app)/buildings/[id]/boekjaren/BoekjaarForm";
import BoekjarenPage from "../src/app/[locale]/(app)/buildings/[id]/boekjaren/page";

function standaardTabellen(): Record<string, Resultaat> {
  return {
    buildings: { data: { id: BLD, name: "Résidence Atlas" }, error: null },
    fiscal_years: {
      data: [
        { id: "fy-2026", building_id: BLD, year: 2026, status: "open", start_date: "2026-01-01", end_date: "2026-12-31" },
        { id: "fy-2025", building_id: BLD, year: 2025, status: "closed", start_date: "2025-01-01", end_date: "2025-12-31" },
      ],
      error: null,
    },
    charge_calls: {
      data: [{ fiscal_year_id: "fy-2026", total_amount: 1500 }],
      error: null,
    },
  };
}

function toonFormulier(over: { existingYears?: number[]; huidigJaar?: number } = {}) {
  return render(
    <BoekjaarForm
      buildingId={BLD}
      existingYears={over.existingYears ?? []}
      huidigJaar={over.huidigJaar ?? 2026}
    />,
  );
}

async function toonPagina() {
  const el = await BoekjarenPage({ params: Promise.resolve({ id: BLD }) });
  return render(el);
}

beforeEach(() => {
  acties.length = 0;
  state.tabellen = standaardTabellen();
});

afterEach(() => {
  cleanup();
});

// ================================================================== L
describe("L — het formulierraster", () => {
  it("L1 — op mobiel staat er precies één kolom", () => {
    const { container } = toonFormulier();
    const raster = container.querySelector("form div.grid");
    expect(raster).not.toBeNull();

    const zonderBreekpunt = klassen(raster)
      .map(splits)
      .filter((k) => k.prefix === null && k.basis.startsWith("grid-cols-"));

    expect(zonderBreekpunt.map((k) => k.basis)).toEqual(["grid-cols-1"]);
  });

  it("L2 — meer dan één kolom komt uitsluitend achter een breekpunt vandaan", () => {
    const { container } = toonFormulier();
    const raster = container.querySelector("form div.grid")!;

    const meerkoloms = klassen(raster)
      .map(splits)
      .filter((k) => /^grid-cols-([2-9]|\d{2,})$/.test(k.basis));

    expect(meerkoloms.length).toBeGreaterThan(0);
    for (const k of meerkoloms) {
      expect(BREEKPUNTEN).toContain(k.prefix as (typeof BREEKPUNTEN)[number]);
    }
  });

  it("L3 — het maximum blijft drie kolommen", () => {
    const { container } = toonFormulier();
    const raster = container.querySelector("form div.grid")!;

    for (const k of klassen(raster).map(splits)) {
      const m = /^grid-cols-(\d+)$/.exec(k.basis);
      if (m) expect(Number(m[1])).toBeLessThanOrEqual(3);
    }
  });

  it("L4 — het aantal kolommen staat niet meer in een inline style", () => {
    // Een inline `gridTemplateColumns` kent geen breekpunt en zou de
    // media query van Tailwind bovendien overrulen: dit was de fout.
    expect(FORM_SRC).not.toMatch(/gridTemplateColumns/);
    expect(PAGE_SRC).not.toMatch(/gridTemplateColumns/);
  });

  it("L5 — elke kolom mag krimpen in plaats van te duwen", () => {
    const { container } = toonFormulier();
    for (const id of ["year", "start_date", "end_date"]) {
      const veld = container.querySelector(`#${id}`)!;
      const wrapper = veld.closest("div.grid > div");
      expect(wrapper, `wrapper van ${id}`).not.toBeNull();
      expect(klassen(wrapper)).toContain("min-w-0");
    }
  });

  it("L6 — label, veld, foutmelding en knop staan alle vier in de kaart", () => {
    const { container } = toonFormulier({ existingYears: [2026], huidigJaar: 2026 });
    const form = container.querySelector("form")!;

    for (const id of ["year", "start_date", "end_date"]) {
      expect(form.querySelector(`label[for="${id}"]`), `label ${id}`).not.toBeNull();
      expect(form.querySelector(`#${id}`), `veld ${id}`).not.toBeNull();
    }
    expect(form.textContent).toContain("boekjaren.yearExists(2026)");
    expect(form.querySelector("button")).not.toBeNull();
  });
});

// ================================================================== K
describe("K — de boekjaarkaart in de lijst", () => {
  it("K1 — de kaart breekt af in plaats van de pagina uit te duwen", async () => {
    const { container } = await toonPagina();
    const kaart = container.querySelector("a .card")!;
    const k = klassen(kaart);

    expect(k).toContain("flex");
    expect(k).toContain("flex-wrap");
    expect(k).toContain("justify-between");
  });

  it("K2 — de linkerhelft krimpt mee en de rechterhelft breekt af", async () => {
    const { container } = await toonPagina();
    const kaart = container.querySelector("a .card")!;
    const helften = Array.from(kaart.children);

    expect(helften.length).toBe(2);
    expect(klassen(helften[0])).toContain("min-w-0");
    expect(klassen(helften[1])).toContain("flex-wrap");
  });

  it("K3 — de detailpijl is een icoon dat in RTL meedraait", async () => {
    const { container } = await toonPagina();
    const pijl = container.querySelector("a .card svg");

    expect(pijl, "detailpijl ontbreekt").not.toBeNull();
    expect(klassen(pijl)).toContain("rtl:rotate-180");
    expect(klassen(pijl)).toContain("shrink-0");
    // De losse tekstpijl draaide niet mee en moet weg zijn.
    expect(PAGE_SRC).not.toMatch(/>→<\/span>/);
  });

  it("K4 — de periode blijft als bereik leesbaar, ook in een RTL-alinea", async () => {
    const { container } = await toonPagina();
    const periode = Array.from(container.querySelectorAll("a .card [dir='ltr']")).find((el) =>
      (el.textContent ?? "").includes("2026-01-01"),
    );

    expect(periode, "periode zonder dir=ltr").toBeTruthy();
    expect(periode!.textContent?.replace(/\s+/g, " ").trim()).toBe("2026-01-01 → 2026-12-31");
  });

  it("K5 — de kaart blijft bereikbaar als link naar het detailscherm", async () => {
    const { container } = await toonPagina();
    const links = Array.from(container.querySelectorAll("a"));

    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `/buildings/${BLD}/boekjaren/fy-2026`,
      `/buildings/${BLD}/boekjaren/fy-2025`,
    ]);
    for (const a of links) {
      expect(klassen(a)).toContain("block");
      expect(a.querySelector(".card"), "kaart binnen de link").not.toBeNull();
    }
  });

  it("K6 — volgorde, opgeroepen bedrag, status en lege toestand zijn onveranderd", async () => {
    const { container } = await toonPagina();
    const tekst = (container.textContent ?? "").replace(/\s+/g, " ");

    expect(tekst).toContain("boekjaren.title 2026");
    expect(tekst).toContain("boekjaren.title 2025");
    expect(tekst.indexOf("2026-01-01")).toBeLessThan(tekst.indexOf("2025-01-01"));
    expect(tekst).toContain("boekjaren.called");
    expect(tekst).toContain("boekjaren.status.open");
    expect(tekst).toContain("boekjaren.status.closed");

    cleanup();
    state.tabellen.fiscal_years = { data: [], error: null };
    const leeg = await toonPagina();
    expect((leeg.container.textContent ?? "")).toContain("boekjaren.noBoekjaren");
  });
});

// ================================================================== R
describe("R — logische richting, geen vaste maten", () => {
  const BRONNEN: Array<[string, string]> = [
    ["BoekjaarForm.tsx", zonderCommentaar(FORM_SRC)],
    ["page.tsx", zonderCommentaar(PAGE_SRC)],
  ];

  it("R1 — geen fysieke marge-, padding- of positioneringsklassen", () => {
    // Logisch (ms-/me-/ps-/pe-/start-/end-/text-start) draait mee met AR;
    // fysiek (ml-/mr-/pl-/pr-/left-/right-/text-left) doet dat niet.
    const verboden = /^(ml|mr|pl|pr|left|right|-left|-right)-|^text-(left|right)$/;
    for (const [naam, bron] of BRONNEN) {
      const fout = klassenUitBron(bron)
        .map((k) => splits(k).basis)
        .filter((b) => verboden.test(b));
      expect(fout, `${naam} bevat fysieke richtingsklassen`).toEqual([]);
    }
  });

  it("R2 — geen fysieke richting in inline styles", () => {
    // `textAlign: "center"` is richtingsneutraal en mag blijven; alleen
    // left/right kiezen een fysieke kant en breken daarmee in AR.
    const verboden =
      /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight)\b|textAlign:\s*["'](left|right)|\b(left|right)\s*:/;
    for (const [naam, bron] of BRONNEN) {
      for (const m of bron.matchAll(/style=\{\{([^}]*)\}\}/g)) {
        expect(verboden.test(m[1]), `${naam}: ${m[1]}`).toBe(false);
      }
    }
  });

  it("R3 — nergens een vaste minimumbreedte", () => {
    // `min-w-0` is het tegenovergestelde: het HEFT de impliciete
    // min-content-ondergrens juist op. Alles met een maat is verboden.
    for (const [naam, bron] of BRONNEN) {
      expect(bron, `${naam} bevat min-width`).not.toMatch(/min-width|minWidth/);
      const fout = klassenUitBron(bron)
        .map((k) => splits(k).basis)
        .filter((b) => b.startsWith("min-w-") && b !== "min-w-0");
      expect(fout, `${naam} bevat een vaste min-w`).toEqual([]);
    }
  });

  it("R4 — geen vaste pixelbreedte op de kaart of het formulier", () => {
    for (const [naam, bron] of BRONNEN) {
      const fout = klassenUitBron(bron)
        .map((k) => splits(k).basis)
        .filter((b) => /^w-\[\d/.test(b));
      expect(fout, `${naam} bevat een vaste breedte`).toEqual([]);
      expect(bron, `${naam} bevat width in px`).not.toMatch(/width:\s*["']?\d+px/);
    }
  });

  it("R5 — de enige richtingsoverride is het datumbereik zelf", () => {
    // `dir="ltr"` is hier geen layoutkeuze maar bidi-afscherming van twee
    // ISO-datums. Hij hoort nergens anders te staan; een `dir` om de kaart
    // of het formulier heen zou de Arabische leesrichting breken.
    const alle = [...zonderCommentaar(PAGE_SRC).matchAll(/dir="[^"]*"/g)].map((m) => m[0]);
    expect(alle).toEqual(['dir="ltr"']);
    expect(zonderCommentaar(FORM_SRC)).not.toMatch(/dir="/);
  });
});

// ================================================================== I
describe("I — FR/NL/AR-pariteit", () => {
  const TALEN: Array<[string, Record<string, unknown>]> = [
    ["fr", fr as Record<string, unknown>],
    ["nl", nl as Record<string, unknown>],
    ["ar", ar as Record<string, unknown>],
  ];

  function boekjaren(taal: Record<string, unknown>) {
    return taal.boekjaren as Record<string, unknown>;
  }

  it("I1 — alle drie de talen hebben exact dezelfde sleutels", () => {
    const platte = (o: Record<string, unknown>, pad = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === "object"
          ? platte(v as Record<string, unknown>, `${pad}${k}.`)
          : [`${pad}${k}`],
      );

    const referentie = platte(boekjaren(fr as Record<string, unknown>)).sort();
    expect(referentie.length).toBeGreaterThan(0);
    for (const [naam, taal] of TALEN) {
      expect(platte(boekjaren(taal)).sort(), `sleutels in ${naam}`).toEqual(referentie);
    }
  });

  it("I2 — elk label dat dit scherm gebruikt is gevuld en echt vertaald", () => {
    const gebruikt = ["title", "noBoekjaren", "newBoekjaar", "year", "startDate", "endDate", "createBtn", "called"];
    for (const sleutel of gebruikt) {
      const waarden = TALEN.map(([, taal]) => boekjaren(taal)[sleutel]);
      for (const [i, w] of waarden.entries()) {
        expect(typeof w, `${TALEN[i][0]}.${sleutel}`).toBe("string");
        expect((w as string).trim().length, `${TALEN[i][0]}.${sleutel} is leeg`).toBeGreaterThan(0);
      }
      // Drie verschillende talen horen drie verschillende teksten te geven;
      // een gekopieerde Franse string was precies wat de Preview-QA vond.
      expect(new Set(waarden).size, `${sleutel} is niet in drie talen vertaald`).toBe(3);
    }
  });

  it("I3 — de statuslabels en de jaar-bestaat-melding zijn compleet", () => {
    for (const [naam, taal] of TALEN) {
      const b = boekjaren(taal);
      const status = b.status as Record<string, string>;
      expect(status.open?.trim(), `${naam}.status.open`).toBeTruthy();
      expect(status.closed?.trim(), `${naam}.status.closed`).toBeTruthy();
      // De placeholder moet de vertaling overleven, anders toont het
      // formulier een melding zonder jaartal.
      expect(b.yearExists, `${naam}.yearExists mist {year}`).toMatch(/\{year\}/);
    }
  });

  it("I4 — het Arabisch is daadwerkelijk Arabisch schrift", () => {
    const b = boekjaren(ar as Record<string, unknown>);
    for (const sleutel of ["title", "newBoekjaar", "year", "startDate", "endDate"]) {
      expect(b[sleutel] as string, `ar.${sleutel}`).toMatch(/[؀-ۿ]/);
    }
  });
});

// ================================================================== S
describe("S — submit- en validatiesemantiek ongewijzigd", () => {
  it("S1 — het gebouw reist mee als verborgen veld", () => {
    const { container } = toonFormulier();
    const hidden = container.querySelector('input[name="building_id"]') as HTMLInputElement;
    expect(hidden.type).toBe("hidden");
    expect(hidden.value).toBe(BLD);
  });

  it("S2 — het jaarveld houdt zijn type, grenzen en verplichting", () => {
    const { container } = toonFormulier();
    const veld = container.querySelector("#year") as HTMLInputElement;
    expect(veld.name).toBe("year");
    expect(veld.type).toBe("number");
    expect(veld.min).toBe("2000");
    expect(veld.max).toBe("2100");
    expect(veld.required).toBe(true);
  });

  it("S3 — beide datumvelden blijven verplicht en volgen het gekozen jaar", () => {
    const { container } = toonFormulier({ huidigJaar: 2027 });
    for (const [id, waarde] of [["start_date", "2027-01-01"], ["end_date", "2027-12-31"]]) {
      const veld = container.querySelector(`#${id}`) as HTMLInputElement;
      expect(veld.name).toBe(id);
      expect(veld.type).toBe("date");
      expect(veld.required).toBe(true);
      expect(veld.value).toBe(waarde);
    }
  });

  it("S4 — een bestaand jaar blokkeert de knop en toont de melding", () => {
    const { container } = toonFormulier({ existingYears: [2026], huidigJaar: 2026 });
    const knop = container.querySelector("button") as HTMLButtonElement;
    expect(knop.disabled).toBe(true);
    expect(container.textContent).toContain("boekjaren.yearExists(2026)");
  });

  it("S5 — een vrij jaar laat de knop gewoon open", () => {
    const { container } = toonFormulier({ existingYears: [2025], huidigJaar: 2026 });
    const knop = container.querySelector("button") as HTMLButtonElement;
    expect(knop.disabled).toBe(false);
    expect(container.textContent).not.toContain("boekjaren.yearExists");
  });

  it("S6 — de blokkade volgt het ingetikte jaar, niet alleen de beginwaarde", () => {
    const { container } = toonFormulier({ existingYears: [2025], huidigJaar: 2026 });
    const veld = container.querySelector("#year") as HTMLInputElement;

    act(() => {
      fireEvent.change(veld, { target: { value: "2025" } });
    });
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      fireEvent.change(veld, { target: { value: "2027" } });
    });
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("S7 — verzenden bereikt de Server Action met alle vier de velden", async () => {
    const { container } = toonFormulier({ huidigJaar: 2026 });

    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });

    expect(acties.length).toBe(1);
    expect(acties[0].get("building_id")).toBe(BLD);
    expect(acties[0].get("year")).toBe("2026");
    expect(acties[0].get("start_date")).toBe("2026-01-01");
    expect(acties[0].get("end_date")).toBe("2026-12-31");
  });

  it("S8 — de bedrading naar de Server Action staat er nog", () => {
    // Een layoutingreep mag `action={formAction}` niet vervangen door een
    // onClick-handler; dan zou het formulier zonder JavaScript stilvallen.
    expect(FORM_SRC).toMatch(/useActionState<ActionState, FormData>/);
    expect(FORM_SRC).toMatch(/createFiscalYear\(fd\)/);
    expect(FORM_SRC).toMatch(/<form action=\{formAction\}/);
  });
});

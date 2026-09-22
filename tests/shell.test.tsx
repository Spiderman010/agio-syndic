// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { resetMatchMedia, setMatchMedia } from "./setup/jsdom-dialog";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Rendertests voor de applicatieschil.
 *
 * De schil is een client component die aan drie dingen hangt: next-intl,
 * de next-intl-navigatie en de server action `signOut`. Alle drie worden hier
 * gemockt, zodat de test gaat over wat de schil DOET — navigatie, actieve
 * staat, gebouwcontext, de mobiele lade en de leesrichting — en niet over de
 * bibliotheken eromheen.
 *
 * `useTranslations` echoot de sleutel terug (`nav.dashboard`). Daardoor toetst
 * deze test niet de vertaalde tekst maar dát er vertaald wordt; de volledigheid
 * van de vertalingen zelf wordt in tests/nav.test.ts gecontroleerd tegen de
 * echte berichtenbestanden.
 */

let mockPathname = "/dashboard";

vi.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => {
    const fn = (key: string) => (namespace ? `${namespace}.${key}` : key);
    return Object.assign(fn, { rich: fn, markup: fn, raw: fn, has: () => true });
  },
  useLocale: () => "fr",
}));

vi.mock("@/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  Link: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
  } & Record<string, unknown>) => (
    <a
      href={href}
      onClick={(e) => {
        // jsdom kan niet navigeren en logt anders "Not implemented: navigation"
        // bij elke klik op een echte link. De onClick van de component moet wel
        // gewoon afgaan — daar hangt het sluiten van de lade aan.
        e.preventDefault();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

// De echte module trekt de Supabase-serverclient mee; die hoort niet in een
// rendertest thuis.
vi.mock("@/app/[locale]/login/actions", () => ({ signOut: vi.fn() }));

const { default: AppShell } = await import("@/components/shell/AppShell");
const { default: Loading } = await import("@/app/[locale]/(app)/loading");
const { default: AppError } = await import("@/app/[locale]/(app)/error");
const { localeDirection } = await import("@/lib/direction");

const BID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const BUILDINGS = [
  { id: BID, name: "Résidence Atlas", address: "Casablanca" },
  { id: OTHER, name: "Résidence Al Amane", address: "Tanger" },
];

function renderShell(pathname: string) {
  mockPathname = pathname;
  return render(
    <AppShell orgName="Syndic Atlas" buildings={BUILDINGS}>
      <p>inhoud van de pagina</p>
    </AppShell>,
  );
}

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
  resetMatchMedia();
});

describe("de schil rendert", () => {
  it("toont sidebar, topbar, organisatienaam en de paginainhoud", () => {
    renderShell("/dashboard");
    expect(screen.getByTestId("sidebar")).toBeTruthy();
    expect(screen.getByText("Syndic Atlas")).toBeTruthy();
    expect(screen.getByText("inhoud van de pagina")).toBeTruthy();
    // De pagina-inhoud staat in het <main>-element van de schil, niet in een
    // eigen main per pagina.
    const main = document.querySelector("main#main-content");
    expect(main).toBeTruthy();
    expect(main?.textContent).toContain("inhoud van de pagina");
  });

  it("heeft precies één main-element", () => {
    renderShell("/buildings");
    expect(document.querySelectorAll("main").length).toBe(1);
  });

  it("biedt een overslaan-naar-inhoud-link die naar main wijst", () => {
    renderShell("/dashboard");
    const skip = screen.getByText("shell.skipToContent").closest("a");
    expect(skip?.getAttribute("href")).toBe("#main-content");
  });
});

describe("actieve navigatiestaat", () => {
  it("markeert het dashboard met aria-current op het dashboard", () => {
    renderShell("/dashboard");
    const items = screen.getAllByTestId("nav-dashboard");
    expect(items[0].getAttribute("aria-current")).toBe("page");
    expect(
      screen.getAllByTestId("nav-buildings")[0].getAttribute("aria-current"),
    ).toBeNull();
  });

  it("markeert Exercices ook op de detailpagina van een boekjaar", () => {
    renderShell(`/buildings/${BID}/boekjaren/abc`);
    expect(
      screen
        .getAllByTestId("nav-building-fiscal-years")[0]
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});

describe("gebouwcontext", () => {
  it("toont de gebouwnavigatie alleen binnen een gebouw", () => {
    renderShell("/dashboard");
    expect(screen.queryByTestId("nav-building-overview")).toBeNull();

    cleanup();
    renderShell(`/buildings/${BID}`);
    expect(screen.getAllByTestId("nav-building-overview").length).toBeGreaterThan(0);
  });

  it("toont de naam van het huidige gebouw in de kiezer", () => {
    renderShell(`/buildings/${BID}/expenses`);
    const switcher = screen.getAllByTestId("building-switcher")[0];
    expect(switcher.textContent).toContain("Résidence Atlas");
  });

  it("toont de broodkruimels met organisatie en gebouw", () => {
    renderShell(`/buildings/${BID}/expenses`);
    const crumbs = screen.getByTestId("breadcrumbs");
    expect(crumbs.textContent).toContain("Syndic Atlas");
    expect(crumbs.textContent).toContain("Résidence Atlas");
    expect(crumbs.textContent).toContain("nav.expenses");
    // Nooit een ruwe id in de kruimels.
    expect(crumbs.textContent).not.toContain(BID);
  });

  /**
   * BR1–BR2 — wat de gebruiker en de schermlezer werkelijk krijgen.
   *
   * tests/nav.test.ts bewijst de AFLEIDING van de kruimels; deze twee bewijzen
   * het GEVOLG, en dat is waar het gat zat: zonder eigen kruimel werd de
   * gebouwnaam de laatste en zette `Breadcrumbs` `aria-current="page"` daarop,
   * mét verlies van de overzichtslink. Alleen een render laat dat zien.
   */
  const SECTIEKRUIMELS: Array<[string, string]> = [
    ["wizard", "nav.setup"],
    ["indeling", "nav.layout"],
    ["lots", "nav.lots"],
    ["boekjaren", "nav.fiscalYears"],
    ["expenses", "nav.expenses"],
  ];

  it.each(SECTIEKRUIMELS)(
    "BR1 — op /%s draagt de sectiekruimel (%s) aria-current, niet het gebouw",
    (segment, label) => {
      renderShell(`/buildings/${BID}/${segment}`);
      const crumbs = screen.getByTestId("breadcrumbs");
      const huidig = crumbs.querySelectorAll('[aria-current="page"]');
      expect(huidig.length).toBe(1);
      expect(huidig[0].textContent).toBe(label);
      expect(huidig[0].textContent).not.toBe("Résidence Atlas");
    },
  );

  it.each(SECTIEKRUIMELS)(
    "BR2 — op /%s blijft het gebouw een klikbare kruimel naar zijn overzicht",
    (segment) => {
      renderShell(`/buildings/${BID}/${segment}`);
      const crumbs = screen.getByTestId("breadcrumbs");
      const gebouw = within(crumbs).getByText("Résidence Atlas");
      const link = gebouw.closest("a");
      expect(link, "de gebouwkruimel is geen link").toBeTruthy();
      expect(link?.getAttribute("href")).toBe(`/buildings/${BID}`);
      expect(gebouw.getAttribute("aria-current")).toBeNull();
    },
  );
});

describe("gebouwkiezer", () => {
  it("opent en toont alle gebouwen, met het huidige gemarkeerd", () => {
    renderShell(`/buildings/${BID}`);
    const trigger = screen.getAllByTestId("building-switcher")[0];
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByTestId("building-switcher-list");
    expect(within(menu).getByText("Résidence Al Amane")).toBeTruthy();
  });

  it("houdt de sectie vast bij het wisselen van gebouw", () => {
    renderShell(`/buildings/${BID}/expenses`);
    fireEvent.click(screen.getAllByTestId("building-switcher")[0]);
    const link = within(screen.getByTestId("building-switcher-list"))
      .getByText("Résidence Al Amane")
      .closest("a");
    // Van de uitgaven van A naar de uitgaven van B, niet terug naar het begin.
    expect(link?.getAttribute("href")).toBe(`/buildings/${OTHER}/expenses`);
  });

  it("verhuist NIET mee naar een boekjaar dat bij het andere gebouw niet bestaat", () => {
    renderShell(`/buildings/${BID}/boekjaren/some-fy-id`);
    fireEvent.click(screen.getAllByTestId("building-switcher")[0]);
    const link = within(screen.getByTestId("building-switcher-list"))
      .getByText("Résidence Al Amane")
      .closest("a");
    expect(link?.getAttribute("href")).toBe(`/buildings/${OTHER}/boekjaren`);
  });

  it("sluit met Escape", () => {
    renderShell(`/buildings/${BID}`);
    const trigger = screen.getAllByTestId("building-switcher")[0];
    fireEvent.click(trigger);
    expect(screen.queryByTestId("building-switcher-list")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("building-switcher-list")).toBeNull();
  });

  it("toont een lege staat wanneer er geen gebouwen zijn", () => {
    mockPathname = "/dashboard";
    render(
      <AppShell orgName="Syndic Atlas" buildings={[]}>
        <p>leeg</p>
      </AppShell>,
    );
    expect(screen.getByText("shell.noBuildings")).toBeTruthy();
    expect(screen.queryByTestId("building-switcher")).toBeNull();
  });
});

/**
 * Mobiele lade.
 *
 * De lade is een native <dialog> die met showModal() opengaat. Daarmee komt de
 * focusinsluiting van de BROWSER, niet van onze code. Wat hieronder getest
 * wordt is dus onze integratie met dat platformcontract; dat de focus
 * werkelijk opgesloten zit, is in een echte browser geverifieerd — jsdom kent
 * geen top layer en geen inerte achtergrond, en een emulatie daarvan zou alleen
 * zichzelf testen. Zie tests/setup/jsdom-dialog.ts.
 */
describe("mobiele navigatie — lade", () => {
  let drawer: HTMLDialogElement;

  beforeEach(() => {
    renderShell("/dashboard");
    drawer = screen.getByTestId("mobile-drawer") as HTMLDialogElement;
  });

  // A
  it("opent via de menuknop", () => {
    expect(drawer.open).toBe(false);
    fireEvent.click(screen.getByTestId("menu-button"));
    expect(drawer.open).toBe(true);
    expect(screen.getByTestId("menu-button").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  // I — het mechanisme dat de insluiting levert
  it("is een echte <dialog> die MODAAL wordt geopend, niet een nagebouwde overlay", () => {
    // Dit is de kern van de fix: een modale <dialog> maakt de achtergrond
    // browser-side inert. Een div met role="dialog" belooft dat alleen.
    expect(drawer.tagName).toBe("DIALOG");
    const spy = vi.spyOn(drawer, "showModal");
    fireEvent.click(screen.getByTestId("menu-button"));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    // En hij claimt niets wat de browser al impliceert.
    expect(drawer.getAttribute("aria-modal")).toBeNull();
    expect(drawer.getAttribute("role")).toBeNull();
  });

  // B
  it("zet de focus bij openen binnen de lade", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  // I — de zelfgebouwde achtergrondknop bestond buiten de lade en ving focus
  it("heeft geen zelfgebouwde overlay-knop meer buiten de lade", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    // Vroeger waren dit er twee: de sluitknop ín de lade en een schermvullende
    // <button> als achtergrond, die als focusstop tússen achtergrond en lade
    // stond. De ::backdrop van een <dialog> is een pseudo-element en dus niet
    // focusbaar.
    const sluitknoppen = screen.getAllByLabelText("shell.closeMenu");
    expect(sluitknoppen).toHaveLength(1);
    expect(drawer.contains(sluitknoppen[0])).toBe(true);
  });

  // De inhoud bestaat alleen als de lade open is, zodat de navigatie niet
  // dubbel in de toegankelijkheidsboom staat.
  it("houdt de lade-inhoud uit de DOM zolang hij dicht is", () => {
    expect(drawer.textContent).toBe("");
    fireEvent.click(screen.getByTestId("menu-button"));
    expect(within(drawer).getByTestId("nav-dashboard")).toBeTruthy();
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(drawer.textContent).toBe("");
  });

  it("vergrendelt het scrollen van de pagina zolang de lade open is", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  // G
  it("sluit met de sluitknop", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(drawer.open).toBe(false);
  });

  // E
  it("sluit met Escape", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(drawer.open).toBe(false);
  });

  // F — een klik op de ::backdrop heeft de dialoog zelf als target
  it("sluit bij een klik op de achtergrond, maar niet bij een klik op de inhoud", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    fireEvent.click(within(drawer).getByText("Agio Syndic"));
    expect(drawer.open).toBe(true);

    fireEvent.click(drawer);
    expect(drawer.open).toBe(false);
  });

  // H — het herstelpad hangt aan het close-event, dus het geldt voor ELK pad
  it.each([
    ["sluitknop", () => fireEvent.click(screen.getByTestId("drawer-close"))],
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["achtergrondklik", () => fireEvent.click(screen.getByTestId("mobile-drawer"))],
    [
      "navigatieklik",
      () => fireEvent.click(within(screen.getByTestId("mobile-drawer")).getByTestId("nav-buildings")),
    ],
  ])("geeft de focus terug aan de menuknop na sluiten via %s", (_naam, sluit) => {
    const button = screen.getByTestId("menu-button");
    fireEvent.click(button);
    expect(document.activeElement).not.toBe(button);

    sluit();

    expect(drawer.open).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  /**
   * Boven de lg-grens verdwijnt de menuknop. Bleef de lade dan open, dan hield
   * hij als modale dialoog de hele pagina inert terwijl de knop om hem te
   * sluiten niet meer zichtbaar is — de gebruiker zit vast.
   *
   * Dit pad is uitsluitend hier te toetsen: de browseromgeving waarin ik het
   * handmatig wilde natrekken dispatcht bij een geëmuleerde viewportwijziging
   * geen `resize` en geen matchMedia-`change`.
   */
  it("sluit zichzelf zodra het scherm de desktopgrens passeert", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    expect(drawer.open).toBe(true);

    act(() => setMatchMedia("(min-width: 1024px)", true));

    expect(drawer.open).toBe(false);
  });
});

describe("gebouwkiezer — semantiek", () => {
  // K
  it("gebruikt GEEN half ARIA-menupatroon", () => {
    renderShell(`/buildings/${BID}`);
    const trigger = screen.getAllByTestId("building-switcher")[0];
    // Een role="menu" verplicht tot pijltoetsnavigatie en focusbeheer; die is
    // er niet en hoort er voor een lijst met links ook niet te zijn.
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();

    fireEvent.click(trigger);
    const lijst = screen.getByTestId("building-switcher-list");
    expect(lijst.tagName).toBe("UL");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it("koppelt de knop aan de lijst en meldt de open staat", () => {
    renderShell(`/buildings/${BID}`);
    const trigger = screen.getAllByTestId("building-switcher")[0];
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(
      screen.getByTestId("building-switcher-list").id,
    );
  });

  // J
  it("maakt het actieve gebouw herkenbaar zonder kleur of icoon", () => {
    renderShell(`/buildings/${BID}`);
    fireEvent.click(screen.getAllByTestId("building-switcher")[0]);
    const lijst = screen.getByTestId("building-switcher-list");

    const actief = within(lijst).getByText("Résidence Atlas").closest("a");
    const ander = within(lijst).getByText("Résidence Al Amane").closest("a");
    expect(actief?.getAttribute("aria-current")).toBe("true");
    expect(ander?.getAttribute("aria-current")).toBeNull();

    // Het vinkje blijft decoratief; het mag de aankondiging niet dragen.
    expect(actief?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("laadstaat", () => {
  // L
  it("kondigt het laden aan zonder het skelet voor te lezen", () => {
    const { container } = render(<Loading />);
    const root = screen.getByTestId("app-loading");

    // De status wordt aangekondigd...
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("shell.loading")).toBeTruthy();

    // ...maar de losse grijze blokken niet.
    const skelet = container.querySelector(".animate-pulse");
    expect(skelet?.getAttribute("aria-hidden")).toBe("true");
    // Een skelet in plaats van een spinner: blokken met een vaste hoogte,
    // zodat de inhoud er straks zonder sprong in past.
    expect(skelet?.querySelectorAll("div").length).toBeGreaterThan(3);
  });

  it("verbergt de statustekst visueel", () => {
    render(<Loading />);
    expect(screen.getByText("shell.loading").className).toContain("sr-only");
  });
});

describe("foutstaat", () => {
  it("toont een vaste tekst met een herstelknop en lekt GEEN databasedetails", () => {
    const reset = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const leak =
      'duplicate key value violates unique constraint "payments_pkey"';

    render(
      <AppError
        error={Object.assign(new Error(leak), { digest: "abc123" })}
        reset={reset}
      />,
    );

    expect(screen.getByText("shell.error.title")).toBeTruthy();
    expect(screen.getByText("shell.error.body")).toBeTruthy();
    // De rauwe PostgreSQL-melding mag nergens op het scherm staan.
    expect(document.body.textContent).not.toContain(leak);
    expect(document.body.textContent).not.toContain("constraint");
    // De digest is een hash zonder inhoud en mag wel zichtbaar zijn.
    expect(document.body.textContent).toContain("abc123");

    spy.mockRestore();
  });

  it("biedt een uitweg via reset", () => {
    const reset = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppError error={new Error("boem")} reset={reset} />);
    fireEvent.click(screen.getByText("shell.error.retry"));
    expect(reset).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("leesrichting", () => {
  it("zet Arabisch op rtl en de rest op ltr", () => {
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("fr")).toBe("ltr");
    expect(localeDirection("nl")).toBe("ltr");
  });

  /**
   * De schil mag geen enkele fysieke richting gebruiken. Zou iemand `ml-4` of
   * `border-l` schrijven, dan valt de Arabische versie stil uit elkaar zonder
   * dat een rendertest dat merkt. Deze test leest daarom de broncode.
   */
  it("gebruikt uitsluitend logische CSS-richtingen in de schilcomponenten", () => {
    const dir = join(REPO_ROOT, "src", "components", "shell");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8");
      // Fysieke varianten binnen een className-string.
      const physical = source.match(
        /\b(ml-|mr-|pl-|pr-|border-l\b|border-r\b|left-|right-|text-left|text-right)/g,
      );
      if (physical) offenders.push(`${file}: ${[...new Set(physical)].join(", ")}`);
    }
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
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
});

describe("gebouwkiezer", () => {
  it("opent en toont alle gebouwen, met het huidige gemarkeerd", () => {
    renderShell(`/buildings/${BID}`);
    const trigger = screen.getAllByTestId("building-switcher")[0];
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Résidence Al Amane")).toBeTruthy();
  });

  it("houdt de sectie vast bij het wisselen van gebouw", () => {
    renderShell(`/buildings/${BID}/expenses`);
    fireEvent.click(screen.getAllByTestId("building-switcher")[0]);
    const link = within(screen.getByRole("menu"))
      .getByText("Résidence Al Amane")
      .closest("a");
    // Van de uitgaven van A naar de uitgaven van B, niet terug naar het begin.
    expect(link?.getAttribute("href")).toBe(`/buildings/${OTHER}/expenses`);
  });

  it("verhuist NIET mee naar een boekjaar dat bij het andere gebouw niet bestaat", () => {
    renderShell(`/buildings/${BID}/boekjaren/some-fy-id`);
    fireEvent.click(screen.getAllByTestId("building-switcher")[0]);
    const link = within(screen.getByRole("menu"))
      .getByText("Résidence Al Amane")
      .closest("a");
    expect(link?.getAttribute("href")).toBe(`/buildings/${OTHER}/boekjaren`);
  });

  it("sluit met Escape", () => {
    renderShell(`/buildings/${BID}`);
    const trigger = screen.getAllByTestId("building-switcher")[0];
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
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

describe("mobiele navigatie", () => {
  beforeEach(() => renderShell("/dashboard"));

  it("opent de lade via de menuknop en zet die als dialoog neer", () => {
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();
    fireEvent.click(screen.getByTestId("menu-button"));

    const drawer = screen.getByTestId("mobile-drawer");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("menu-button").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("vergrendelt het scrollen van de pagina zolang de lade open is", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("sluit met de sluitknop, met Escape en met de achtergrond", () => {
    fireEvent.click(screen.getByTestId("menu-button"));
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();

    fireEvent.click(screen.getByTestId("menu-button"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();

    fireEvent.click(screen.getByTestId("menu-button"));
    fireEvent.click(screen.getByLabelText("shell.closeMenu", { selector: "button.absolute" }));
    expect(screen.queryByTestId("mobile-drawer")).toBeNull();
  });

  it("geeft de focus terug aan de menuknop na sluiten", () => {
    const button = screen.getByTestId("menu-button");
    fireEvent.click(button);
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(document.activeElement).toBe(button);
  });
});

describe("laadstaat", () => {
  it("rendert een skelet dat voor schermlezers verborgen is", () => {
    const { container } = render(<Loading />);
    const root = container.firstElementChild;
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    // Een skelet in plaats van een spinner: blokken met een vaste hoogte,
    // zodat de inhoud er straks zonder sprong in past.
    expect(container.querySelectorAll("div").length).toBeGreaterThan(3);
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

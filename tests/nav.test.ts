import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  allNavHrefs,
  buildBreadcrumbs,
  buildingNavItems,
  currentBuildingId,
  globalNavItems,
  isNavItemActive,
} from "@/lib/nav";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BID = "11111111-2222-3333-4444-555555555555";

describe("navigatiemodel", () => {
  it("toont alleen items waarvoor een route bestaat", () => {
    expect(globalNavItems().map((i) => i.key)).toEqual([
      "dashboard",
      "buildings",
      "owners",
    ]);
    expect(buildingNavItems(BID).map((i) => i.key)).toEqual([
      "building-overview",
      // "Instellen" staat vóór de indeling: het is het scherm waar je bij een
      // nieuw gebouw begint.
      "building-setup",
      "building-layout",
      "building-lots",
      "building-fiscal-years",
      "building-expenses",
    ]);
  });

  it("bouwt gebouwpaden op het meegegeven id", () => {
    for (const item of buildingNavItems(BID)) {
      expect(item.href.startsWith(`/buildings/${BID}`)).toBe(true);
    }
  });
});

describe("actieve navigatiestaat", () => {
  // Op SLEUTEL zoeken, niet op positie: een nieuw menu-item mag deze tests niet
  // laten omvallen op een verschoven index.
  const globaal = (key: string) => globalNavItems().find((i) => i.key === key)!;
  const gebouw = (key: string) => buildingNavItems(BID).find((i) => i.key === key)!;
  const dashboard = globaal("dashboard");
  const buildings = globaal("buildings");
  const overview = gebouw("building-overview");
  const fiscalYears = gebouw("building-fiscal-years");
  const expenses = gebouw("building-expenses");

  it("markeert het dashboard alleen op het dashboard zelf", () => {
    expect(isNavItemActive("/dashboard", dashboard)).toBe(true);
    expect(isNavItemActive("/buildings", dashboard)).toBe(false);
  });

  it("markeert Immeubles exact, niet binnen een gebouw", () => {
    expect(isNavItemActive("/buildings", buildings)).toBe(true);
    // Binnen een gebouw neemt de gebouwzone het over; twee oplichtende items
    // zouden alleen maar verwarren.
    expect(isNavItemActive(`/buildings/${BID}`, buildings)).toBe(false);
  });

  it("markeert het gebouwoverzicht exact", () => {
    expect(isNavItemActive(`/buildings/${BID}`, overview)).toBe(true);
    expect(isNavItemActive(`/buildings/${BID}/expenses`, overview)).toBe(false);
  });

  it("houdt Exercices actief op de detailpagina van een boekjaar", () => {
    expect(isNavItemActive(`/buildings/${BID}/boekjaren`, fiscalYears)).toBe(true);
    expect(isNavItemActive(`/buildings/${BID}/boekjaren/abc`, fiscalYears)).toBe(true);
    expect(isNavItemActive(`/buildings/${BID}/expenses`, fiscalYears)).toBe(false);
  });

  it("negeert een afsluitende slash", () => {
    expect(isNavItemActive("/dashboard/", dashboard)).toBe(true);
    expect(isNavItemActive(`/buildings/${BID}/`, overview)).toBe(true);
  });

  it("laat een prefix niet op een halve segmentnaam matchen", () => {
    // `/buildings/x/boekjaren-archief` mag Exercices NIET activeren.
    expect(
      isNavItemActive(`/buildings/${BID}/boekjaren-archief`, fiscalYears),
    ).toBe(false);
    expect(isNavItemActive(`/buildings/${BID}/expenses-old`, expenses)).toBe(false);
  });
});

describe("gebouwcontext", () => {
  it("leest het gebouw uit het pad", () => {
    expect(currentBuildingId(`/buildings/${BID}`)).toBe(BID);
    expect(currentBuildingId(`/buildings/${BID}/expenses`)).toBe(BID);
    expect(currentBuildingId(`/buildings/${BID}/boekjaren/xyz`)).toBe(BID);
  });

  it("geeft null buiten gebouwcontext", () => {
    expect(currentBuildingId("/dashboard")).toBeNull();
    expect(currentBuildingId("/buildings")).toBeNull();
    expect(currentBuildingId("/")).toBeNull();
  });
});

describe("broodkruimels", () => {
  const base = { orgName: "Syndic Atlas", buildingName: "Résidence Atlas" };

  it("toont geen kruimels op het dashboard", () => {
    expect(buildBreadcrumbs({ ...base, pathname: "/dashboard" })).toEqual([]);
  });

  it("loopt organisatie → gebouwen op het overzicht", () => {
    const crumbs = buildBreadcrumbs({ ...base, pathname: "/buildings" });
    expect(crumbs.map((c) => c.text ?? c.labelKey)).toEqual([
      "Syndic Atlas",
      "buildings",
    ]);
    // De laatste kruimel is geen link.
    expect(crumbs[crumbs.length - 1].href).toBeNull();
  });

  it("voegt de gebouwnaam toe binnen een gebouw", () => {
    const crumbs = buildBreadcrumbs({
      ...base,
      pathname: `/buildings/${BID}`,
    });
    expect(crumbs.map((c) => c.text ?? c.labelKey)).toEqual([
      "Syndic Atlas",
      "buildings",
      "Résidence Atlas",
    ]);
  });

  it("voegt de sectie toe en maakt de gebouwnaam klikbaar", () => {
    const crumbs = buildBreadcrumbs({
      ...base,
      pathname: `/buildings/${BID}/boekjaren`,
    });
    expect(crumbs.map((c) => c.text ?? c.labelKey)).toEqual([
      "Syndic Atlas",
      "buildings",
      "Résidence Atlas",
      "fiscalYears",
    ]);
    expect(crumbs[2].href).toBe(`/buildings/${BID}`);
  });

  it("toont NOOIT een ruwe id als kruimel", () => {
    const crumbs = buildBreadcrumbs({
      ...base,
      pathname: `/buildings/${BID}/boekjaren/99999999-8888-7777-6666-555555555555`,
    });
    const labels = crumbs.map((c) => c.text ?? c.labelKey ?? "");
    for (const label of labels) {
      expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
  });

  it("valt terug op een vertaalsleutel als de gebouwnaam onbekend is", () => {
    const crumbs = buildBreadcrumbs({
      orgName: "Syndic Atlas",
      buildingName: null,
      pathname: `/buildings/${BID}`,
    });
    expect(crumbs[2]).toEqual({ labelKey: "building", text: null, href: null });
  });
});

describe("geen dode links", () => {
  /**
   * De kernregel van deze sprint: elk menu-item wijst naar een route die
   * werkelijk bestaat. Deze test leest de bestandsstructuur, dus hij faalt
   * zodra iemand een item toevoegt zonder de bijbehorende pagina.
   */
  it("elke navigatie-href heeft een page.tsx onder (app)", () => {
    for (const href of allNavHrefs(BID)) {
      const segments = href.split("/").filter(Boolean);
      const routeDir = segments
        .map((s) => (s === BID ? "[id]" : s))
        .join("/");
      const file = join(
        REPO,
        "src",
        "app",
        "[locale]",
        "(app)",
        routeDir,
        "page.tsx",
      );
      expect(existsSync(file), `ontbrekende route voor ${href}: ${file}`).toBe(
        true,
      );
    }
  });
});

describe("vertalingen van de schil", () => {
  const locales = { fr, nl, ar } as Record<string, Record<string, unknown>>;

  it("elk navigatielabel bestaat in fr, nl en ar", () => {
    const keys = [
      ...globalNavItems().map((i) => i.labelKey),
      ...buildingNavItems(BID).map((i) => i.labelKey),
      "building",
      "breadcrumb",
    ];
    for (const [name, messages] of Object.entries(locales)) {
      const nav = messages.nav as Record<string, string> | undefined;
      expect(nav, `namespace nav ontbreekt in ${name}`).toBeDefined();
      for (const key of keys) {
        expect(nav?.[key], `nav.${key} ontbreekt in ${name}`).toBeTruthy();
      }
    }
  });

  it("de schil- en dashboardteksten bestaan in alle talen", () => {
    const shellKeys = [
      "organisation",
      "building",
      "signOut",
      "skipToContent",
      "mainNav",
      "openMenu",
      "closeMenu",
      "noBuildings",
      "allBuildings",
      "switchBuilding",
    ];
    for (const [name, messages] of Object.entries(locales)) {
      const shell = messages.shell as Record<string, unknown> | undefined;
      expect(shell, `namespace shell ontbreekt in ${name}`).toBeDefined();
      for (const key of shellKeys) {
        expect(shell?.[key], `shell.${key} ontbreekt in ${name}`).toBeTruthy();
      }
      const error = shell?.error as Record<string, string> | undefined;
      for (const key of ["title", "body", "retry", "reference"]) {
        expect(error?.[key], `shell.error.${key} ontbreekt in ${name}`).toBeTruthy();
      }
      const dash = messages.dashboard as Record<string, unknown> | undefined;
      expect(dash?.title, `dashboard.title ontbreekt in ${name}`).toBeTruthy();
    }
  });

  it("geen enkele taal mist een sleutel die het Frans wel heeft", () => {
    const leaves = (o: unknown, p = ""): string[] =>
      o && typeof o === "object"
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
            leaves(v, `${p}${k}.`),
          )
        : [p.slice(0, -1)];
    const frKeys = new Set(leaves(fr));
    for (const [name, messages] of Object.entries({ nl, ar })) {
      const other = new Set(leaves(messages));
      const missing = [...frKeys].filter((k) => !other.has(k));
      expect(missing, `ontbrekend in ${name}: ${missing.join(", ")}`).toEqual([]);
    }
  });
});

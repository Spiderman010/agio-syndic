/**
 * Navigatiemodel van de applicatieschil.
 *
 * Dit bestand bevat GEEN React. Alles wat de navigatie bepaalt — welke items
 * bestaan, welk item actief is, welk gebouw in context staat en hoe de
 * broodkruimels lopen — is een pure functie. Twee redenen:
 *
 *  1. Het is de enige manier om de regel "geen dode links" afdwingbaar te
 *     maken. `allNavHrefs()` levert elke href die de schil ooit rendert; de
 *     test vergelijkt die lijst met de werkelijk bestaande routes onder
 *     src/app. Voegt iemand later een menu-item toe zonder route, dan faalt de
 *     test in plaats van de gebruiker.
 *  2. De bestaande Vitest-opstelling draait in een node-omgeving zonder DOM.
 *     Door de logica hier te houden is het leeuwendeel van de schil testbaar
 *     zonder rendering.
 *
 * Labels zijn VERTAALSLEUTELS, nooit tekst. De componenten vertalen; dit
 * bestand kent geen Frans, Nederlands of Arabisch.
 *
 * Paden zijn locale-loos (`/buildings`, niet `/fr/buildings`): zowel de `Link`
 * als de `usePathname` uit `@/navigation` werken op paden zonder localeprefix.
 */

/** Iconnaam; de sidebar vertaalt dit naar een lucide-component. */
export type NavIcon =
  | "dashboard"
  | "buildings"
  | "overview"
  | "fiscalYears"
  | "expenses"
  | "owners"
  | "lots";

export type NavItem = {
  /** Stabiele sleutel, ook gebruikt als React-key en als testanker. */
  key: string;
  /** Locale-loos pad. */
  href: string;
  /** Sleutel binnen de `nav`-namespace van de vertaalbestanden. */
  labelKey: string;
  icon: NavIcon;
  /**
   * true  -> alleen actief bij een exacte padmatch
   * false -> ook actief op onderliggende paden
   *
   * "Immeubles" is exact: staat de gebruiker ín een gebouw, dan neemt de
   * gebouwzone het over en zou een tweede oplichtend item alleen verwarren.
   * "Exercices" is een prefix, zodat het item actief blijft op de detailpagina
   * van een boekjaar.
   */
  exact: boolean;
};

export type Crumb = {
  /** Vertaalsleutel binnen `nav`, óf null wanneer `text` al een naam is. */
  labelKey: string | null;
  /** Letterlijke tekst (organisatie- of gebouwnaam); niet vertaald. */
  text: string | null;
  /** Ontbreekt bij de laatste kruimel: die is geen link. */
  href: string | null;
};

/**
 * Organisatiebrede navigatie.
 *
 * Bewust ALLEEN items waarvoor een route bestaat. "Équipe" en "Paramètres"
 * horen volgens het navigatiemodel hier thuis, maar er is nog geen
 * /team- of /settings-route. Ze worden daarom niet getoond — een menu-item dat
 * nergens heen gaat is erger dan een ontbrekend menu-item.
 */
export function globalNavItems(): NavItem[] {
  return [
    {
      key: "dashboard",
      href: "/dashboard",
      labelKey: "dashboard",
      icon: "dashboard",
      exact: true,
    },
    {
      key: "buildings",
      href: "/buildings",
      labelKey: "buildings",
      icon: "buildings",
      exact: true,
    },
    {
      // Copropriétaires zijn ORGANISATIEBREED: een eigenaar hoort bij de
      // organisatie en kan lots in meerdere gebouwen hebben. Daarom staat dit
      // item hier en niet in de gebouwnavigatie. Prefix, zodat het actief blijft
      // op de detailpagina van een eigenaar.
      key: "owners",
      href: "/owners",
      labelKey: "owners",
      icon: "owners",
      exact: false,
    },
  ];
}

/**
 * Navigatie binnen één gebouw.
 *
 * Ook hier geldt de dode-linkregel. "Lots", "Propriétaires" en "Appels de
 * fonds" bestaan als functionaliteit, maar als SECTIE binnen een bestaande
 * pagina en niet als eigen route; "Documents" bestaat nog helemaal niet. Ze
 * krijgen pas een menu-item zodra ze een eigen route hebben.
 */
export function buildingNavItems(buildingId: string): NavItem[] {
  const base = `/buildings/${buildingId}`;
  return [
    {
      key: "building-overview",
      href: base,
      labelKey: "overview",
      icon: "overview",
      exact: true,
    },
    {
      // Lots horen bij exact één gebouw; deze route toont er nooit meer dan dat.
      key: "building-lots",
      href: `${base}/lots`,
      labelKey: "lots",
      icon: "lots",
      exact: false,
    },
    {
      key: "building-fiscal-years",
      href: `${base}/boekjaren`,
      labelKey: "fiscalYears",
      icon: "fiscalYears",
      exact: false,
    },
    {
      key: "building-expenses",
      href: `${base}/expenses`,
      labelKey: "expenses",
      icon: "expenses",
      exact: false,
    },
  ];
}

/** Normaliseert een pad: geen dubbele of afsluitende slash. */
function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function isNavItemActive(pathname: string, item: NavItem): boolean {
  const path = normalize(pathname);
  const href = normalize(item.href);
  if (item.exact) return path === href;
  return path === href || path.startsWith(href + "/");
}

/**
 * Het gebouw dat in de URL staat, of null buiten gebouwcontext.
 *
 * De scope zit bewust in het pad en niet in een cookie of serverstate: een
 * boeking op het verkeerde gebouw is de duurste fout in dit domein, en een
 * zichtbaar pad is de goedkoopste bescherming daartegen. Bovendien werken
 * meerdere tabbladen naast elkaar en blijven links deelbaar.
 */
export function currentBuildingId(pathname: string): string | null {
  const segments = normalize(pathname).split("/").filter(Boolean);
  if (segments[0] !== "buildings") return null;
  const id = segments[1];
  if (!id) return null;
  return id;
}

/**
 * Broodkruimels, afgeleid uit het pad.
 *
 * Bewust GEEN routeregister. De routeboom is klein en bekend; een register zou
 * meer onderhoud kosten dan het oplevert.
 *
 * Eén bewuste beperking: de detailpagina van een boekjaar eindigt op een UUID
 * waarvan de schil het jaartal niet kent (de layout krijgt de params van
 * onderliggende segmenten niet). In plaats van een UUID te tonen stopt de
 * kruimelketen bij "Exercices"; de pagina zelf draagt het jaartal in zijn H1.
 * Zodra een boekjaarlabel in de layout beschikbaar is, kan die kruimel erbij.
 */
export function buildBreadcrumbs(args: {
  pathname: string;
  orgName: string;
  buildingName: string | null;
}): Crumb[] {
  const { pathname, orgName, buildingName } = args;
  const segments = normalize(pathname).split("/").filter(Boolean);

  // Op het dashboard zou de enige kruimel de organisatienaam zijn; die staat al
  // in de sidebar. Geen kruimelspoor dus.
  if (segments.length === 0 || segments[0] === "dashboard") return [];

  const crumbs: Crumb[] = [
    { labelKey: null, text: orgName, href: "/dashboard" },
  ];

  if (segments[0] === "owners") {
    // Op de detailpagina staat de naam van de eigenaar in de H1; de schil kent
    // die naam niet, dus de keten stopt bij "Copropriétaires".
    crumbs.push({ labelKey: "owners", text: null, href: null });
    return crumbs;
  }

  if (segments[0] !== "buildings") return crumbs;

  const buildingId = segments[1];
  crumbs.push({
    labelKey: "buildings",
    text: null,
    href: buildingId ? "/buildings" : null,
  });
  if (!buildingId) return crumbs;

  const sub = segments[2];
  crumbs.push({
    labelKey: buildingName ? null : "building",
    text: buildingName,
    href: sub ? `/buildings/${buildingId}` : null,
  });
  if (!sub) return crumbs;

  if (sub === "lots") {
    crumbs.push({ labelKey: "lots", text: null, href: null });
  } else if (sub === "boekjaren") {
    crumbs.push({ labelKey: "fiscalYears", text: null, href: null });
  } else if (sub === "expenses") {
    crumbs.push({ labelKey: "expenses", text: null, href: null });
  }
  return crumbs;
}

/**
 * Elke href die de schil kan renderen, voor de dode-linktest.
 * `buildingId` is een voorbeeld-id; de test vervangt het door een placeholder.
 */
export function allNavHrefs(buildingId: string): string[] {
  return [
    ...globalNavItems().map((i) => i.href),
    ...buildingNavItems(buildingId).map((i) => i.href),
  ];
}

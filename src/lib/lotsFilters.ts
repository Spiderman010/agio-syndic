import type { LotStatus, UnitRow } from "@/lib/ownership";

/**
 * Het URL-CONTRACT van het lotsscherm.
 *
 * ── WAAROM DE URL EN NIET REACT-STATE ──────────────────────────────────────
 *
 * Filteren en sorteren staan volledig in de querystring en worden op de server
 * toegepast. Dat is geen stijlkeuze maar wat dit scherm bruikbaar maakt: een
 * gefilterde lijst is deelbaar, hij overleeft een refresh, hij werkt zonder
 * JavaScript, en de terugknop doet wat hij hoort te doen. Er komt dus geen
 * `use client` en geen state aan te pas — alleen gewone GET-navigatie.
 *
 * ── ONBEKENDE WAARDEN ──────────────────────────────────────────────────────
 *
 * Elke parameter valt terug op zijn standaard zodra de waarde niet in de
 * toegestane verzameling zit. `?status=bestaatniet` levert dus de ONGEFILTERDE
 * lijst op en niet een lege — een typefout in een gedeelde link mag geen lot
 * laten verdwijnen. Een afgewezen waarde gedraagt zich exact als "niet gezet":
 * hij filtert niet en hij krijgt ook geen chip.
 *
 * De toegestane lottypes komen niet uit een lijst hier maar uit de DATA van dit
 * gebouw (`typesUitData`). Er staat geen check-constraint op `units.unit_type`,
 * dus een lijst hier zou een aanname zijn die de database niet afdwingt.
 *
 * ── WAT HIER NIET GEBEURT ──────────────────────────────────────────────────
 *
 * Geen eigendomslogica. De statusfilter vergelijkt met `regel.status`, die al
 * door `lotStatus()` is bepaald; deze module kent de regels erachter niet en
 * hoort ze niet te kennen.
 */

/** Alleen deze parameters horen bij het lotsscherm; "alles wissen" raakt de rest niet. */
export const LOTS_PARAMS = ["q", "type", "status", "sort", "dir"] as const;
export type LotsParam = (typeof LOTS_PARAMS)[number];

/**
 * Sorteersleutels die ALTIJD een waarde hebben.
 *
 * `floor` en `area_m2` zijn er bewust niet bij: beide zijn nullable, en
 * `area_m2` is bovendien `number | string | null`, dus een ordening erover zou
 * per rij van type kunnen verschillen. Een sortering die soms op tekst en soms
 * op getal vergelijkt, is erger dan geen sortering.
 */
export type LotsSortKey = "label" | "tantiemes";
export type LotsSortDir = "asc" | "desc";

const SORT_KEYS: Record<LotsSortKey, true> = { label: true, tantiemes: true };
const SORT_DIRS: Record<LotsSortDir, true> = { asc: true, desc: true };

/**
 * Elke `LotStatus`, exhaustief door constructie: komt er een status bij het
 * type, dan faalt dit object in de typecheck en niet stil in de filter.
 */
const STATUSSEN: Record<LotStatus, true> = {
  compleet: true,
  zonderEigenaar: true,
  ambigu: true,
  medeEigendom: true,
  zonderTantieme: true,
};

export const LOT_STATUSSEN = Object.keys(STATUSSEN) as readonly LotStatus[];
export const LOT_SORT_KEYS = Object.keys(SORT_KEYS) as readonly LotsSortKey[];
export const LOT_SORT_DIRS = Object.keys(SORT_DIRS) as readonly LotsSortDir[];

/** De standaard: queryvolgorde, niets gefilterd. */
export const STANDAARD_SORT: LotsSortKey = "label";
export const STANDAARD_DIR: LotsSortDir = "asc";

export type LotsFilters = {
  /** Getrimde zoekterm; leeg betekent niet gezet. */
  zoekterm: string;
  /** Lottype, of `null` bij niet gezet of onbekend. */
  type: string | null;
  /** Eigendomsstatus, of `null` bij niet gezet of onbekend. */
  status: LotStatus | null;
  sort: LotsSortKey;
  dir: LotsSortDir;
};

export type LotsZoekParams = Partial<Record<LotsParam, string | string[]>>;

/** De eerste waarde; een herhaalde parameter (`?type=a&type=b`) neemt de eerste. */
function eerste(waarde: string | string[] | undefined): string {
  if (Array.isArray(waarde)) return waarde[0] ?? "";
  return waarde ?? "";
}

/** De lottypes die in dit gebouw werkelijk voorkomen, in queryvolgorde, zonder dubbele. */
export function typesUitData(units: readonly UnitRow[]): readonly string[] {
  const gezien = new Set<string>();
  const uit: string[] = [];
  for (const unit of units) {
    if (unit.unit_type && !gezien.has(unit.unit_type)) {
      gezien.add(unit.unit_type);
      uit.push(unit.unit_type);
    }
  }
  return uit;
}

export function leesLotsFilters(
  params: LotsZoekParams,
  geldigeTypes: readonly string[],
): LotsFilters {
  const type = eerste(params.type);
  const status = eerste(params.status);
  const sort = eerste(params.sort);
  const dir = eerste(params.dir);

  return {
    zoekterm: eerste(params.q).trim(),
    type: geldigeTypes.includes(type) ? type : null,
    status: (LOT_STATUSSEN as readonly string[]).includes(status)
      ? (status as LotStatus)
      : null,
    sort: sort in SORT_KEYS ? (sort as LotsSortKey) : STANDAARD_SORT,
    dir: dir in SORT_DIRS ? (dir as LotsSortDir) : STANDAARD_DIR,
  };
}

/** Staat er iets aan dat de lijst inperkt? Sortering is geen filter. */
export function heeftActieveFilters(filters: LotsFilters): boolean {
  return filters.zoekterm !== "" || filters.type !== null || filters.status !== null;
}

/**
 * De querystring voor een variant op de huidige toestand.
 *
 * `patch` overschrijft per parameter; `null` haalt hem weg. Alles wat niet in
 * `LOTS_PARAMS` staat blijft ongemoeid — dat is wat "wissen raakt alleen de
 * lotsparameters" betekent. Locale en gebouw-id staan in het PAD en niet in de
 * query, dus die kunnen hier per definitie niet sneuvelen.
 *
 * Standaardwaarden worden weggelaten, zodat de URL niet volloopt met
 * `?sort=label&dir=asc` zodra iemand één chip weghaalt.
 */
export function lotsQueryString(
  filters: LotsFilters,
  patch: Partial<Record<LotsParam, string | null>> = {},
  overige: Readonly<Record<string, string>> = {},
): string {
  const huidig: Record<LotsParam, string> = {
    q: filters.zoekterm,
    type: filters.type ?? "",
    status: filters.status ?? "",
    sort: filters.sort === STANDAARD_SORT ? "" : filters.sort,
    dir: filters.dir === STANDAARD_DIR ? "" : filters.dir,
  };

  const zoek = new URLSearchParams();
  for (const [sleutel, waarde] of Object.entries(overige)) {
    if (waarde !== "") zoek.set(sleutel, waarde);
  }
  for (const param of LOTS_PARAMS) {
    const gepatcht = param in patch ? patch[param] : huidig[param];
    if (gepatcht !== null && gepatcht !== undefined && gepatcht !== "") {
      zoek.set(param, gepatcht);
    }
  }

  // Een richting zonder sleutel zegt niets; hij zou alleen ruis in de URL zijn.
  if (!zoek.has("sort")) zoek.delete("dir");

  const uit = zoek.toString();
  return uit === "" ? "" : `?${uit}`;
}

/** Het pad van het lotsscherm met een variant op de huidige filters. */
export function lotsHref(
  buildingId: string,
  filters: LotsFilters,
  patch: Partial<Record<LotsParam, string | null>> = {},
  overige: Readonly<Record<string, string>> = {},
): string {
  return `/buildings/${buildingId}/lots${lotsQueryString(filters, patch, overige)}`;
}

/** Alle lotsparameters weg, de rest behouden. */
export function lotsHrefLeeg(
  buildingId: string,
  overige: Readonly<Record<string, string>> = {},
): string {
  const zoek = new URLSearchParams();
  for (const [sleutel, waarde] of Object.entries(overige)) {
    if (waarde !== "") zoek.set(sleutel, waarde);
  }
  const uit = zoek.toString();
  return `/buildings/${buildingId}/lots${uit === "" ? "" : `?${uit}`}`;
}

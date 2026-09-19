import type { OwnershipRow } from "@/lib/ownership";

/**
 * De indeling van ÉÉN gebouw: welke blokken bestaan er, welke lots hangen
 * eraan, en wat is de stand per lot.
 *
 * ── WAAROM HIER GEEN QUERY STAAT ───────────────────────────────────────────
 *
 * Dit bestand rekent alleen. Het ophalen en het FAIL-CLOSED samenvoegen van de
 * bronnen gebeurt op de pagina, via dezelfde `assembleOwnership()` die het
 * lotsscherm gebruikt. Zou deze module zelf gaan ophalen, dan ontstond er een
 * tweede datapad met een eigen opvatting over wat "leeg" betekent — precies
 * wat er op het oude overzichtsscherm al misging.
 *
 * ── EEN LOT VERDWIJNT NOOIT ────────────────────────────────────────────────
 *
 * Blokken worden getoond zolang ze niet gearchiveerd zijn. Maar archiveren zet
 * alleen `archived_at`; het laat `units.block_id` ONGEMOEID. Een lot kan dus
 * naar een blok wijzen dat niet meer in beeld komt. Groepeer je dan puur op de
 * zichtbare blokken, dan valt dat lot stil uit de indeling — en een gebouw met
 * twintig lots toont er zeventien zonder dat iemand het merkt.
 *
 * Daarom drie soorten groepen:
 *
 *   blok           een bestaand, niet-gearchiveerd blok
 *   zonderBlok     `block_id IS NULL` — een geldige, gewone toestand
 *   onbereikbaar   wijst naar een gearchiveerd of onbekend blok
 *
 * De derde is een uitzonderingstoestand en hoort zichtbaar te zijn, niet
 * stilzwijgend bij "zonder blok" geveegd: die lots HEBBEN een blok, het is
 * alleen niet meer in gebruik.
 *
 * ── DE DRIE STANDEN SLUITEN ELKAAR UIT ─────────────────────────────────────
 *
 * Precedentie: `onvolledig` > `vrij` > `gekoppeld`. Een lot zonder tantième
 * kan niet in een lastenoproep meedoen; dat weegt zwaarder dan een ontbrekende
 * eigenaar, die tijdens het inrichten van een gebouw juist normaal is.
 *
 * Ze sluiten elkaar uit zodat elke telling optelt tot het aantal lots. Eén
 * woord, één betekenis — ook in de gebouwsamenvatting. Zou `vrij` daar iets
 * anders betekenen dan in de blokteller, dan staan er twee getallen op één
 * scherm die hetzelfde lijken te zeggen en dat niet doen.
 */

export type BlockRow = {
  id: string;
  building_id: string;
  code: string;
  name: string | null;
  sort_order: number;
  archived_at: string | null;
};

export type LayoutUnitRow = {
  id: string;
  building_id: string;
  block_id: string | null;
  label: string;
  unit_type: string;
  /** `null` komt voor: de kolom is bij oudere rijen niet altijd gevuld. */
  tantiemes: number | null;
};

/** Minimaal wat deze module van een eigenaar nodig heeft. */
export type LayoutOwnerRow = { id: string; full_name: string };

export type LotStaat = "gekoppeld" | "vrij" | "onvolledig";

export type LotTegel = {
  id: string;
  label: string;
  unitType: string;
  tantiemes: number | null;
  /** `null` als er geen actuele hoofdelijke eigenaar is. */
  eigenaarId: string | null;
  /**
   * `null` TERWIJL `eigenaarId` gevuld is betekent: er is wél een eigenaar,
   * maar zijn naam is niet te herleiden. Dat mag NOOIT als "vrij" verschijnen —
   * dat zou een beheerder uitnodigen een eigenaar te koppelen die er al is.
   */
  eigenaarNaam: string | null;
  staat: LotStaat;
};

export type BlokSoort = "blok" | "zonderBlok" | "onbereikbaar";

export type BlokGroep = {
  /** Stabiele sleutel voor de render; niet noodzakelijk een blok-id. */
  sleutel: string;
  soort: BlokSoort;
  code: string | null;
  naam: string | null;
  lots: LotTegel[];
  telling: Record<LotStaat, number>;
  tantiemeSubtotaal: number;
  /** Waar geldt: minstens één lot in dit blok mist een bruikbaar tantième. */
  subtotaalOnvolledig: boolean;
};

export type IndelingSamenvatting = {
  blokken: number;
  lots: number;
  eigenaren: number;
  vrij: number;
  onvolledig: number;
  tantiemesToegekend: number;
  tantiemesVerklaard: number;
  tantiemesSluiten: boolean;
};

export type Indeling = {
  groepen: BlokGroep[];
  samenvatting: IndelingSamenvatting;
};

/** Heeft dit lot een bruikbaar tantième? Ontbrekend en nul tellen allebei niet. */
export function heeftTantieme(tantiemes: number | null): boolean {
  return typeof tantiemes === "number" && Number.isFinite(tantiemes) && tantiemes > 0;
}

/**
 * De actuele hoofdelijke eigendomsrij van een lot, of `null`.
 *
 * Spiegelt wat de allocation engine als debiteur aanwijst: lopend
 * (`end_date IS NULL`) én aangewezen (`is_primary_debtor`). Bij meerdere
 * kandidaten wordt op `id` gesorteerd, zodat de uitkomst niet afhangt van de
 * volgorde waarin PostgREST de rijen toevallig teruggeeft.
 */
export function actueleEigendom(rijen: readonly OwnershipRow[]): OwnershipRow | null {
  const kandidaten = rijen
    .filter((r) => r.end_date === null && r.is_primary_debtor === true)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return kandidaten[0] ?? null;
}

function legeTelling(): Record<LotStaat, number> {
  return { gekoppeld: 0, vrij: 0, onvolledig: 0 };
}

export function bouwIndeling({
  buildingId,
  blocks,
  units,
  ownership,
  owners,
  totalTantiemes,
}: {
  buildingId: string;
  blocks: readonly BlockRow[];
  units: readonly LayoutUnitRow[];
  ownership: readonly OwnershipRow[];
  owners: readonly LayoutOwnerRow[];
  totalTantiemes: number;
}): Indeling {
  // Gordel én bretels. De queries filteren al op dit gebouw; deze filters
  // zorgen dat een lot of blok van een ander gebouw ook dan niet in beeld komt
  // als een query ooit ruimer wordt gemaakt dan bedoeld.
  const eigenBlokken = blocks.filter((b) => b.building_id === buildingId);
  const eigenUnits = units.filter((u) => u.building_id === buildingId);

  const zichtbareBlokken = eigenBlokken
    .filter((b) => b.archived_at === null)
    .sort((a, b) =>
      a.sort_order !== b.sort_order
        ? a.sort_order - b.sort_order
        : a.code < b.code
          ? -1
          : a.code > b.code
            ? 1
            : 0,
    );
  const zichtbaarPerId = new Map(zichtbareBlokken.map((b) => [b.id, b]));

  const eigenaarNaamPerId = new Map(owners.map((o) => [o.id, o.full_name]));
  const eigendomPerUnit = new Map<string, OwnershipRow[]>();
  for (const rij of ownership) {
    const lijst = eigendomPerUnit.get(rij.unit_id);
    if (lijst) lijst.push(rij);
    else eigendomPerUnit.set(rij.unit_id, [rij]);
  }

  const tegel = (unit: LayoutUnitRow): LotTegel => {
    const actueel = actueleEigendom(eigendomPerUnit.get(unit.id) ?? []);
    const eigenaarId = actueel?.owner_id ?? null;
    const eigenaarNaam = eigenaarId ? (eigenaarNaamPerId.get(eigenaarId) ?? null) : null;

    const staat: LotStaat = !heeftTantieme(unit.tantiemes)
      ? "onvolledig"
      : eigenaarId === null
        ? "vrij"
        : "gekoppeld";

    return {
      id: unit.id,
      label: unit.label,
      unitType: unit.unit_type,
      tantiemes: unit.tantiemes,
      eigenaarId,
      eigenaarNaam,
      staat,
    };
  };

  const maakGroep = (
    sleutel: string,
    soort: BlokSoort,
    code: string | null,
    naam: string | null,
    lots: LotTegel[],
  ): BlokGroep => {
    const telling = legeTelling();
    let subtotaal = 0;
    let onvolledig = false;
    for (const lot of lots) {
      telling[lot.staat] += 1;
      if (heeftTantieme(lot.tantiemes)) subtotaal += lot.tantiemes as number;
      else onvolledig = true;
    }
    return {
      sleutel,
      soort,
      code,
      naam,
      lots,
      telling,
      tantiemeSubtotaal: subtotaal,
      subtotaalOnvolledig: onvolledig,
    };
  };

  const opLabel = (a: LotTegel, b: LotTegel) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : 1;

  const tegelsVan = (filter: (u: LayoutUnitRow) => boolean) =>
    eigenUnits.filter(filter).map(tegel).sort(opLabel);

  const groepen: BlokGroep[] = zichtbareBlokken.map((blok) =>
    maakGroep(
      blok.id,
      "blok",
      blok.code,
      blok.name,
      tegelsVan((u) => u.block_id === blok.id),
    ),
  );

  const zonderBlok = tegelsVan((u) => u.block_id === null);
  if (zonderBlok.length > 0) {
    groepen.push(maakGroep("zonder-blok", "zonderBlok", null, null, zonderBlok));
  }

  const onbereikbaar = tegelsVan(
    (u) => u.block_id !== null && !zichtbaarPerId.has(u.block_id),
  );
  if (onbereikbaar.length > 0) {
    groepen.push(maakGroep("onbereikbaar", "onbereikbaar", null, null, onbereikbaar));
  }

  const alleLots = groepen.flatMap((g) => g.lots);
  const tantiemesToegekend = groepen.reduce((s, g) => s + g.tantiemeSubtotaal, 0);

  return {
    groepen,
    samenvatting: {
      blokken: zichtbareBlokken.length,
      lots: alleLots.length,
      eigenaren: new Set(
        alleLots.map((l) => l.eigenaarId).filter((id): id is string => id !== null),
      ).size,
      vrij: alleLots.filter((l) => l.staat === "vrij").length,
      onvolledig: alleLots.filter((l) => l.staat === "onvolledig").length,
      tantiemesToegekend,
      tantiemesVerklaard: totalTantiemes,
      tantiemesSluiten: tantiemesToegekend === totalTantiemes,
    },
  };
}

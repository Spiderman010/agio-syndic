import { actueleEigendom, type BlockRow, type LayoutUnitRow } from "@/lib/layout";
import type { OwnershipRow } from "@/lib/ownership";

/**
 * De INSTELCHECKLIST van één gebouw.
 *
 * ── DE VOORTGANG IS DE DATA ────────────────────────────────────────────────
 *
 * Er wordt niets over de voortgang opgeslagen. Elke stapstand wordt bij elke
 * paginaweergave opnieuw uit blokken, lots, eigenaren en eigendom afgeleid.
 * Daarmee is "hervatten" geen functie die kan verlopen: wie halverwege stopt en
 * een week later terugkomt, ziet de stand van de werkelijkheid en niet die van
 * een opgeslagen stap die inmiddels niet meer klopt.
 *
 * Het alternatief — een `wizard_step`-kolom — zou bij elke wijziging buiten de
 * wizard om (iemand voegt een lot toe via het lotsscherm) uiteen gaan lopen met
 * de werkelijkheid. Deze module heeft dat probleem per constructie niet.
 *
 * ── GEEN TWEEDE DEFINITIE VAN "GEKOPPELD" ──────────────────────────────────
 *
 * Of een lot een eigenaar heeft, wordt bepaald met `actueleEigendom()` uit
 * `lib/layout.ts` — dezelfde functie die het indelingsscherm gebruikt. Hier een
 * eigen variant schrijven zou twee antwoorden op één vraag opleveren, en dan is
 * het een kwestie van tijd tot ze verschillen.
 *
 * ── WAT DEZE MODULE NIET DOET ──────────────────────────────────────────────
 *
 * Niets muteren. De checklist wijst naar de bestaande schermen; daar gebeurt het
 * aanmaken en koppelen, met de guards en meldingen die daar al staan.
 */

/**
 * De stand van één stap.
 *
 *   klaar     — af; er valt hier niets meer te doen.
 *   bezig     — begonnen maar niet af (deels gekoppeld).
 *   tedoen    — nog niets gedaan, en het kan nu.
 *   optioneel — leeg is een GELDIGE eindtoestand. Nooit een fout.
 *   wacht     — kan nog niet, omdat een eerdere stap ontbreekt.
 *
 * `optioneel` en `wacht` bestaan apart van `tedoen` omdat ze iets anders
 * betekenen. Een gebouw zonder blokken is niet "onvoltooid" — veel gebouwen
 * hebben geen blokken. En koppelen zonder lots is niet "nog te doen", het is
 * onmogelijk; dat als taak presenteren stuurt iemand naar een scherm waar hij
 * niets kan.
 */
export type StapStand = "klaar" | "bezig" | "tedoen" | "optioneel" | "wacht";

export type StapSleutel = "gebouw" | "blokken" | "lots" | "eigenaren" | "koppelen";

export type Stap = {
  sleutel: StapSleutel;
  nummer: number;
  stand: StapStand;
  /** Waarden voor de vertaalde samenvatting; leeg als de zin er geen nodig heeft. */
  waarden: Record<string, number>;
  /** Pad binnen de app waar deze stap gedaan wordt. Nooit de wizard zelf. */
  href: string;
};

export type Checklist = {
  stappen: Stap[];
  /** Hoeveel stappen zijn af of geldig-leeg. Voor de voortgangsbalk. */
  gedaan: number;
  /** Hoeveel stappen er in totaal zijn. */
  totaal: number;
  /** Alles af? Dan wijst de wizard naar het indelingsoverzicht. */
  compleet: boolean;
};

export type ChecklistBronnen = {
  buildingId: string;
  /** Niet-gearchiveerde blokken horen hier; archiveren telt niet als "heeft blokken". */
  blocks: readonly BlockRow[];
  units: readonly LayoutUnitRow[];
  ownership: readonly OwnershipRow[];
  /** Aantal eigenaren IN DE ORGANISATIE. Eigenaren zijn organisatiebreed. */
  aantalEigenaren: number;
};

/** Een stap telt als "gedaan" zodra er niets meer van de gebruiker wordt gevraagd. */
const GEDAAN: readonly StapStand[] = ["klaar", "optioneel"];

export function bouwChecklist({
  buildingId,
  blocks,
  units,
  ownership,
  aantalEigenaren,
}: ChecklistBronnen): Checklist {
  const basis = `/buildings/${buildingId}`;

  // GEBOUWSCOPE. De pagina scoopt zijn queries al, maar een rij die er langs
  // glipt mag nooit meetellen: dan zou de checklist over een ander gebouw gaan.
  const eigenBlokken = blocks.filter(
    (b) => b.building_id === buildingId && b.archived_at === null,
  );
  const eigenUnits = units.filter((u) => u.building_id === buildingId);

  // De eigendomsrijen worden NIET vooraf op dit gebouw gefilterd, en dat is
  // geen vergetelheid: de telling hieronder zoekt per EIGEN lot zijn rijen op
  // (`perUnit.get(u.id)`), dus een rij van een vreemd of onbekend lot wordt
  // nooit opgevraagd. Een filter ervoor zou de uitkomst niet kunnen veranderen —
  // en een controle die niets kan veranderen leest als bescherming zonder het
  // te zijn. Hier sluit de scope, en W18/W19 bewijzen dat.
  const perUnit = new Map<string, OwnershipRow[]>();
  for (const rij of ownership) {
    const lijst = perUnit.get(rij.unit_id);
    if (lijst) lijst.push(rij);
    else perUnit.set(rij.unit_id, [rij]);
  }

  const gekoppeld = eigenUnits.filter(
    (u) => actueleEigendom(perUnit.get(u.id) ?? []) !== null,
  ).length;
  const aantalLots = eigenUnits.length;
  const vrij = aantalLots - gekoppeld;

  const stappen: Stap[] = [
    {
      sleutel: "gebouw",
      nummer: 1,
      // Deze checklist wordt alleen gerenderd voor een gebouw dat bestaat; als
      // we hier zijn, is stap 1 per definitie af.
      stand: "klaar",
      waarden: {},
      href: basis,
    },
    {
      sleutel: "blokken",
      nummer: 2,
      // Nul blokken is GEEN fout en geen openstaande taak. Een gebouw zonder
      // blokken is een compleet gebouw; de lots hangen dan rechtstreeks eronder.
      stand: eigenBlokken.length > 0 ? "klaar" : "optioneel",
      waarden: { aantal: eigenBlokken.length },
      href: `${basis}/indeling`,
    },
    {
      sleutel: "lots",
      nummer: 3,
      stand: aantalLots > 0 ? "klaar" : "tedoen",
      waarden: { aantal: aantalLots },
      href: `${basis}/indeling`,
    },
    {
      sleutel: "eigenaren",
      nummer: 4,
      // Eigenaren zijn ORGANISATIEBREED: ze worden op één plek aangemaakt en
      // kunnen lots in meerdere gebouwen bezitten. De vraag die deze stap stelt
      // is daarom "is er iemand om te koppelen", niet "heeft dit gebouw
      // eigenaren" — dat laatste is stap 5.
      stand: aantalEigenaren > 0 ? "klaar" : "tedoen",
      waarden: { aantal: aantalEigenaren },
      href: "/owners",
    },
    {
      sleutel: "koppelen",
      nummer: 5,
      stand: koppelStand({ aantalLots, gekoppeld, aantalEigenaren }),
      waarden: { gekoppeld, totaal: aantalLots, vrij },
      href: `${basis}/lots`,
    },
  ];

  const gedaan = stappen.filter((s) => GEDAAN.includes(s.stand)).length;

  return {
    stappen,
    gedaan,
    totaal: stappen.length,
    compleet: gedaan === stappen.length,
  };
}

/**
 * De stand van het koppelen.
 *
 * Zonder lots, of zonder ook maar één eigenaar, is koppelen niet "nog te doen"
 * maar onmogelijk: het scherm biedt dan niets aan. `wacht` zegt dat eerlijk en
 * verwijst impliciet naar de stap die eerst moet.
 */
function koppelStand({
  aantalLots,
  gekoppeld,
  aantalEigenaren,
}: {
  aantalLots: number;
  gekoppeld: number;
  aantalEigenaren: number;
}): StapStand {
  if (aantalLots === 0 || aantalEigenaren === 0) return "wacht";
  if (gekoppeld === 0) return "tedoen";
  return gekoppeld === aantalLots ? "klaar" : "bezig";
}

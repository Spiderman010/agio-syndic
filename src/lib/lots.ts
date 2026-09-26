import {
  STANDAARD_DIR,
  STANDAARD_SORT,
  type LotsFilters,
} from "@/lib/lotsFilters";
import {
  classifyOwnership,
  currentOwnerships,
  groupByUnit,
  lotStatus,
  matchesUnitSearch,
  tantiemeOverzicht,
  transferability,
  type LotStatus,
  type OwnerRow,
  type OwnershipRow,
  type TantiemeOverzicht,
  type Transferability,
  type UnitRow,
} from "@/lib/ownership";

/**
 * Het VIEWMODEL van het lotsscherm.
 *
 * ── WAAROM DIT BESTAAT ─────────────────────────────────────────────────────
 *
 * `page.tsx` doorliep de zichtbare lots twee keer: één keer voor de tabel en
 * één keer voor de actielijst. Beide lussen riepen `classifyOwnership(rijen)`
 * opnieuw aan. Dat kostte niet alleen werk — het waren twee ONAFHANKELIJKE
 * antwoorden op dezelfde vraag, en twee antwoorden kunnen uiteenlopen zodra
 * iemand er één aanpast. Nu wordt elk lot precies één keer geclassificeerd en
 * consumeren alle secties dezelfde rij.
 *
 * ── WAT HIER NIET GEBEURT ──────────────────────────────────────────────────
 *
 * Er wordt niets HERBEREKEND. `classifyOwnership`, `lotStatus`,
 * `transferability`, `currentOwnerships` en `tantiemeOverzicht` komen
 * ongewijzigd uit `lib/ownership.ts` en blijven daar wonen: het zijn letterlijke
 * vertalingen van condities in `create_charge_call` (m20), en een tweede
 * definitie ervan zou een tweede waarheid over financiële veiligheid opleveren.
 * Deze module roept ze aan, in dezelfde volgorde, met dezelfde invoer.
 *
 * ── VOLGORDE ───────────────────────────────────────────────────────────────
 *
 * De lots komen binnen in de volgorde die de query oplegt (`order("label")`).
 * ZONDER expliciete sortering blijft die volgorde ONAANGERAAKT: er wordt dan
 * geen enkele sorteerfunctie aangeroepen. Dat is met opzet, want de collatie van
 * Postgres is niet die van JavaScript — `A10` vóór of ná `A9` kan per taal
 * verschillen, en een JS-sortering op label zou de zichtbare volgorde stil laten
 * afwijken van wat de database teruggaf.
 *
 * Daarom:
 *
 *   label + asc   (standaard) -> queryvolgorde, niets aangeraakt
 *   label + desc              -> die volgorde OMGEKEERD; exact de inverse van de
 *                                databasecollatie, dus nog steeds niet zelf
 *                                vergeleken
 *   tantiemes                 -> numeriek, met de queryvolgorde als tie-break,
 *                                zodat gelijke tantièmes stabiel blijven staan
 *
 * ── AFGELEIDE PRESENTATIEDATA, MEER NIET ───────────────────────────────────
 *
 * Geen queries, geen acties, geen rollen, geen vertaling. Alleen: gegeven deze
 * rijen, wat staat er op het scherm.
 */

/** Eén actuele eigenaar zoals de tabel hem toont. */
export type LotEigenaar = {
  /** De eigendomsrij; `id` is tevens het anker voor de React-key. */
  ownershipId: string;
  ownerId: string;
  /** Opgeloste naam, of `null` als de eigenaar niet herleidbaar is. */
  naam: string | null;
  isPrimaryDebtor: boolean;
};

export type LotRegel = {
  unit: UnitRow;
  /** Alle eigendomsrijen van dit lot, ongefilterd — ook gesloten historie. */
  rijen: readonly OwnershipRow[];
  /** Uitsluitend de lopende rijen, in de volgorde van `currentOwnerships`. */
  eigenaren: readonly LotEigenaar[];
  /** Aantal lopende eigendomsrijen; bepaalt of de debiteurmarkering verschijnt. */
  aantalActief: number;
  /** De aangewezen debiteur, of `null`. Uit `classifyOwnership`. */
  debiteurNaam: string | null;
  status: LotStatus;
  /** Heeft dit lot ENIGE historie? Bepaalt eerste koppeling versus overdracht. */
  heeftHistorie: boolean;
  overdracht: Transferability;
  /**
   * Naam van de huidige eigenaar ZODRA overdracht is toegestaan, anders `null`.
   *
   * Staat hier en niet in de component, omdat het letterlijk dezelfde opzoeking
   * is als voorheen (`ownerNaam.get(overdracht.current.owner_id)`) en omdat de
   * component `overdracht.current` dan niet opnieuw hoeft te narrowen.
   */
  overdrachtEigenaarNaam: string | null;
};

export type LotsOverzicht = {
  /** Alle lots van het gebouw, in queryvolgorde. */
  alle: readonly LotRegel[];
  /** De lots die aan ALLE actieve filters voldoen, in de gevraagde volgorde. */
  zichtbaar: readonly LotRegel[];
  /** Ongewijzigd doorgegeven uit `tantiemeOverzicht`. */
  samenvatting: TantiemeOverzicht;
};

export type LotsOverzichtBronnen = {
  units: readonly UnitRow[];
  ownership: readonly OwnershipRow[];
  owners: readonly OwnerRow[];
  /** `buildings.total_tantiemes`, de declaratieve controlewaarde. */
  verklaard: number;
  /** Het volledige filter- en sorteercontract uit de URL. */
  filters: LotsFilters;
  /** Vandaag in ISO, voor het overdrachtsvenster. */
  vandaag: string;
};

export function bouwLotsOverzicht({
  units,
  ownership,
  owners,
  verklaard,
  filters,
  vandaag,
}: LotsOverzichtBronnen): LotsOverzicht {
  const perUnit = groupByUnit(ownership);
  const ownerNaam = new Map(owners.map((o) => [o.id, o.full_name]));

  const alle: LotRegel[] = units.map((unit) => {
    const rijen = perUnit.get(unit.id) ?? [];
    // ÉÉN keer per lot. Elke sectie leest hieronder dezelfde uitkomst.
    const klassering = classifyOwnership(rijen);
    const lopend = currentOwnerships(rijen);
    const overdracht = transferability(rijen, vandaag);

    return {
      unit,
      rijen,
      eigenaren: lopend.map((rij) => ({
        ownershipId: rij.id,
        ownerId: rij.owner_id,
        // `null` en niet een vertaalde tekst: welk woord er voor een
        // onherleidbare eigenaar staat, is een keuze van de component.
        naam: ownerNaam.get(rij.owner_id) ?? null,
        isPrimaryDebtor: rij.is_primary_debtor,
      })),
      aantalActief: klassering.nActive,
      debiteurNaam: klassering.debiteur
        ? (ownerNaam.get(klassering.debiteur.owner_id) ?? null)
        : null,
      status: lotStatus(unit, rijen),
      heeftHistorie: rijen.length > 0,
      overdracht,
      overdrachtEigenaarNaam: overdracht.allowed
        ? (ownerNaam.get(overdracht.current.owner_id) ?? null)
        : null,
    };
  });

  return {
    alle,
    zichtbaar: sorteer(alle.filter((regel) => hoortErbij(regel, filters)), filters),
    samenvatting: tantiemeOverzicht(units, perUnit, verklaard),
  };
}

/**
 * Voldoet dit lot aan alle actieve filters?
 *
 * De zoekterm loopt nog steeds door `matchesUnitSearch` — ongewijzigd, dus
 * zoeken doet precies wat het vóór deze stap deed. Het type komt van de unit en
 * de status uit `regel.status`, die al door `lotStatus()` is bepaald: hier wordt
 * geen eigendomsregel herhaald, alleen een al berekende uitkomst vergeleken.
 */
function hoortErbij(regel: LotRegel, filters: LotsFilters): boolean {
  if (!matchesUnitSearch(regel.unit, filters.zoekterm)) return false;
  if (filters.type !== null && regel.unit.unit_type !== filters.type) return false;
  if (filters.status !== null && regel.status !== filters.status) return false;
  return true;
}

function sorteer(lijst: readonly LotRegel[], filters: LotsFilters): readonly LotRegel[] {
  if (filters.sort === STANDAARD_SORT) {
    // Queryvolgorde, of exact de inverse daarvan. Geen eigen vergelijking.
    return filters.dir === STANDAARD_DIR ? lijst : [...lijst].reverse();
  }

  // Alleen `tantiemes` blijft over: een getal dat elk lot heeft. De index is de
  // tie-break, zodat gelijke tantièmes de queryvolgorde houden.
  const teken = filters.dir === "desc" ? -1 : 1;
  return lijst
    .map((regel, index) => ({ regel, index }))
    .sort((a, b) => teken * (a.regel.unit.tantiemes - b.regel.unit.tantiemes) || a.index - b.index)
    .map(({ regel }) => regel);
}

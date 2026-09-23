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
 * De lots komen in de volgorde binnen die de query oplegt (`order("label")`) en
 * gaan er in DIEZELFDE volgorde weer uit. Hier wordt niet gesorteerd. Zou deze
 * module zelf sorteren, dan zou de zichtbare volgorde stilzwijgend kunnen
 * afwijken van wat de database teruggaf.
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
  /** De lots die aan de zoekterm voldoen, in dezelfde volgorde. */
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
  /** Al getrimde zoekterm; leeg betekent: alles zichtbaar. */
  zoekterm: string;
  /** Vandaag in ISO, voor het overdrachtsvenster. */
  vandaag: string;
};

export function bouwLotsOverzicht({
  units,
  ownership,
  owners,
  verklaard,
  zoekterm,
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
    // Filteren op de UNIT, precies zoals voorheen; de zoekfunctie kijkt niet
    // naar eigendom. Geen sortering: de queryvolgorde blijft staan.
    zichtbaar: alle.filter((regel) => matchesUnitSearch(regel.unit, zoekterm)),
    samenvatting: tantiemeOverzicht(units, perUnit, verklaard),
  };
}

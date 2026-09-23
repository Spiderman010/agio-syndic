/**
 * Een bron VOLLEDIG lezen, of eerlijk zeggen dat het niet gelukt is.
 *
 * ── HET PROBLEEM ───────────────────────────────────────────────────────────
 *
 * PostgREST kapt elk antwoord af op zijn `max-rows`. Die afkapping is STIL:
 * het verzoek slaagt, `error` is null, en je krijgt een prefix die er precies
 * zo uitziet als een volledige lijst. Voor een scherm dat rijen toont is dat
 * vervelend; voor een checklist is het gevaarlijk, want die doet BEWERINGEN.
 * Twintig van de honderd lots ophalen die toevallig allemaal gekoppeld zijn,
 * levert "alles klaar, 5/5" op terwijl er tachtig lots zonder eigenaar staan.
 *
 * ── WAAROM NIET GEWOON PAGINEREN ───────────────────────────────────────────
 *
 * De voor de hand liggende lus — vraag 500 rijen, stop zodra je er minder dan
 * 500 terugkrijgt — is precies even stil fout. Staat `max-rows` op 100, dan
 * levert de eerste pagina er 100, dus "minder dan gevraagd", dus stoppen we
 * met 100 van de 1200 rijen en noemen dat compleet. Elke variant die de
 * paginagrootte als signaal gebruikt, vertrouwt impliciet op een limiet die
 * dit project niet kent en niet mag aannemen.
 *
 * ── WAT HIER WEL GEBEURT ───────────────────────────────────────────────────
 *
 * Het enige betrouwbare getal komt van de server zelf: `count: "exact"`. Dat
 * telt in de database, los van `max-rows`. De lus schuift op met het aantal
 * WERKELIJK ontvangen rijen (niet met de paginagrootte, anders sla je rijen
 * over zodra de server minder levert dan gevraagd) en stopt pas als er precies
 * `count` rijen liggen.
 *
 * Alles wat daarvan afwijkt is een fout, geen benadering:
 *
 *   - geen `count` terug          → we kunnen volledigheid niet vaststellen
 *   - `count` verandert onderweg  → de tabel schoof tijdens het lezen
 *   - een lege pagina te vroeg    → stilstand; nog een ronde zou oneindig zijn
 *   - meer of minder dan `count`  → geen volledige dataset
 *
 * In al die gevallen komt er `status: "error"` uit en nooit een halve lijst.
 * De aanroeper vertaalt dat naar `null` en de bestaande fail-closed-afhandeling
 * onderdrukt de hele checklist — dezelfde weg als een harde queryfout.
 *
 * ── WAT DE AANROEPER MOET DOEN ─────────────────────────────────────────────
 *
 * De query MOET op een unieke sleutel geordend zijn (`.order("id", …)`) vóór de
 * `.range()`. Zonder ORDER BY laat SQL de rijvolgorde ongespecificeerd, en twee
 * losse `.range()`-verzoeken zijn twee losse queries: de tweede mag rijen
 * herhalen die de eerste al gaf en andere overslaan. Het totaal klopt dan nog
 * steeds met `count` — je hebt evenveel rijen, maar niet dezelfde. Voor deze
 * checklist betekent dat een overgeslagen niet-gekoppeld lot, vervangen door een
 * dubbel gekoppeld lot, en dus alsnog een onterechte 5/5. De telling bewijst
 * volledigheid alleen bij een stabiele ordening.
 *
 * Een gewijzigde `count` tussen twee pagina's is strikt genomen geen
 * afkapping maar gelijktijdige schrijfactie. Ook die telt hier als onbruikbaar:
 * een checklist die half vóór en half ná een import is gelezen, beschrijft geen
 * enkele werkelijke toestand.
 */

/** Rijen per verzoek. De server mag minder leveren; de lus rekent daarop. */
export const PAGINA_GROOTTE = 500;

/**
 * Harde bovengrens op het aantal verzoeken. Niet als verwachting maar als
 * noodrem: zonder deze grens zou een server die blijft leveren zonder `count`
 * te halen, dit verzoek eindeloos laten lopen.
 */
export const MAX_PAGINAS = 200;

export type PaginaAntwoord<T> = {
  data: T[] | null;
  error: { code?: string | null } | null;
  count?: number | null;
};

export type VolledigeLezing<T> =
  | { status: "ok"; rijen: T[] }
  | { status: "error"; reden: "query" | "onvolledig"; code?: string };

/**
 * @param lees  levert één pagina op, inclusief `count`. Beide grenzen zijn
 *              inclusief, net als `.range()` van PostgREST.
 */
export async function leesVolledig<T>(
  lees: (van: number, tot: number) => PromiseLike<PaginaAntwoord<T>>,
  opties?: { paginaGrootte?: number; maxPaginas?: number },
): Promise<VolledigeLezing<T>> {
  const grootte = Math.max(1, opties?.paginaGrootte ?? PAGINA_GROOTTE);
  const maxPaginas = Math.max(1, opties?.maxPaginas ?? MAX_PAGINAS);

  const rijen: T[] = [];
  let totaal: number | null = null;

  for (let ronde = 0; ronde < maxPaginas; ronde++) {
    const antwoord = await lees(rijen.length, rijen.length + grootte - 1);

    if (antwoord.error) {
      return { status: "error", reden: "query", code: antwoord.error.code ?? undefined };
    }
    if (typeof antwoord.count !== "number") {
      // Zonder telling is "compleet" niet vast te stellen, en raden mag niet.
      return { status: "error", reden: "onvolledig" };
    }
    if (totaal === null) totaal = antwoord.count;
    else if (antwoord.count !== totaal) return { status: "error", reden: "onvolledig" };

    const pagina = antwoord.data ?? [];
    rijen.push(...pagina);

    if (rijen.length >= totaal) break;
    // Nog niet compleet én niets nieuws gekregen: doorgaan zou de lus alleen
    // maar rondjes laten draaien op dezelfde offset.
    if (pagina.length === 0) return { status: "error", reden: "onvolledig" };
  }

  if (totaal === null || rijen.length !== totaal) {
    return { status: "error", reden: "onvolledig" };
  }
  return { status: "ok", rijen };
}

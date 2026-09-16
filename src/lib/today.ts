/**
 * De kalenderdatum van vandaag in de tijdzone waarin het gebouw staat.
 *
 * WAAROM DIT GEEN `toISOString().slice(0, 10)` MAG ZIJN
 *
 * `toISOString()` levert de datum in UTC. Marokko loopt op UTC+1, dus tussen
 * 00:00 en 01:00 lokale tijd geeft die slice de dag ERVOOR terug. Die waarde
 * wordt voorgevuld als oproepdatum, en op precies die datum wordt de eigendom
 * beoordeeld (`fn_alloc_resolve_owner`, en `classifyOwnershipOn()` die hem
 * spiegelt). Rond een eigendomsoverdracht is dat geen cosmetisch verschil:
 * een oproep die op 1 oktober om 00:30 wordt aangemaakt zou standaard op
 * 30 september uitkomen en daarmee bij de VORIGE eigenaar belanden.
 *
 * `Intl` met een IANA-zone lost dat op zonder een offset hard te coderen, en
 * volgt ook de tijdelijke terugval naar UTC+0 tijdens de ramadan.
 */

/**
 * De bedrijfstijdzone van de portefeuille.
 *
 * Bewust een constante: `buildings` draagt geen tijdzonekolom, en die
 * toevoegen zou een migratie zijn. Krijgt een gebouw ooit een eigen zone, dan
 * is dit de plek waar die binnenkomt - de aanroepers geven de zone al mee.
 */
export const BUILDING_TIMEZONE = "Africa/Casablanca";

/**
 * `YYYY-MM-DD` zoals de kalender in `timeZone` hem op dat moment aanwijst.
 *
 * `en-CA` is hier geen willekeurige keuze: dat is de enige veelgebruikte
 * locale die standaard ISO-volgorde met streepjes oplevert, zodat het
 * resultaat direct in een `<input type="date">` en in `isoDate` past.
 */
export function todayInTimezone(
  timeZone: string = BUILDING_TIMEZONE,
  now: Date = new Date(),
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

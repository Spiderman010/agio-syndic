import { describe, expect, it } from "vitest";
import { BUILDING_TIMEZONE, defaultCallDate, todayInTimezone } from "@/lib/today";

/**
 * TZ — de voorgevulde oproepdatum.
 *
 * De oproepdatum is geen cosmetisch veld: `fn_alloc_resolve_owner` beoordeelt
 * de eigendom op exact die dag. Een datum die een dag te vroeg is, wijst de
 * lastenoproep rond een overdracht aan de VORIGE eigenaar toe.
 */
describe("TZ — vandaag in de tijdzone van het gebouw", () => {
  const CASA = BUILDING_TIMEZONE;

  it("TZ1 — Marokko loopt op UTC+1, dus een UTC-slice geeft rond middernacht de dag ervoor", () => {
    // 30 september 23:30 UTC is in Casablanca al 1 oktober 00:30.
    const moment = new Date("2026-09-30T23:30:00Z");
    expect(moment.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(todayInTimezone(CASA, moment)).toBe("2026-10-01");
  });

  it("TZ2 — een maandgrens is precies waar een eigendomsoverdracht valt", () => {
    // Loopt de overdracht per 1 oktober, dan zou de UTC-slice de oproep op
    // 30 september zetten en dus bij de vorige eigenaar uitkomen.
    const moment = new Date("2026-09-30T23:00:00Z");
    expect(todayInTimezone(CASA, moment)).toBe("2026-10-01");
    expect(moment.toISOString().slice(0, 10)).not.toBe(todayInTimezone(CASA, moment));
  });

  it("TZ3 — vlak vóór lokaal middernacht is het nog gewoon dezelfde dag", () => {
    const moment = new Date("2026-09-30T22:59:00Z");
    expect(todayInTimezone(CASA, moment)).toBe("2026-09-30");
  });

  it("TZ4 — overdag komen beide op dezelfde datum uit", () => {
    for (const iso of ["2026-06-15T09:00:00Z", "2026-01-02T12:00:00Z", "2026-12-31T10:00:00Z"]) {
      const moment = new Date(iso);
      expect(todayInTimezone(CASA, moment), iso).toBe(moment.toISOString().slice(0, 10));
    }
  });

  it("TZ5 — de uitkomst is altijd YYYY-MM-DD, zoals isoDate eist", () => {
    for (const iso of ["2026-01-01T00:00:00Z", "2026-09-30T23:30:00Z", "2026-03-08T04:00:00Z"]) {
      expect(todayInTimezone(CASA, new Date(iso)), iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // En de server accepteert hem ook echt: patroon EN een parsebare datum.
      expect(Number.isNaN(Date.parse(todayInTimezone(CASA, new Date(iso)))), iso).toBe(false);
    }
  });

  it("TZ6 — de zone is een IANA-naam, geen hardgecodeerde offset", () => {
    // Marokko valt tijdens de ramadan tijdelijk terug op UTC+0. Een vaste
    // "+1" zou dat mis hebben; de IANA-database regelt het.
    expect(CASA).toBe("Africa/Casablanca");
    expect(todayInTimezone(CASA, new Date("2026-06-15T09:00:00Z"))).toBe("2026-06-15");
  });
});


/**
 * SD — de standaard oproepdatum, geklemd binnen het boekjaar.
 *
 * m31 maakt `start_date <= call_date <= end_date` een database-invariant met
 * INCLUSIEVE grenzen. Deze functie spiegelt dat voor de voorgevulde waarde.
 * De Preview toonde precies het gat dat hier wordt gedicht: op een boekjaar
 * 2026-10-01..2026-12-31 stond 2026-09-16 voorgevuld.
 */
describe("SD — standaard oproepdatum binnen het boekjaar", () => {
  const BOEKJAAR = { startDate: "2026-10-01", endDate: "2026-12-31" };
  const CASA = BUILDING_TIMEZONE;
  /** 12:00 UTC is in Casablanca dezelfde kalenderdag, dus geen randgeval. */
  const opDag = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it("SD1 — vandaag VOOR de startdatum geeft de startdatum", () => {
    // Exact het Preview-geval.
    expect(defaultCallDate(BOEKJAAR, CASA, opDag("2026-09-16"))).toBe("2026-10-01");
  });

  it("SD2 — vandaag EXACT op de startdatum geeft die dag", () => {
    // De ondergrens is inclusief; teruggeven van start_date is hier hetzelfde
    // als vandaag teruggeven, en dat moet ook zo zijn.
    expect(defaultCallDate(BOEKJAAR, CASA, opDag("2026-10-01"))).toBe("2026-10-01");
  });

  it("SD3 — vandaag BINNEN het boekjaar geeft vandaag", () => {
    expect(defaultCallDate(BOEKJAAR, CASA, opDag("2026-11-15"))).toBe("2026-11-15");
  });

  it("SD4 — vandaag EXACT op de einddatum geeft die dag", () => {
    expect(defaultCallDate(BOEKJAAR, CASA, opDag("2026-12-31"))).toBe("2026-12-31");
  });

  it("SD5 — vandaag NA de einddatum geeft de einddatum", () => {
    expect(defaultCallDate(BOEKJAAR, CASA, opDag("2027-03-04"))).toBe("2026-12-31");
  });

  it("SD6 — de uitkomst valt ALTIJD binnen het boekjaar", () => {
    // Een jaar lang elke dag: geen enkele mag buiten de periode uitkomen.
    for (let d = 0; d < 365; d++) {
      const moment = new Date(Date.UTC(2026, 0, 1, 12) + d * 86_400_000);
      const uit = defaultCallDate(BOEKJAAR, CASA, moment);
      expect(uit >= BOEKJAAR.startDate && uit <= BOEKJAAR.endDate, uit).toBe(true);
    }
  });

  it("SD7 — Casablanca blijft de bron, ook op de maandgrens", () => {
    // 30 september 23:30 UTC is in Casablanca al 1 oktober: de eerste dag van
    // het boekjaar. Met een UTC-slice zou hier 30 september uitkomen en dus,
    // na klemming, alsnog 1 oktober - maar om de verkeerde reden.
    const moment = new Date("2026-09-30T23:30:00Z");
    expect(todayInTimezone(CASA, moment)).toBe("2026-10-01");
    expect(defaultCallDate(BOEKJAAR, CASA, moment)).toBe("2026-10-01");

    // En binnen een boekjaar dat die dag al omvat, telt het verschil echt.
    const ruim = { startDate: "2026-01-01", endDate: "2026-12-31" };
    expect(defaultCallDate(ruim, CASA, moment)).toBe("2026-10-01");
    expect(moment.toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("SD8 — jaargrens: 31 december 23:30 UTC is in Casablanca al 1 januari", () => {
    const moment = new Date("2026-12-31T23:30:00Z");
    const volgend = { startDate: "2027-01-01", endDate: "2027-12-31" };
    expect(todayInTimezone(CASA, moment)).toBe("2027-01-01");
    expect(defaultCallDate(volgend, CASA, moment)).toBe("2027-01-01");
  });

  it("SD9 — tijdens de ramadan valt Marokko terug op UTC+0", () => {
    // De IANA-database regelt dat; een hardgecodeerde +1 zou hier de dag
    // verkeerd hebben. Ramadan 2026 loopt ruwweg 18 februari - 19 maart.
    const ramadan = new Date("2026-03-01T23:30:00Z");
    const jaar = { startDate: "2026-01-01", endDate: "2026-12-31" };
    expect(todayInTimezone(CASA, ramadan)).toBe("2026-03-01");
    expect(defaultCallDate(jaar, CASA, ramadan)).toBe("2026-03-01");

    // Buiten de ramadan geeft hetzelfde klokmoment wel de volgende dag.
    const zomer = new Date("2026-06-01T23:30:00Z");
    expect(todayInTimezone(CASA, zomer)).toBe("2026-06-02");
  });

  it("SD10 — een boekjaar van een enkele dag levert die dag op", () => {
    const eenDag = { startDate: "2026-05-05", endDate: "2026-05-05" };
    for (const iso of ["2026-01-01", "2026-05-05", "2026-12-31"]) {
      expect(defaultCallDate(eenDag, CASA, opDag(iso)), iso).toBe("2026-05-05");
    }
  });
});

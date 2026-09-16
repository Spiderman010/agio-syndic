import { describe, expect, it } from "vitest";
import { BUILDING_TIMEZONE, todayInTimezone } from "@/lib/today";

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

import { describe, expect, it } from "vitest";
import { leesVolledig, MAX_PAGINAS, PAGINA_GROOTTE } from "@/lib/paginate";

/**
 * De volledigheidslezer.
 *
 * Wat hier bewezen moet worden is precies één ding: de lus zegt alleen "ok"
 * wanneer er net zoveel rijen liggen als de server zelf geteld heeft. Elke
 * andere uitkomst — te weinig, geen telling, een verschoven telling,
 * stilstand — is een fout en nooit een halve lijst.
 *
 * De nepserver hieronder is met opzet vals te spelen: `perVerzoek` bepaalt
 * hoeveel rijen hij WERKELIJK levert, los van wat er gevraagd wordt. Dat is de
 * kern van het probleem — PostgREST kapt af op zijn eigen `max-rows` en zegt er
 * niets over.
 */

type Rij = { id: number };

function server(opties: {
  totaal: number;
  perVerzoek?: number;
  count?: number | null | "wisselend";
  fout?: { code: string };
}) {
  const alles: Rij[] = Array.from({ length: opties.totaal }, (_, i) => ({ id: i }));
  const verzoeken: Array<[number, number]> = [];
  let ronde = 0;

  const lees = async (van: number, tot: number) => {
    verzoeken.push([van, tot]);
    ronde++;
    if (opties.fout) return { data: null, error: opties.fout };
    const gevraagd = tot - van + 1;
    const lever = Math.min(gevraagd, opties.perVerzoek ?? gevraagd);
    const count =
      opties.count === "wisselend"
        ? opties.totaal + ronde
        : opties.count === undefined
          ? opties.totaal
          : opties.count;
    return { data: alles.slice(van, van + lever), error: null, count };
  };

  return { lees, verzoeken };
}

describe("PG — een bron volledig lezen", () => {
  it("PG1 — een lijst die in één pagina past komt er in één verzoek uit", async () => {
    const s = server({ totaal: 3 });
    const res = await leesVolledig<Rij>(s.lees);
    expect(res.status).toBe("ok");
    expect(res.status === "ok" && res.rijen.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(s.verzoeken.length).toBe(1);
  });

  it("PG2 — een lege bron is geldig, niet verdacht", async () => {
    const s = server({ totaal: 0 });
    const res = await leesVolledig<Rij>(s.lees);
    expect(res).toEqual({ status: "ok", rijen: [] });
  });

  it("PG3 — meerdere pagina's worden volledig en in volgorde samengevoegd", async () => {
    const s = server({ totaal: 1250 });
    const res = await leesVolledig<Rij>(s.lees, { paginaGrootte: 500 });
    expect(res.status).toBe("ok");
    expect(res.status === "ok" && res.rijen.length).toBe(1250);
    expect(res.status === "ok" && res.rijen[0].id).toBe(0);
    expect(res.status === "ok" && res.rijen[1249].id).toBe(1249);
  });

  /**
   * PG4 is de reden dat deze lus bestaat. De server levert er 100 terwijl er 500
   * gevraagd worden — precies wat `max-rows` doet. Een lus die opschuift met de
   * PAGINAGROOTTE zou rij 100 tot en met 499 overslaan en toch "ok" zeggen.
   */
  it("PG4 — een server die minder levert dan gevraagd laat geen gat vallen", async () => {
    const s = server({ totaal: 1200, perVerzoek: 100 });
    const res = await leesVolledig<Rij>(s.lees, { paginaGrootte: 500 });
    expect(res.status).toBe("ok");
    const ids = res.status === "ok" ? res.rijen.map((r) => r.id) : [];
    expect(ids.length).toBe(1200);
    expect(ids).toEqual(Array.from({ length: 1200 }, (_, i) => i));
    // En elk verzoek begint waar het vorige ophield, niet een paginagrootte verder.
    expect(s.verzoeken[1][0]).toBe(100);
    expect(s.verzoeken[2][0]).toBe(200);
  });

  it("PG5 — zonder telling van de server is volledigheid niet vast te stellen", async () => {
    const s = server({ totaal: 3, count: null });
    expect(await leesVolledig<Rij>(s.lees)).toEqual({ status: "error", reden: "onvolledig" });
  });

  it("PG6 — een telling die tussen twee pagina's verschuift is onbruikbaar", async () => {
    const s = server({ totaal: 1200, perVerzoek: 500, count: "wisselend" });
    const res = await leesVolledig<Rij>(s.lees, { paginaGrootte: 500 });
    expect(res).toEqual({ status: "error", reden: "onvolledig" });
  });

  it("PG7 — stilstand (telling hoger dan wat er ooit komt) is een fout", async () => {
    // De server zegt zeven, levert er twee, en heeft er daarna geen meer.
    const s = server({ totaal: 2, count: 7 });
    const res = await leesVolledig<Rij>(s.lees);
    expect(res).toEqual({ status: "error", reden: "onvolledig" });
    // Twee verzoeken: de tweede levert niets, en dan stopt het — geen oneindige lus.
    expect(s.verzoeken.length).toBe(2);
  });

  it("PG8 — een queryfout draagt de SQLSTATE mee en is nooit ok", async () => {
    const s = server({ totaal: 5, fout: { code: "42P01" } });
    expect(await leesVolledig<Rij>(s.lees)).toEqual({
      status: "error",
      reden: "query",
      code: "42P01",
    });
  });

  it("PG9 — de noodrem stopt een server die blijft leveren zonder de telling te halen", async () => {
    // Telling onbereikbaar hoog, elke pagina levert één rij: zonder bovengrens
    // zou dit blijven draaien.
    const s = server({ totaal: 10_000, perVerzoek: 1, count: 10_000 });
    const res = await leesVolledig<Rij>(s.lees, { paginaGrootte: 1, maxPaginas: 5 });
    expect(res).toEqual({ status: "error", reden: "onvolledig" });
    expect(s.verzoeken.length).toBe(5);
  });

  it("PG10 — de grenzen zijn inclusief, zoals .range() van PostgREST", async () => {
    const s = server({ totaal: 10 });
    await leesVolledig<Rij>(s.lees, { paginaGrootte: 4 });
    expect(s.verzoeken[0]).toEqual([0, 3]);
    expect(s.verzoeken[1]).toEqual([4, 7]);
    expect(s.verzoeken[2]).toEqual([8, 11]);
  });

  /**
   * PG12 onderscheidt de twee wachters. Hier SCHUIFT de telling naar een waarde
   * die aan het eind precies uitkomt: 1500, dan 1000, en er liggen 1000 rijen.
   * Wie de verschoven telling gewoon overneemt, eindigt met "1000 van 1000" en
   * zegt ok — terwijl die 1000 rijen uit twee verschillende toestanden van de
   * tabel komen en dus geen enkele werkelijke toestand beschrijven.
   */
  it("PG12 — een verschoven telling die toevallig uitkomt is nog steeds onbruikbaar", async () => {
    const alles: Rij[] = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const tellingen = [1500, 1000, 1000];
    let ronde = 0;
    const lees = async (van: number, tot: number) => {
      const count = tellingen[Math.min(ronde, tellingen.length - 1)];
      ronde++;
      return { data: alles.slice(van, tot + 1), error: null, count };
    };

    expect(await leesVolledig<Rij>(lees, { paginaGrootte: 500 })).toEqual({
      status: "error",
      reden: "onvolledig",
    });
  });

  it("PG11 — de standaarden zijn een paginagrootte, geen aangenomen serverlimiet", () => {
    expect(PAGINA_GROOTTE).toBeGreaterThan(0);
    expect(MAX_PAGINAS).toBeGreaterThan(1);
    // Geen enkele waarde in de bron mag 1000 als "de" limiet vastleggen.
    expect(PAGINA_GROOTTE).not.toBe(1000);
  });
});

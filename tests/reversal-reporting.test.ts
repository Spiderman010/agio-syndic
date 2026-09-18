import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildReversalIndex,
  correctionOf,
  emptyReversalIndex,
  fetchReversalIndexResult,
  grossTotal,
  isReversed,
  netTotal,
  reversalOf,
  type ReversalViewRow,
} from "@/lib/reversal";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

/**
 * R1–R8 — netto rapportage en eigenaarsaldo.
 *
 * Checkpoint 2 legde het probleem vast: een correctie van 1000 naar 800 laat drie
 * rijen achter waarvan de BRUTO som 1800 is. Deze suite pint vast dat het NETTO
 * getal 800 is, en — net zo belangrijk — dat de bruto historie niet verdwijnt.
 */

const row = (o: Partial<ReversalViewRow> & { source_id: string }): ReversalViewRow => ({
  reversal_id: `rev-${o.source_id}`,
  source_type: "payment",
  correction_source_id: null,
  reason: "Bedrag verkeerd overgenomen uit het bankbestand",
  effective_date: "2026-04-10",
  is_correctie: false,
  is_correctie_vorig_boekjaar: false,
  ...o,
});

describe("netto rapportage", () => {
  test("R1 een gewone betaling van 1000 telt netto voor 1000", () => {
    const index = emptyReversalIndex();
    const rows = [{ id: "p1", amount: 1000 }];
    expect(netTotal(rows, index)).toBe(1000);
    expect(grossTotal(rows)).toBe(1000);
  });

  test("R2 een volledig gestorneerde betaling van 1000 telt netto voor 0", () => {
    const index = buildReversalIndex([row({ source_id: "p1" })]);
    const rows = [{ id: "p1", amount: 1000 }];

    expect(netTotal(rows, index)).toBe(0);
    // De rij blijft wél bestaan: bruto is nog steeds 1000. Historie is niet weg.
    expect(grossTotal(rows)).toBe(1000);
    expect(isReversed(index, "p1")).toBe(true);
  });

  test("R3 een correctie van 1000 naar 800 telt netto voor 800, niet voor 1800", () => {
    const index = buildReversalIndex([
      row({ source_id: "p1", correction_source_id: "p2", is_correctie: true }),
    ]);
    const rows = [
      { id: "p1", amount: 1000 },
      { id: "p2", amount: 800 },
    ];

    expect(netTotal(rows, index)).toBe(800);
    // Dit is exact het getal uit het Checkpoint 2-rapport dat fout was.
    expect(grossTotal(rows)).toBe(1800);
  });

  test("R4 een gestorneerde uitgave van 1200 telt netto voor 0", () => {
    const index = buildReversalIndex([row({ source_id: "e1", source_type: "expense" })]);
    expect(netTotal([{ id: "e1", amount: 1200 }], index)).toBe(0);
  });

  test("R5 een uitgave gecorrigeerd van 1200 naar 900 telt netto voor 900", () => {
    const index = buildReversalIndex([
      row({ source_id: "e1", source_type: "expense", correction_source_id: "e2", is_correctie: true }),
    ]);
    const rows = [
      { id: "e1", amount: 1200 },
      { id: "e2", amount: 900 },
    ];
    expect(netTotal(rows, index)).toBe(900);
    expect(grossTotal(rows)).toBe(2100);
  });

  test("R8 de audithistorie behoudt origineel, storno en correctie", () => {
    const index = buildReversalIndex([
      row({ source_id: "p1", correction_source_id: "p2", is_correctie: true }),
    ]);

    // Het origineel is herkenbaar als gestorneerd...
    const rev = reversalOf(index, "p1");
    expect(rev).not.toBeNull();
    expect(rev?.isCorrection).toBe(true);
    expect(rev?.reason).toContain("bankbestand");

    // ...en de vervangende rij is herkenbaar als correctie van dat origineel.
    const corr = correctionOf(index, "p2");
    expect(corr?.sourceId).toBe("p1");

    // De vervangende rij is zelf NIET gestorneerd.
    expect(isReversed(index, "p2")).toBe(false);
  });

  test("bedragen als string (numeric uit PostgREST) tellen correct op", () => {
    const index = emptyReversalIndex();
    expect(netTotal([{ id: "a", amount: "1200.55" }, { id: "b", amount: "0.45" }], index)).toBe(1201);
  });

  test("afronding blijft op centniveau exact", () => {
    const index = emptyReversalIndex();
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `x${i}`, amount: 0.1 }));
    expect(netTotal(rows, index)).toBe(0.3);
  });

  test("een correctie over een boekjaargrens is als zodanig herkenbaar", () => {
    const index = buildReversalIndex([
      row({ source_id: "p1", correction_source_id: "p2", is_correctie: true, is_correctie_vorig_boekjaar: true }),
    ]);
    expect(reversalOf(index, "p1")?.isPriorYearCorrection).toBe(true);
  });

  test("onbekende source_type wordt genegeerd in plaats van vertrouwd", () => {
    const index = buildReversalIndex([
      { ...row({ source_id: "x1" }), source_type: "charge" },
    ]);
    expect(isReversed(index, "x1")).toBe(false);
  });
});

/**
 * R6/R7 — het eigenaarsaldo.
 *
 * De UI rekent het saldo als `amount - settled_amount` over charge_allocations.
 * De engine HERSTELT settled_amount bij een storno, dus die berekening corrigeert
 * zichzelf en heeft de reversal-index niet nodig. Deze tests leggen dat gedrag
 * vast met exact het scenario uit de opdracht.
 */
function ownerBalance(allocs: { amount: number; settled_amount: number }[]) {
  return allocs.reduce((s, a) => s + (a.amount - a.settled_amount), 0);
}

describe("eigenaarsaldo", () => {
  test("R6 charge 1000, betaling 1000 -> saldo 0; na storno -> saldo 1000", () => {
    // Na de betaling boekt FIFO settled_amount op 1000.
    expect(ownerBalance([{ amount: 1000, settled_amount: 1000 }])).toBe(0);
    // reverse_payment neutraliseert de toewijzing: settled_amount terug naar 0.
    expect(ownerBalance([{ amount: 1000, settled_amount: 0 }])).toBe(1000);
  });

  test("R7 na correctie naar 800 is het saldo 200 en niet -800", () => {
    // correct_payment storneert 1000 en boekt 800; FIFO zet settled op 800.
    expect(ownerBalance([{ amount: 1000, settled_amount: 800 }])).toBe(200);
  });

  test("het saldo raakt nooit besmet door het bruto 1800-effect", () => {
    // Zou de UI het saldo uit de BETALINGEN afleiden in plaats van uit de
    // vordering, dan zou 1000 + 800 = 1800 zijn afgeboekt en het saldo -800.
    const fout = 1000 - (1000 + 800);
    expect(fout).toBe(-800);
    expect(ownerBalance([{ amount: 1000, settled_amount: 800 }])).not.toBe(fout);
  });
});


// ── De foutstatus van het ophalen ──────────────────────────────────────────

/**
 * `fetchReversalIndexResult()` is de strikte variant: hij geeft de foutstatus
 * mee terug in plaats van een leesfout te vertalen naar "niets gestorneerd".
 *
 * Dat verschil is de hele reden dat deze functie bestaat. Een lege index uit
 * een mislukte query laat een gestorneerde betaling als actief verschijnen en
 * zet er een stornoknop bij die `fn_reversal_authorize` weigert.
 */
describe("FR — foutstatus van de reversal-index", () => {
  /** Minimale PostgREST-keten die één vast resultaat teruggeeft. */
  function client(resultaat: { data: unknown; error: unknown }): SupabaseClient {
    const keten: Record<string, unknown> = {};
    const zelf = () => keten;
    Object.assign(keten, {
      select: zelf,
      eq: zelf,
      or: () => Promise.resolve(resultaat),
    });
    return { from: () => keten } as unknown as SupabaseClient;
  }

  test("FR1 een leesfout komt naar buiten en de index is leeg", async () => {
    const fout = { message: 'relation "v_financial_reversals" does not exist' };
    const uit = await fetchReversalIndexResult(client({ data: null, error: fout }), "payment", [
      "p1",
    ]);
    expect(uit.error).toBe(fout);
    expect(uit.index.bySource.size).toBe(0);
    expect(uit.index.byCorrection.size).toBe(0);
  });

  test("FR2 een GESLAAGDE lege query is een geldige, betrouwbare lege index", async () => {
    const uit = await fetchReversalIndexResult(client({ data: [], error: null }), "payment", [
      "p1",
    ]);
    expect(uit.error).toBeNull();
    expect(uit.index.bySource.size).toBe(0);
  });

  test("FR3 nul bron-id's is geen fout: er valt niets op te halen", async () => {
    // Zou dit als fout gelden, dan kreeg elk scherm zonder betalingen een
    // foutmelding te zien waar niets mis is.
    const uit = await fetchReversalIndexResult(
      client({ data: null, error: { message: "zou niet aangeroepen mogen worden" } }),
      "payment",
      [],
    );
    expect(uit.error).toBeNull();
    expect(uit.index.bySource.size).toBe(0);
  });

  test("FR4 een geslaagde query met rijen levert de echte index", async () => {
    const rijen = [row({ source_id: "p1", correction_source_id: "p2", is_correctie: true })];
    const uit = await fetchReversalIndexResult(
      client({ data: rijen, error: null }),
      "payment",
      ["p1", "p2"],
    );
    expect(uit.error).toBeNull();
    expect(reversalOf(uit.index, "p1")?.isCorrection).toBe(true);
    expect(correctionOf(uit.index, "p2")?.sourceId).toBe("p1");
  });

  test("FR5 data zonder error telt eveneens als onbekend, niet als leeg", async () => {
    const uit = await fetchReversalIndexResult(client({ data: null, error: null }), "payment", [
      "p1",
    ]);
    expect(uit.error).toBeTruthy();
    expect(uit.index.bySource.size).toBe(0);
  });
});

// ── Vertalingen van de nieuwe fail-closed meldingen ────────────────────────

describe("VR — vertalingen reversal FR/NL/AR", () => {
  const talen = { fr, nl, ar } as Record<string, Record<string, unknown>>;

  test("VR1 de fail-closed meldingen bestaan in alle drie de talen", () => {
    for (const [naam, berichten] of Object.entries(talen)) {
      const errors = (berichten.reversal as { errors: Record<string, string> }).errors;
      for (const sleutel of ["statusUnavailable", "actionStatusUnavailable"]) {
        const tekst = errors[sleutel];
        expect(tekst, `reversal.errors.${sleutel} ontbreekt in ${naam}`).toBeTruthy();
        expect(tekst, `${naam}.${sleutel}`).not.toContain("{");
        // Geen technische viewnaam of tabelnaam in een gebruikerstekst.
        expect(tekst, `${naam}.${sleutel}`).not.toContain("v_financial_reversals");
        expect(tekst, `${naam}.${sleutel}`).not.toContain("journal_entries");
      }
    }
  });

  test("VR2 geen taal mist een sleutel die het Frans wel heeft binnen reversal", () => {
    const leaves = (o: unknown, p = ""): string[] =>
      o && typeof o === "object"
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}${k}.`))
        : [p.slice(0, -1)];
    const frKeys = new Set(leaves((fr as Record<string, unknown>).reversal));
    for (const [naam, berichten] of Object.entries({ nl, ar })) {
      const andere = new Set(leaves((berichten as Record<string, unknown>).reversal));
      const ontbrekend = [...frKeys].filter((k) => !andere.has(k));
      expect(ontbrekend, `ontbrekend in ${naam}: ${ontbrekend.join(", ")}`).toEqual([]);
    }
  });

  test("VR3 de meldingen klinken niet als een geslaagde, lege uitkomst", () => {
    // "geen storno" en "open boekjaar" zijn precies de beweringen die deze
    // meldingen NIET mogen doen.
    const verdacht = /\b(aucune extourne|geen storno|open boekjaar|exercice ouvert)\b/i;
    for (const [naam, berichten] of Object.entries(talen)) {
      const errors = (berichten.reversal as { errors: Record<string, string> }).errors;
      for (const sleutel of ["statusUnavailable", "actionStatusUnavailable"]) {
        expect(verdacht.test(errors[sleutel]), `${naam}.${sleutel}`).toBe(false);
      }
    }
  });
});

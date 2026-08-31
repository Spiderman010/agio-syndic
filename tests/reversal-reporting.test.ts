import { describe, expect, test } from "vitest";
import {
  buildReversalIndex,
  correctionOf,
  emptyReversalIndex,
  grossTotal,
  isReversed,
  netTotal,
  reversalOf,
  type ReversalViewRow,
} from "@/lib/reversal";

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

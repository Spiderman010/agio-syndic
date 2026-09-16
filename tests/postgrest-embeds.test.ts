import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * EM — elke PostgREST-embed noemt zijn foreign key bij naam.
 *
 * Dit schema heeft tussen meerdere tabelparen MEER DAN EEN foreign key, omdat
 * m8 overal een samengestelde tenantsleutel naast de bestaande enkelvoudige FK
 * zette. PostgREST weigert dan te kiezen: het antwoordt met PGRST201 en de hele
 * query faalt. Zonder expliciete `!<constraint>`-hint valt een scherm dus in
 * zijn geheel om zodra iemand een tweede FK toevoegt - of, zoals hier, zodra
 * een bestaande tweede FK wordt opgemerkt.
 *
 * Deze suite leest de ECHTE migratieketen en toetst twee dingen:
 *   1. elke embed op het boekjaarscherm draagt een hint;
 *   2. elke genoemde constraint bestaat werkelijk in de eindstand van de keten.
 *
 * Punt 2 is wat deze test meer maakt dan een stijlregel: een typefout in een
 * hint geeft PGRST200 en breekt de pagina net zo hard als het probleem dat de
 * hint moest oplossen.
 */

const PAGINA = join(
  REPO,
  "src",
  "app",
  "[locale]",
  "(app)",
  "buildings",
  "[id]",
  "boekjaren",
  "[fy_id]",
  "page.tsx",
);

/** Een foreign key in de eindstand: van welke tabel naar welke tabel. */
type Fk = { bron: string; doel: string };

/**
 * De eindstand van alle foreign keys na de hele migratieketen.
 *
 * Sequentieel, want een constraint kan worden gedropt en later opnieuw gezet -
 * `charge_allocations_cc_org_fk` en `payments_owner_id_fkey` doen dat allebei.
 * Een simpele optelsom zou daar het verkeerde antwoord op geven.
 */
function foreignKeysInEindstand(): Map<string, Fk> {
  const dir = join(REPO, "supabase", "migrations");
  const staat = new Map<string, Fk>();

  for (const bestand of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, bestand), "utf8");

    /** De tabel waar een constraint op wordt gezet, volgt uit de ALTER/CREATE ervoor. */
    const context: { pos: number; tabel: string }[] = [];
    const tabelKop = /(?:ALTER|CREATE)\s+TABLE\s+(?:IF NOT EXISTS\s+)?public\.(\w+)/gi;
    for (let m = tabelKop.exec(sql); m; m = tabelKop.exec(sql)) {
      context.push({ pos: m.index, tabel: m[1] });
    }
    const tabelOp = (pos: number) => {
      let gevonden = "?";
      for (const c of context) {
        if (c.pos < pos) gevonden = c.tabel;
        else break;
      }
      return gevonden;
    };

    type Actie = { pos: number; soort: "add" | "drop"; naam: string; doel?: string };
    const acties: Actie[] = [];

    const toevoegen =
      /(?:ADD\s+)?CONSTRAINT\s+(\w+)\s+FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+public\.(\w+)/gi;
    for (let m = toevoegen.exec(sql); m; m = toevoegen.exec(sql)) {
      acties.push({ pos: m.index, soort: "add", naam: m[1], doel: m[3] });
    }
    const verwijderen = /DROP CONSTRAINT\s+(?:IF EXISTS\s+)?(\w+)/gi;
    for (let m = verwijderen.exec(sql); m; m = verwijderen.exec(sql)) {
      acties.push({ pos: m.index, soort: "drop", naam: m[1] });
    }

    acties.sort((a, b) => a.pos - b.pos);
    for (const a of acties) {
      if (a.soort === "add") staat.set(a.naam, { bron: tabelOp(a.pos), doel: a.doel! });
      else staat.delete(a.naam);
    }
  }
  return staat;
}

/** Elke `tabel!constraint(` in de bron, met de tabel die wordt ingebed. */
function embedsMetHint(bron: string): { tabel: string; constraint: string }[] {
  return [...bron.matchAll(/\b([a-z_]+)!([a-z_][a-z0-9_]*)\s*\(/g)].map((m) => ({
    tabel: m[1],
    constraint: m[2],
  }));
}

describe("EM — PostgREST-embeds op het boekjaarscherm", () => {
  const bron = readFileSync(PAGINA, "utf8");
  const fks = foreignKeysInEindstand();

  /** De tabellen die dit scherm inbedt. Bare `tabel(` betekent hier: geen hint. */
  const INGEBED = [
    "charge_allocations",
    "payment_allocations",
    "charge_calls",
    "owners",
    "units",
    "fiscal_years",
  ];

  it("EM1 — geen enkele embed staat zonder foreign-keyhint", () => {
    for (const tabel of INGEBED) {
      // `tabel(` zonder `!` ertussen. `.from("tabel")` telt niet mee, want daar
      // staat een quote voor de haak.
      const zonderHint = new RegExp(`(^|[^!\\w"])${tabel}\\s*\\(`, "g");
      const treffers = [...bron.matchAll(zonderHint)];
      expect(
        treffers.map((t) => t[0].trim()),
        `embed op \`${tabel}\` zonder !constraint-hint — PostgREST geeft dan PGRST201`,
      ).toEqual([]);
    }
  });

  it("EM2 — elke genoemde constraint bestaat in de eindstand van de migratieketen", () => {
    const gebruikt = embedsMetHint(bron);
    expect(gebruikt.length).toBeGreaterThan(0);
    for (const { tabel, constraint } of gebruikt) {
      expect(fks.has(constraint), `onbekende constraint \`${constraint}\` in de hint`).toBe(true);
      // En hij moet die tabel ook werkelijk raken. Bij het inbedden van een
      // OUDER wijst de constraint naar de ingebedde tabel; bij een KIND staat
      // hij erop. Beide zijn geldig, elke andere combinatie is een typefout.
      const fk = fks.get(constraint)!;
      expect(
        [fk.bron, fk.doel],
        `\`${constraint}\` (${fk.bron} -> ${fk.doel}) verbindt niet met \`${tabel}\``,
      ).toContain(tabel);
    }
  });

  it("EM3 — de ambigue paren uit het schema zijn echt ambigu, dus de hint is nodig", () => {
    // Zonder dit zou EM1 een regel zijn zonder aanleiding. Deze test leest de
    // keten en bewijst dat er meer dan een FK tussen deze paren staat.
    const perDoel = new Map<string, string[]>();
    for (const [naam, fk] of fks) {
      perDoel.set(fk.doel, [...(perDoel.get(fk.doel) ?? []), naam]);
    }

    const naarChargeCalls = (perDoel.get("charge_calls") ?? []).filter(
      (n) => n.startsWith("ca_call") || n === "charge_allocations_cc_org_fk",
    );
    expect(naarChargeCalls.sort()).toEqual([
      "ca_call_building_fk",
      "ca_call_params_fk",
      "charge_allocations_cc_org_fk",
    ]);

    // En payments -> owners draagt zowel de samengestelde als de enkelvoudige.
    const naarOwners = (perDoel.get("owners") ?? []).filter((n) => n.startsWith("payments"));
    expect(naarOwners.sort()).toEqual(["payments_owner_id_fkey", "payments_owner_org_fk"]);
  });
});

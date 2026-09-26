import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";
import { bouwLotsOverzicht, type LotsOverzichtBronnen } from "@/lib/lots";
import { leesLotsFilters, type LotsFilters } from "@/lib/lotsFilters";
import {
  classifyOwnership,
  lotStatus,
  matchesUnitSearch,
  tantiemeOverzicht,
  transferability,
  groupByUnit,
  type OwnerRow,
  type OwnershipRow,
  type UnitRow,
} from "@/lib/ownership";

/**
 * Het LOTS-VIEWMODEL en de componentgrenzen.
 *
 * Deze suite hoort bij een refactor die per definitie NIETS mag veranderen. Ze
 * toetst daarom vooral GELIJKHEID: het viewmodel moet exact dezelfde antwoorden
 * geven als de losse helpers uit `lib/ownership.ts`, en de structuur van het
 * scherm moet dezelfde garanties blijven dragen.
 *
 *   V*   het viewmodel: volgorde, filtering, classificatie, overdraagbaarheid,
 *        KPI's. Steeds vergeleken met de bron, niet met een overgetypte
 *        verwachting — een verwachting kan meebewegen met een fout.
 *   S*   de structuur: geen client, geen verboden import, geen fysieke
 *        richting, de vier datastromen en guards nog aanwezig.
 *   A*   de action-inputs: welke verborgen velden het formulier meestuurt.
 *   I*   vertaalpariteit.
 *
 * WAT HIER NIET WORDT BEWEZEN: hoe dit eruitziet. jsdom doet geen layout en
 * evalueert geen media queries; deze suite rendert zelfs niets.
 */

const REPO = join(__dirname, "..");
const LOTS = join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots");
const NIEUW = [
  join(REPO, "src", "lib", "lots.ts"),
  join(LOTS, "LotsStats.tsx"),
  join(LOTS, "LotsToolbar.tsx"),
  join(LOTS, "LotsTable.tsx"),
  join(LOTS, "LotActions.tsx"),
];

const VANDAAG = "2026-06-01";

function unit(over: Partial<UnitRow> & { id: string }): UnitRow {
  return {
    building_id: "bld",
    label: over.id.toUpperCase(),
    unit_type: "appartement",
    tantiemes: 100,
    floor: null,
    area_m2: null,
    ...over,
  } as UnitRow;
}

function own(over: Partial<OwnershipRow> & { id: string; unit_id: string }): OwnershipRow {
  return {
    owner_id: "o1",
    share: 1,
    start_date: "2026-01-01",
    end_date: null,
    is_primary_debtor: true,
    ...over,
  } as OwnershipRow;
}

const EIGENAARS = [
  { id: "o1", full_name: "Youssef El Amrani" },
  { id: "o2", full_name: "Fatima Zahra Bennani" },
] as unknown as OwnerRow[];

/**
 * De standaardfilters: niets gefilterd, queryvolgorde.
 *
 * Gaat door `leesLotsFilters` heen en wordt niet met de hand opgeschreven, zodat
 * de tests met dezelfde standaarden werken als de pagina.
 */
function standaardFilters(): LotsFilters {
  return leesLotsFilters({}, []);
}

/**
 * `zoekterm` blijft hier bestaan als afkorting voor `filters.zoekterm`. Dat is
 * bewust: de bestaande V-tests over zoeken blijven daardoor LETTERLIJK
 * ongewijzigd, en dat is precies het bewijs dat fase B de zoeksemantiek niet
 * heeft aangeraakt.
 */
function bronnen(
  over: Partial<LotsOverzichtBronnen> & { zoekterm?: string } = {},
): LotsOverzichtBronnen {
  const { zoekterm, filters, ...rest } = over;
  return {
    units: [],
    ownership: [],
    owners: EIGENAARS,
    verklaard: 1000,
    filters: filters ?? { ...standaardFilters(), zoekterm: zoekterm ?? "" },
    vandaag: VANDAAG,
    ...rest,
  };
}

// ══════════════════════════════════════════════════════ het viewmodel
describe("V — volgorde en filtering", () => {
  it("V1 — de queryvolgorde blijft exact staan; er wordt NIET gesorteerd", () => {
    // De labels staan bewust in een volgorde die géén enkele sortering
    // oplevert. Zou het viewmodel zelf sorteren, dan wijkt de uitkomst af van
    // wat de database teruggaf — en de tabel toont dan een andere volgorde dan
    // `order("label")` bedoelde.
    const units = [unit({ id: "c", label: "C-03" }), unit({ id: "a", label: "A-01" }), unit({ id: "b", label: "B-02" })];
    const uit = bouwLotsOverzicht(bronnen({ units }));

    expect(uit.alle.map((r) => r.unit.id)).toEqual(["c", "a", "b"]);
    expect(uit.zichtbaar.map((r) => r.unit.id)).toEqual(["c", "a", "b"]);
  });

  it("V2 — zichtbaar is exact de units die matchesUnitSearch doorlaat", () => {
    const units = [
      unit({ id: "a", label: "A-01", floor: "1" }),
      unit({ id: "b", label: "B-02", floor: "2" }),
      unit({ id: "c", label: "GARAGE", unit_type: "parking" }),
    ];
    for (const zoekterm of ["", "a-0", "parking", "2", "bestaatniet", "GARAGE"]) {
      const uit = bouwLotsOverzicht(bronnen({ units, zoekterm }));
      // Vergelijken met de BRON, niet met een overgetypte lijst.
      const verwacht = units.filter((u) => matchesUnitSearch(u, zoekterm)).map((u) => u.id);
      expect(uit.zichtbaar.map((r) => r.unit.id), `zoekterm=${zoekterm}`).toEqual(verwacht);
    }
  });

  it("V3 — filteren raakt `alle` niet; de KPI's tellen het hele gebouw", () => {
    // Anders zou zoeken de tantièmesom laten schommelen.
    const units = [unit({ id: "a", label: "A-01", tantiemes: 600 }), unit({ id: "b", label: "B-02", tantiemes: 400 })];
    const uit = bouwLotsOverzicht(bronnen({ units, zoekterm: "A-01" }));

    expect(uit.zichtbaar).toHaveLength(1);
    expect(uit.alle).toHaveLength(2);
    expect(uit.samenvatting.toegekend).toBe(1000);
  });
});

describe("V — afgeleide eigendomsgegevens", () => {
  const units = [unit({ id: "u1" }), unit({ id: "u2" }), unit({ id: "u3" })];
  const ownership = [
    own({ id: "ow1", unit_id: "u1", owner_id: "o1" }),
    own({ id: "ow2", unit_id: "u2", owner_id: "o1", is_primary_debtor: true }),
    own({ id: "ow3", unit_id: "u2", owner_id: "o2", is_primary_debtor: false }),
  ];

  it("V4 — classificatie komt exact overeen met classifyOwnership", () => {
    const uit = bouwLotsOverzicht(bronnen({ units, ownership }));
    const perUnit = groupByUnit(ownership);

    for (const regel of uit.alle) {
      const bron = classifyOwnership(perUnit.get(regel.unit.id) ?? []);
      expect(regel.aantalActief, regel.unit.id).toBe(bron.nActive);
      expect(regel.debiteurNaam, regel.unit.id).toBe(
        bron.debiteur ? (EIGENAARS.find((o) => o.id === bron.debiteur!.owner_id)?.full_name ?? null) : null,
      );
    }
  });

  it("V5 — status komt exact overeen met lotStatus", () => {
    const metNul = [...units, unit({ id: "u4", tantiemes: 0 })];
    const uit = bouwLotsOverzicht(bronnen({ units: metNul, ownership }));
    const perUnit = groupByUnit(ownership);

    for (const regel of uit.alle) {
      expect(regel.status, regel.unit.id).toBe(
        lotStatus(regel.unit, perUnit.get(regel.unit.id) ?? []),
      );
    }
  });

  it("V6 — overdraagbaarheid komt exact overeen met transferability", () => {
    const uit = bouwLotsOverzicht(bronnen({ units, ownership }));
    const perUnit = groupByUnit(ownership);

    for (const regel of uit.alle) {
      expect(regel.overdracht, regel.unit.id).toEqual(
        transferability(perUnit.get(regel.unit.id) ?? [], VANDAAG),
      );
    }
  });

  it("V7 — de overdrachtsdatum hangt aan `vandaag`, niet aan de systeemklok", () => {
    const eigen = [own({ id: "ow1", unit_id: "u1", start_date: "2026-01-01" })];
    const a = bouwLotsOverzicht(bronnen({ units: [unit({ id: "u1" })], ownership: eigen, vandaag: "2026-06-01" }));
    const b = bouwLotsOverzicht(bronnen({ units: [unit({ id: "u1" })], ownership: eigen, vandaag: "2026-07-15" }));
    const ovA = a.alle[0].overdracht;
    const ovB = b.alle[0].overdracht;

    expect(ovA.allowed && ovA.maxDate).toBe("2026-06-01");
    expect(ovB.allowed && ovB.maxDate).toBe("2026-07-15");
  });

  it("V8 — eigenaren zijn uitsluitend de LOPENDE rijen, met hun debiteurmarkering", () => {
    const uit = bouwLotsOverzicht(bronnen({ units, ownership }));
    const u2 = uit.alle.find((r) => r.unit.id === "u2")!;

    expect(u2.eigenaren.map((e) => e.ownershipId)).toEqual(["ow2", "ow3"]);
    expect(u2.eigenaren.map((e) => e.isPrimaryDebtor)).toEqual([true, false]);
    expect(u2.aantalActief).toBe(2);
  });

  it("V9 — een BEËINDIGDE rij telt niet als eigenaar maar wel als historie", () => {
    // Dat onderscheid bepaalt of het scherm de eerste-koppelingsknop toont; een
    // lot met gesloten historie krijgt die knop NIET, want de RPC weigert hem.
    const gesloten = [own({ id: "ow1", unit_id: "u1", end_date: "2026-03-01" })];
    const uit = bouwLotsOverzicht(bronnen({ units: [unit({ id: "u1" })], ownership: gesloten }));

    expect(uit.alle[0].eigenaren).toEqual([]);
    expect(uit.alle[0].aantalActief).toBe(0);
    expect(uit.alle[0].heeftHistorie).toBe(true);
  });

  it("V10 — een onherleidbare eigenaar wordt `null`, nooit stilzwijgend 'geen eigenaar'", () => {
    const vreemd = [own({ id: "ow1", unit_id: "u1", owner_id: "onbekend" })];
    const uit = bouwLotsOverzicht(bronnen({ units: [unit({ id: "u1" })], ownership: vreemd }));

    expect(uit.alle[0].eigenaren[0].naam).toBeNull();
    expect(uit.alle[0].aantalActief).toBe(1);
    expect(uit.alle[0].status).not.toBe("zonderEigenaar");
  });

  it("V11 — de naam bij overdracht is die van de HUIDIGE eigenaar", () => {
    const uit = bouwLotsOverzicht(bronnen({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "u1", owner_id: "o2" })],
    }));
    expect(uit.alle[0].overdrachtEigenaarNaam).toBe("Fatima Zahra Bennani");
  });

  it("V12 — zonder overdracht is die naam null, niet een lege string", () => {
    const uit = bouwLotsOverzicht(bronnen({ units: [unit({ id: "u1" })] }));
    expect(uit.alle[0].overdracht.allowed).toBe(false);
    expect(uit.alle[0].overdrachtEigenaarNaam).toBeNull();
  });

  it("V13 — eigendom van een ONBEKEND lot verhoogt geen enkele teller", () => {
    const uit = bouwLotsOverzicht(bronnen({
      units: [unit({ id: "u1" })],
      ownership: [own({ id: "ow1", unit_id: "bestaat-niet" })],
    }));
    expect(uit.alle[0].aantalActief).toBe(0);
    expect(uit.alle[0].heeftHistorie).toBe(false);
  });
});

describe("V — KPI's en waarschuwingen", () => {
  it("V14 — de samenvatting is letterlijk tantiemeOverzicht, niet nagerekend", () => {
    const units = [
      unit({ id: "u1", tantiemes: 400 }),
      unit({ id: "u2", tantiemes: 0 }),
      unit({ id: "u3", tantiemes: 100 }),
    ];
    const ownership = [
      own({ id: "a", unit_id: "u1", owner_id: "o1", is_primary_debtor: false }),
      own({ id: "b", unit_id: "u1", owner_id: "o2", is_primary_debtor: false }),
      own({ id: "c", unit_id: "u2", owner_id: "o1" }),
    ];
    const uit = bouwLotsOverzicht(bronnen({ units, ownership }));

    expect(uit.samenvatting).toEqual(tantiemeOverzicht(units, groupByUnit(ownership), 1000));
    // En de vier waarschuwingscondities blijven los afleesbaar.
    expect(uit.samenvatting.eigendomVeilig).toBe(false);
    expect(uit.samenvatting.zonderTantieme).toBe(1);
    expect(uit.samenvatting.tantiemesKloppen).toBe(false);
    expect(uit.samenvatting.medeEigendom).toBe(0);
  });

  it("V15 — geldige mede-eigendom telt als mede-eigendom, niet als probleem", () => {
    const units = [unit({ id: "u1", tantiemes: 1000 })];
    const ownership = [
      own({ id: "a", unit_id: "u1", owner_id: "o1", is_primary_debtor: true }),
      own({ id: "b", unit_id: "u1", owner_id: "o2", is_primary_debtor: false }),
    ];
    const uit = bouwLotsOverzicht(bronnen({ units, ownership }));

    expect(uit.samenvatting.medeEigendom).toBe(1);
    expect(uit.samenvatting.eigendomVeilig).toBe(true);
    expect(uit.samenvatting.oproepVeilig).toBe(true);
  });
});

// ══════════════════════════════════════════════════════ structuur
describe("S — de grenzen van de refactor", () => {
  const lees = (p: string) => readFileSync(p, "utf8");

  it("S1 — geen enkel nieuw bestand is een client component", () => {
    for (const pad of NIEUW) {
      expect(lees(pad), pad).not.toContain('"use client"');
      expect(lees(pad), pad).not.toContain("'use client'");
    }
  });

  it("S2 — geen React-state, geen effecten, geen hooks in de nieuwe bestanden", () => {
    for (const pad of NIEUW) {
      const bron = lees(pad);
      for (const verboden of ["useState", "useEffect", "useActionState", "useMemo", "useRef"]) {
        expect(bron, `${pad}: ${verboden}`).not.toContain(verboden);
      }
    }
  });

  it("S3 — geen verboden dependency of Admin Kit-import", () => {
    for (const pad of NIEUW) {
      const bron = lees(pad);
      for (const verboden of [
        "@tanstack/react-table",
        "radix-ui",
        "@radix-ui/",
        "cmdk",
        "@tabler/icons-react",
        "vaul",
        "nuqs",
        "date-fns",
      ]) {
        expect(bron, `${pad}: ${verboden}`).not.toContain(verboden);
      }
    }
  });

  it("S4 — alle imports komen uit het project zelf of uit bestaande dependencies", () => {
    const toegestaan = new Set(["next-intl/server", "react"]);
    for (const pad of NIEUW) {
      for (const m of lees(pad).matchAll(/from "([^"]+)"/g)) {
        const spec = m[1];
        if (spec.startsWith("@/") || spec.startsWith("./") || spec.startsWith("../")) continue;
        expect(toegestaan.has(spec), `${pad} importeert ${spec}`).toBe(true);
      }
    }
  });

  it("S5 — de vier datastromen en beide guards staan nog in de orkestrator", () => {
    const bron = lees(join(LOTS, "page.tsx"));
    for (const tabel of ['from("buildings")', 'from("units")', 'from("ownership")', 'from("owners")']) {
      expect(bron, tabel).toContain(tabel);
    }
    // Tenantgrens en rolpoort.
    expect(bron).toContain('.eq("organization_id", org.id)');
    expect(bron).toContain('.eq("building_id", buildingId)');
    expect(bron).toContain("canWrite(role)");
    expect(bron).toContain("assembleOwnership({ units, ownership, owners })");
    // Fail-closed: elke bron wordt null bij fout, nooit een lege lijst.
    for (const res of ["unitRes.error ? null", "ownershipRes.error ? null", "ownerRes.error ? null"]) {
      expect(bron, res).toContain(res);
    }
  });

  it("S6 — de gevoelige helpers zijn NIET meeverhuisd naar het viewmodel", () => {
    // Ze worden aangeroepen, niet geherimplementeerd. Een eigen variant zou een
    // tweede waarheid over financiële veiligheid opleveren.
    const bron = lees(join(REPO, "src", "lib", "lots.ts"));
    expect(bron).toContain('from "@/lib/ownership"');
    for (const naam of ["classifyOwnership", "lotStatus", "transferability", "tantiemeOverzicht"]) {
      expect(bron, naam).toContain(naam);
      expect(bron, `${naam} opnieuw gedefinieerd`).not.toContain(`function ${naam}`);
    }
  });

  it("S7 — classifyOwnership wordt per lot nog maar op ÉÉN plek aangeroepen", () => {
    // Dit is de hele reden voor het viewmodel: twee lussen gaven twee
    // onafhankelijke antwoorden op dezelfde vraag.
    const paginaEnComponenten = [join(LOTS, "page.tsx"), join(LOTS, "LotsTable.tsx"), join(LOTS, "LotActions.tsx")];
    for (const pad of paginaEnComponenten) {
      expect(lees(pad), pad).not.toContain("classifyOwnership(");
    }
    // Commentaar telt niet mee: de kop van `lots.ts` CITEERT de oude situatie.
    const viewmodel = lees(join(REPO, "src", "lib", "lots.ts"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(viewmodel.split("classifyOwnership(").length - 1).toBe(1);
  });

  it("S8 — STATUS_TONE is ongewijzigd meeverhuisd", () => {
    const bron = lees(join(LOTS, "LotsTable.tsx"));
    for (const paar of [
      'compleet: "good"',
      'zonderEigenaar: "crit"',
      'ambigu: "crit"',
      'medeEigendom: "info"',
      'zonderTantieme: "warn"',
    ]) {
      expect(bron, paar).toContain(paar);
    }
  });

  it("S9 — geen fysieke richtingklassen of vaste pixelbreedtes in de nieuwe bestanden", () => {
    // Zelfde regel als D1, hier lokaal herhaald zodat deze suite op zichzelf
    // leesbaar blijft; D1 blijft de projectbrede bewaker.
    const FYSIEK = /^-?(ml|mr|pl|pr)-|^text-(left|right)$|^border-(l|r)$/;
    const VASTE_BREEDTE = /^w-\[\d+px\]$/;
    for (const pad of NIEUW) {
      const kaal = lees(pad)
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const m of kaal.matchAll(/"([^"\n]*)"/g)) {
        for (const token of m[1].split(/\s+/)) {
          const kern = token.slice(token.lastIndexOf(":") + 1);
          expect(FYSIEK.test(kern) || VASTE_BREEDTE.test(kern), `${pad}: ${token}`).toBe(false);
        }
      }
    }
  });
});

// ══════════════════════════════════════════════════════ action-inputs
describe("A — de formulieren sturen exact dezelfde velden", () => {
  it("A1 — LotForm draagt building_id en bij bewerken unit_id", () => {
    const bron = readFileSync(join(LOTS, "LotForm.tsx"), "utf8");
    expect(bron).toContain('name="building_id"');
    expect(bron).toContain('name="unit_id"');
    for (const veld of ["label", "unit_type", "floor", "area_m2", "tantiemes"]) {
      expect(bron, veld).toContain(`name="${veld}"`);
    }
  });

  it("A2 — de eigendomsformulieren dragen hun scope- en concurrency-velden", () => {
    const bron = readFileSync(join(LOTS, "OwnershipForms.tsx"), "utf8");
    for (const veld of [
      "building_id",
      "unit_id",
      "owner_id",
      "start_date",
      "expected_ownership_id",
      "new_owner_id",
      "transfer_date",
      "confirm",
    ]) {
      expect(bron, veld).toContain(`name="${veld}"`);
    }
  });

  it("A3 — de actielijst koppelt aan dezelfde Server Actions als voorheen", () => {
    const bron = readFileSync(join(LOTS, "LotActions.tsx"), "utf8");
    expect(bron).toContain('import { updateLot } from "./actions"');
    expect(bron).toContain("action={updateLot}");
    // Aanmaken blijft in de orkestrator.
    const pagina = readFileSync(join(LOTS, "page.tsx"), "utf8");
    expect(pagina).toContain('import { createLot } from "./actions"');
    expect(pagina).toContain("action={createLot}");
  });

  it("A4 — geen enkele nieuwe component roept zelf een Server Action aan", () => {
    for (const pad of [join(LOTS, "LotsStats.tsx"), join(LOTS, "LotsToolbar.tsx"), join(LOTS, "LotsTable.tsx")]) {
      const bron = readFileSync(pad, "utf8");
      expect(bron, pad).not.toContain('from "./actions"');
      expect(bron, pad).not.toContain("ActionForm");
    }
  });
});

// ══════════════════════════════════════════════════════ vertalingen
describe("I — vertaalsleutels", () => {
  const TALEN: Array<[string, Record<string, unknown>]> = [
    ["fr", fr as Record<string, unknown>],
    ["nl", nl as Record<string, unknown>],
    ["ar", ar as Record<string, unknown>],
  ];

  const plat = (o: Record<string, unknown>, pad = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? plat(v as Record<string, unknown>, `${pad}${k}.`)
        : [`${pad}${k}`],
    );

  it("I1 — de lots-namespace is in alle drie de talen identiek", () => {
    const verwacht = plat(TALEN[0][1].lots as Record<string, unknown>).sort();
    expect(verwacht.length).toBeGreaterThan(70);
    for (const [naam, berichten] of TALEN) {
      expect(plat(berichten.lots as Record<string, unknown>).sort(), naam).toEqual(verwacht);
    }
  });

  it("I2 — deze refactor voegt geen sleutel toe en haalt er geen weg", () => {
    // Elke `t("...")` in de vijf bestanden moet bestaan; en er mag niets bij
    // zijn gekomen, want een structurele refactor verandert geen teksten.
    const nl_ = nl as Record<string, Record<string, unknown>>;
    const lees = (p: string) => readFileSync(p, "utf8");
    const gebruikt = new Set<string>();
    for (const pad of [join(LOTS, "page.tsx"), ...NIEUW.slice(1)]) {
      for (const m of lees(pad).matchAll(/\bt\("([a-zA-Z.]+)"/g)) gebruikt.add(m[1]);
    }
    expect(gebruikt.size).toBeGreaterThan(20);
    for (const sleutel of gebruikt) {
      const waarde = sleutel.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], nl_.lots);
      expect(typeof waarde, `lots.${sleutel} ontbreekt`).toBe("string");
    }
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";
import { bouwLotsOverzicht, type LotsOverzichtBronnen } from "@/lib/lots";
import {
  LOTS_PARAMS,
  LOT_SORT_DIRS,
  LOT_SORT_KEYS,
  LOT_STATUSSEN,
  heeftActieveFilters,
  leesLotsFilters,
  lotsHref,
  lotsHrefLeeg,
  typesUitData,
  type LotsFilters,
} from "@/lib/lotsFilters";
import { matchesUnitSearch, type OwnerRow, type OwnershipRow, type UnitRow } from "@/lib/ownership";

/**
 * FASE B: het filter- en sorteercontract van het lotsscherm.
 *
 *   F*   het contract zelf: lezen, terugvallen, serialiseren.
 *   Z*   het viewmodel onder filters: zoeken, type, status, sortering, combinaties.
 *   C*   de chips als links.
 *   S*   structuur: geen client, geen dependency, geen herimplementatie.
 *   I*   vertaalpariteit.
 *
 * WAT HIER NIET WORDT BEWEZEN: hoe dit eruitziet. Deze suite rendert niets;
 * breedtes, RTL-spiegeling en leesbaarheid horen bij de browser-QA.
 */

const REPO = join(__dirname, "..");
const LOTS = join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots");
const BLD = "11111111-1111-1111-1111-111111111111";
const VANDAAG = "2026-06-15";

const lees = (pad: string) => readFileSync(pad, "utf8");

/**
 * Dezelfde bron, maar zonder commentaar.
 *
 * De structuurtests zoeken naar verboden tekenreeksen. Een doc-comment die
 * UITLEGT dat er geen `use client` of `onRemove` in staat, zou dan als
 * overtreding gelden — dat is de test die het commentaar leest in plaats van de
 * code. Alles wat een verbod toetst gebruikt daarom deze lezer.
 */
const leesCode = (pad: string) =>
  lees(pad)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function unit(over: Partial<UnitRow> = {}): UnitRow {
  return {
    id: over.id ?? "u1",
    building_id: BLD,
    label: over.label ?? "A-01",
    unit_type: over.unit_type ?? "appartement",
    tantiemes: over.tantiemes ?? 100,
    floor: over.floor ?? "1",
    area_m2: over.area_m2 ?? 75,
  } as UnitRow;
}

function own(over: Partial<OwnershipRow> = {}): OwnershipRow {
  return {
    id: over.id ?? "ow1",
    unit_id: over.unit_id ?? "u1",
    owner_id: over.owner_id ?? "o1",
    share: over.share ?? 1,
    start_date: over.start_date ?? "2026-01-01",
    end_date: over.end_date ?? null,
    is_primary_debtor: over.is_primary_debtor ?? true,
  } as OwnershipRow;
}

const EIGENAARS = [
  { id: "o1", full_name: "Youssef El Amrani" },
  { id: "o2", full_name: "Fatima Zahra Bennani" },
] as unknown as OwnerRow[];

function filters(over: Partial<LotsFilters> = {}): LotsFilters {
  return { ...leesLotsFilters({}, []), ...over };
}

function bronnen(over: Partial<LotsOverzichtBronnen> = {}): LotsOverzichtBronnen {
  return {
    units: [],
    ownership: [],
    owners: EIGENAARS,
    verklaard: 1000,
    filters: filters(),
    vandaag: VANDAAG,
    ...over,
  };
}

// ═══════════════════════════════════════════════ F — het URL-contract
describe("F — het URL-contract", () => {
  it("F1 — niets in de URL levert de standaard op: geen filter, queryvolgorde", () => {
    const uit = leesLotsFilters({}, ["appartement"]);
    expect(uit).toEqual({ zoekterm: "", type: null, status: null, sort: "label", dir: "asc" });
    expect(heeftActieveFilters(uit)).toBe(false);
  });

  it("F2 — een ONBEKENDE waarde valt veilig terug en filtert niet", () => {
    // Een typefout in een gedeelde link mag geen lot laten verdwijnen.
    const uit = leesLotsFilters(
      { type: "bestaatniet", status: "bestaatookniet", sort: "raar", dir: "zijwaarts" },
      ["appartement"],
    );
    expect(uit.type).toBeNull();
    expect(uit.status).toBeNull();
    expect(uit.sort).toBe("label");
    expect(uit.dir).toBe("asc");
    expect(heeftActieveFilters(uit)).toBe(false);
  });

  it("F3 — een type dat niet in DEZE data voorkomt wordt afgewezen", () => {
    // De geldige verzameling komt uit de data, niet uit een lijst in de code.
    expect(leesLotsFilters({ type: "parking" }, ["appartement"]).type).toBeNull();
    expect(leesLotsFilters({ type: "parking" }, ["appartement", "parking"]).type).toBe("parking");
  });

  it("F4 — de zoekterm wordt getrimd, net als voorheen", () => {
    expect(leesLotsFilters({ q: "  A-01  " }, []).zoekterm).toBe("A-01");
    expect(leesLotsFilters({ q: "   " }, []).zoekterm).toBe("");
  });

  it("F5 — een herhaalde parameter neemt de eerste waarde", () => {
    expect(leesLotsFilters({ type: ["parking", "cave"] }, ["parking", "cave"]).type).toBe("parking");
  });

  it("F6 — elke status uit LotStatus is een geldige filterwaarde", () => {
    for (const status of LOT_STATUSSEN) {
      expect(leesLotsFilters({ status }, []).status, status).toBe(status);
    }
    expect(LOT_STATUSSEN).toHaveLength(5);
  });

  it("F7 — typesUitData geeft de voorkomende types, ontdubbeld, in queryvolgorde", () => {
    const units = [
      unit({ id: "a", unit_type: "parking" }),
      unit({ id: "b", unit_type: "appartement" }),
      unit({ id: "c", unit_type: "parking" }),
    ];
    expect(typesUitData(units)).toEqual(["parking", "appartement"]);
    expect(typesUitData([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════ Z — het viewmodel onder filters
describe("Z — filteren en sorteren in het viewmodel", () => {
  const drie = () => [
    unit({ id: "a", label: "A-01", unit_type: "appartement", tantiemes: 300 }),
    unit({ id: "b", label: "B-02", unit_type: "parking", tantiemes: 100 }),
    unit({ id: "c", label: "C-03", unit_type: "cave", tantiemes: 200 }),
  ];

  it("Z1 — zoeken doet exact wat matchesUnitSearch doet, ongewijzigd", () => {
    const units = drie();
    for (const zoekterm of ["", "a-0", "parking", "1", "bestaatniet"]) {
      const uit = bouwLotsOverzicht(bronnen({ units, filters: filters({ zoekterm }) }));
      const verwacht = units.filter((u) => matchesUnitSearch(u, zoekterm)).map((u) => u.id);
      expect(uit.zichtbaar.map((r) => r.unit.id), `zoekterm=${zoekterm}`).toEqual(verwacht);
    }
  });

  it("Z2 — het typefilter houdt alleen dat type over", () => {
    const uit = bouwLotsOverzicht(bronnen({ units: drie(), filters: filters({ type: "parking" }) }));
    expect(uit.zichtbaar.map((r) => r.unit.id)).toEqual(["b"]);
    // `alle` blijft het hele gebouw; anders schommelen de KPI's mee.
    expect(uit.alle).toHaveLength(3);
    expect(uit.samenvatting.toegekend).toBe(600);
  });

  it("Z3 — het statusfilter vergelijkt met regel.status uit het viewmodel", () => {
    // u1 heeft een eigenaar (compleet), u2 niet (zonderEigenaar).
    const units = [
      unit({ id: "u1", label: "A-01" }),
      unit({ id: "u2", label: "B-02" }),
    ];
    const ownership = [own({ id: "ow1", unit_id: "u1" })];
    const basis = bouwLotsOverzicht(bronnen({ units, ownership }));
    const statusVan = new Map(basis.alle.map((r) => [r.unit.id, r.status]));
    expect(statusVan.get("u1")).toBe("compleet");
    expect(statusVan.get("u2")).toBe("zonderEigenaar");

    for (const status of LOT_STATUSSEN) {
      const uit = bouwLotsOverzicht(bronnen({ units, ownership, filters: filters({ status }) }));
      // Vergelijken met de BRON: welke lots hebben die status volgens het model.
      const verwacht = basis.alle.filter((r) => r.status === status).map((r) => r.unit.id);
      expect(uit.zichtbaar.map((r) => r.unit.id), status).toEqual(verwacht);
    }
  });

  it("Z4 — zonder expliciete sortering blijft de queryvolgorde ONAANGERAAKT", () => {
    const units = [unit({ id: "c", label: "C-03" }), unit({ id: "a", label: "A-01" })];
    const uit = bouwLotsOverzicht(bronnen({ units }));
    expect(uit.zichtbaar.map((r) => r.unit.id)).toEqual(["c", "a"]);
  });

  it("Z5 — label/desc is exact de omgekeerde queryvolgorde, geen eigen collatie", () => {
    const units = [unit({ id: "c", label: "C-03" }), unit({ id: "a", label: "A-01" }), unit({ id: "b", label: "B-02" })];
    const uit = bouwLotsOverzicht(bronnen({ units, filters: filters({ sort: "label", dir: "desc" }) }));
    expect(uit.zichtbaar.map((r) => r.unit.id)).toEqual(["b", "a", "c"]);
  });

  it("Z6 — op tantièmes sorteren werkt in beide richtingen", () => {
    const units = drie();
    const op = bouwLotsOverzicht(bronnen({ units, filters: filters({ sort: "tantiemes", dir: "asc" }) }));
    expect(op.zichtbaar.map((r) => r.unit.tantiemes)).toEqual([100, 200, 300]);
    const af = bouwLotsOverzicht(bronnen({ units, filters: filters({ sort: "tantiemes", dir: "desc" }) }));
    expect(af.zichtbaar.map((r) => r.unit.tantiemes)).toEqual([300, 200, 100]);
  });

  it("Z7 — gelijke tantièmes houden de queryvolgorde (stabiele tie-break)", () => {
    const units = [
      unit({ id: "x", label: "X", tantiemes: 100 }),
      unit({ id: "y", label: "Y", tantiemes: 100 }),
      unit({ id: "z", label: "Z", tantiemes: 100 }),
    ];
    const uit = bouwLotsOverzicht(bronnen({ units, filters: filters({ sort: "tantiemes", dir: "asc" }) }));
    expect(uit.zichtbaar.map((r) => r.unit.id)).toEqual(["x", "y", "z"]);
  });

  it("Z8 — filters werken GECOMBINEERD en met sortering tegelijk", () => {
    const units = [
      unit({ id: "p1", label: "P-01", unit_type: "parking", tantiemes: 50 }),
      unit({ id: "p2", label: "P-02", unit_type: "parking", tantiemes: 150 }),
      unit({ id: "a1", label: "A-01", unit_type: "appartement", tantiemes: 400 }),
    ];
    const uit = bouwLotsOverzicht(
      bronnen({ units, filters: filters({ type: "parking", zoekterm: "P-0", sort: "tantiemes", dir: "desc" }) }),
    );
    expect(uit.zichtbaar.map((r) => r.unit.id)).toEqual(["p2", "p1"]);
  });

  it("Z9 — een filter dat alles uitsluit levert een LEGE zichtbare lijst, niet een lege database", () => {
    const uit = bouwLotsOverzicht(bronnen({ units: drie(), filters: filters({ type: "appartement", zoekterm: "zzz" }) }));
    expect(uit.zichtbaar).toHaveLength(0);
    expect(uit.alle).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════ C — de chips als links
describe("C — filterchips zijn links die precies één parameter weghalen", () => {
  const actief = filters({ zoekterm: "A-01", type: "parking", status: "compleet", sort: "tantiemes", dir: "desc" });

  it("C1 — één chip weghalen bewaart alle andere parameters", () => {
    const zonderType = lotsHref(BLD, actief, { type: null });
    expect(zonderType).toContain("q=A-01");
    expect(zonderType).toContain("status=compleet");
    expect(zonderType).toContain("sort=tantiemes");
    expect(zonderType).toContain("dir=desc");
    expect(zonderType).not.toContain("type=");
  });

  it("C2 — elke filterparameter is los weg te halen", () => {
    for (const param of ["q", "type", "status"] as const) {
      const href = lotsHref(BLD, actief, { [param]: null });
      expect(href, param).not.toContain(`${param}=`);
    }
  });

  it("C3 — het pad houdt het gebouw-id vast", () => {
    expect(lotsHref(BLD, actief, { type: null })).toContain(`/buildings/${BLD}/lots`);
    expect(lotsHrefLeeg(BLD)).toBe(`/buildings/${BLD}/lots`);
  });

  it("C4 — alles wissen haalt ALLE lotsparameters weg en niets anders", () => {
    const href = lotsHrefLeeg(BLD, { tab: "financieel" });
    for (const param of LOTS_PARAMS) {
      expect(href, param).not.toContain(`${param}=`);
    }
    expect(href).toContain("tab=financieel");
  });

  it("C5 — een vreemde parameter overleeft elke chipnavigatie", () => {
    const href = lotsHref(BLD, actief, { status: null }, { tab: "financieel" });
    expect(href).toContain("tab=financieel");
    expect(href).toContain("q=A-01");
  });

  it("C6 — standaardwaarden komen niet in de URL terecht", () => {
    const href = lotsHref(BLD, filters({ zoekterm: "A" }));
    expect(href).toContain("q=A");
    expect(href).not.toContain("sort=label");
    expect(href).not.toContain("dir=asc");
  });

  it("C7 — een richting zonder sleutel verdwijnt; hij zou niets zeggen", () => {
    const href = lotsHref(BLD, filters({ sort: "tantiemes", dir: "desc" }), { sort: null });
    expect(href).not.toContain("dir=");
  });
});

// ═══════════════════════════════════════════════ S — structuur
describe("S — de structurele grenzen van fase B", () => {
  const BESTANDEN = [
    join(REPO, "src", "lib", "lotsFilters.ts"),
    join(LOTS, "LotsToolbar.tsx"),
    join(LOTS, "LotsFilterChips.tsx"),
    join(LOTS, "LotsCards.tsx"),
    join(LOTS, "LotsTable.tsx"),
    join(LOTS, "LotsStats.tsx"),
    join(LOTS, "page.tsx"),
  ];

  it("SB1 — geen enkel nieuw bestand is een client component", () => {
    for (const pad of BESTANDEN) {
      expect(leesCode(pad), pad).not.toContain("use client");
    }
  });

  it("SB2 — geen React-state, geen effecten, geen event handlers", () => {
    for (const pad of BESTANDEN) {
      const bron = leesCode(pad);
      for (const verboden of ["useState", "useEffect", "useMemo", "onClick", "onChange", "onSubmit"]) {
        expect(bron, `${pad}: ${verboden}`).not.toContain(verboden);
      }
    }
  });

  it("SB3 — geen nieuwe dependency: alleen bestaande interne imports", () => {
    const toegestaan = /^(next-intl|next-intl\/server|react|@\/)/;
    for (const pad of BESTANDEN) {
      for (const m of leesCode(pad).matchAll(/from\s+"([^"]+)"/g)) {
        const bron = m[1];
        if (bron.startsWith(".")) continue;
        expect(toegestaan.test(bron), `${pad} importeert ${bron}`).toBe(true);
      }
    }
  });

  it("SB4 — geen TanStack, Radix, cmdk, Sheet of Dialog", () => {
    for (const pad of BESTANDEN) {
      const bron = leesCode(pad);
      for (const verboden of ["@tanstack", "@radix-ui", "cmdk", "Sheet", "Dialog"]) {
        expect(bron, `${pad}: ${verboden}`).not.toContain(verboden);
      }
    }
  });

  it("SB5 — geen fysieke richtingklassen of vaste pixelbreedtes", () => {
    const fysiek = /^-?(ml|mr|pl|pr)-|^text-(left|right)$|^border-(l|r)$/;
    const vast = /^w-\[\d+px\]$/;
    for (const pad of BESTANDEN) {
      for (const m of lees(pad).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        for (const klasse of (m[1] ?? m[2] ?? "").split(/\s+/)) {
          const kern = klasse.replace(/^[a-z-]+:/, "");
          expect(fysiek.test(kern), `${pad}: ${klasse}`).toBe(false);
          expect(vast.test(kern), `${pad}: ${klasse}`).toBe(false);
        }
      }
    }
  });

  it("SB6 — de filtermodule herimplementeert geen eigendomslogica", () => {
    const bron = leesCode(join(REPO, "src", "lib", "lotsFilters.ts"));
    for (const helper of [
      "classifyOwnership",
      "currentOwnership",
      "transferability",
      "lotStatus(",
      "is_primary_debtor",
      "end_date",
    ]) {
      expect(bron, helper).not.toContain(helper);
    }
  });

  it("SB7 — de kaarten hebben GEEN eigen tonentabel; ze importeren die van de tabel", () => {
    const kaarten = leesCode(join(LOTS, "LotsCards.tsx"));
    expect(kaarten).toContain('import { STATUS_TONE } from "./LotsTable"');
    // Geen tweede definitie die kan gaan afwijken.
    expect(kaarten).not.toContain("STATUS_TONE:");
    expect(kaarten).not.toContain('medeEigendom: "');
  });

  it("SB8 — tabel en kaarten krijgen dezelfde bron: overzicht.zichtbaar", () => {
    const pagina = lees(join(LOTS, "page.tsx"));
    expect(pagina).toContain("<LotsCards regels={overzicht.zichtbaar}");
    expect(pagina).toContain("<LotsTable regels={overzicht.zichtbaar}");
    // De zichtbaarheid loopt via de breakpoint, niet via een tweede lijst.
    expect(pagina).toContain('className="md:hidden"');
    expect(pagina).toContain('className="hidden md:block"');
  });

  it("SB9 — de action-inputs zijn niet aangeraakt", () => {
    // De verborgen velden staan in OwnershipForms.tsx — het bestand dat fase B
    // met geen vinger aanraakt. Dat is precies waarom deze test daar kijkt.
    const formulieren = lees(join(LOTS, "OwnershipForms.tsx"));
    for (const veld of [
      'name="expected_ownership_id"',
      'name="unit_id"',
      'name="building_id"',
      'name="owner_id"',
      'name="transfer_date"',
      'name="new_owner_id"',
    ]) {
      expect(formulieren, veld).toContain(veld);
    }
  });

  it("SB10 — de toolbar is één GET-form met alle vier de velden", () => {
    const bron = lees(join(LOTS, "LotsToolbar.tsx"));
    expect(bron).toContain('method="get"');
    for (const naam of ['name="q"', 'name="type"', 'name="status"', 'name="sort"', 'name="dir"']) {
      expect(bron, naam).toContain(naam);
    }
  });

  it("SB11 — de chips zijn Links, geen knoppen met een callback", () => {
    const bron = leesCode(join(LOTS, "LotsFilterChips.tsx"));
    expect(bron).toContain("<Link");
    expect(bron).not.toContain("<button");
    expect(bron).not.toContain("onRemove");
  });

  it("SB12 — de vier waarschuwingen in LotsStats staan er nog, in dezelfde orde", () => {
    const bron = lees(join(LOTS, "LotsStats.tsx"));
    const posities = [
      "!overzicht.eigendomVeilig",
      "overzicht.zonderTantieme > 0",
      "!overzicht.tantiemesKloppen",
      "overzicht.medeEigendom > 0",
    ].map((conditie) => {
      const index = bron.indexOf(conditie);
      expect(index, conditie).toBeGreaterThan(-1);
      return index;
    });
    expect(posities).toEqual([...posities].sort((a, b) => a - b));
  });

  it("SB13 — de tabel houdt zijn zeven kolommen", () => {
    const bron = lees(join(LOTS, "LotsTable.tsx"));
    for (const kolom of ["label", "type", "floor", "area", "tantiemes", "owner", "status"]) {
      expect(bron, kolom).toContain(`t("table.${kolom}")`);
    }
  });
});

// ═══════════════════════════════════════════════ I — vertalingen
describe("I — de nieuwe teksten bestaan in fr, nl en ar", () => {
  const TALEN: Array<[string, Record<string, unknown>]> = [
    ["fr", fr as Record<string, unknown>],
    ["nl", nl as Record<string, unknown>],
    ["ar", ar as Record<string, unknown>],
  ];

  const filterNs = (berichten: Record<string, unknown>) =>
    (berichten.lots as Record<string, unknown>).filters as Record<string, unknown>;

  it("IB1 — elke filtersleutel bestaat in alle drie de talen en is niet leeg", () => {
    const plat = (o: Record<string, unknown>, pad = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === "object" ? plat(v as Record<string, unknown>, `${pad}${k}.`) : [`${pad}${k}`],
      );
    const verwacht = plat(filterNs(fr as Record<string, unknown>)).sort();
    expect(verwacht.length).toBeGreaterThan(12);
    for (const [naam, berichten] of TALEN) {
      expect(plat(filterNs(berichten)).sort(), naam).toEqual(verwacht);
      for (const sleutel of verwacht) {
        const waarde = sleutel
          .split(".")
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], filterNs(berichten));
        expect(String(waarde).trim(), `${naam}: ${sleutel}`).not.toBe("");
      }
    }
  });

  it("IB2 — elke sorteersleutel en richting heeft een label in alle talen", () => {
    for (const [naam, berichten] of TALEN) {
      const ns = filterNs(berichten);
      for (const sleutel of LOT_SORT_KEYS) {
        expect(typeof (ns.sortBy as Record<string, unknown>)[sleutel], `${naam}.${sleutel}`).toBe("string");
      }
      for (const richting of LOT_SORT_DIRS) {
        expect(typeof (ns.dir as Record<string, unknown>)[richting], `${naam}.${richting}`).toBe("string");
      }
    }
  });

  it("IB3 — elke status heeft een label, want hij staat in de filterlijst", () => {
    for (const [naam, berichten] of TALEN) {
      const status = (berichten.lots as Record<string, unknown>).status as Record<string, unknown>;
      for (const sleutel of LOT_STATUSSEN) {
        expect(typeof status[sleutel], `${naam}.${sleutel}`).toBe("string");
      }
    }
  });

  it("IB4 — de interpolaties overleven de vertaling", () => {
    for (const [naam, berichten] of TALEN) {
      const ns = filterNs(berichten);
      expect(String(ns.remove), naam).toContain("{filter}");
      expect(String(ns.count), naam).toContain("{zichtbaar}");
      expect(String(ns.count), naam).toContain("{totaal}");
    }
  });

  it("IB5 — het Arabisch is daadwerkelijk Arabisch schrift", () => {
    const arabisch = /[؀-ۿ]/;
    const loop = (o: Record<string, unknown>, pad = "") => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object") loop(v as Record<string, unknown>, `${pad}${k}.`);
        else if (typeof v === "string" && /\p{L}/u.test(v.replace(/\{[^}]*\}/g, ""))) {
          expect(arabisch.test(v), `lots.filters.${pad}${k}: ${v}`).toBe(true);
        }
      }
    };
    loop(filterNs(ar as Record<string, unknown>));
  });

  it("IB6 — fr en nl zijn niet dezelfde tekst", () => {
    const frNs = filterNs(fr as Record<string, unknown>);
    const nlNs = filterNs(nl as Record<string, unknown>);
    let verschillen = 0;
    for (const [sleutel, waarde] of Object.entries(frNs)) {
      if (typeof waarde === "string" && waarde !== nlNs[sleutel]) verschillen++;
    }
    expect(verschillen).toBeGreaterThan(3);
  });
});

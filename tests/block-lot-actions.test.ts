import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockErrorFingerprint, blockErrorKey } from "@/lib/blockErrors";
import { bulkLotsSchema } from "@/lib/validation";

/**
 * De mutaties op blokken en lots.
 *
 * ── WAAROM DE GUARDS HIER NIET GEMOCKT ZIJN ────────────────────────────────
 *
 * `assertInOrg` en `assertUnitInOrg` draaien ECHT, tegen een supabase-fake die
 * zich als de database gedraagt. Zou ik ze wegmocken, dan toetst deze suite
 * alleen dat er een functie wordt aangeroepen — niet dat de tenantgrens ook
 * daadwerkelijk sluit. Precies de vergissing die een guard waardeloos maakt.
 *
 * De fake registreert elke schrijfactie. "Geweigerd" betekent hier dus niet
 * "gaf een foutmelding" maar "heeft NIETS geschreven"; dat is het enige dat
 * telt.
 */

const ORG = "org-1";
const VREEMDE_ORG = "org-2";
const BLD = "11111111-1111-1111-1111-111111111111";
const ANDER_GEBOUW = "22222222-2222-2222-2222-222222222222";
const BLOK = "33333333-3333-3333-3333-333333333333";
const VREEMD_BLOK = "44444444-4444-4444-4444-444444444444";
const LOT = "55555555-5555-5555-5555-555555555555";
const VREEMD_LOT = "66666666-6666-6666-6666-666666666666";
// Een TWEEDE gebouw van dezelfde organisatie. Dit is het scenario dat de
// organisatiecontrole alleen niet afvangt: het blok is van de eigen org, maar
// hangt aan een ander gebouw.
const EIGEN_ANDER_GEBOUW = "77777777-7777-7777-7777-777777777777";
const EIGEN_ANDER_BLOK = "88888888-8888-8888-8888-888888888888";

type Rij = Record<string, unknown>;
type Schrijf = { tabel: string; soort: "insert" | "update"; payload: unknown };

const state: {
  rol: string;
  db: Record<string, Rij[]>;
  schrijf: Schrijf[];
  fout: { code: string; message: string } | null;
} = { rol: "manager", db: {}, schrijf: [], fout: null };

function verseDb(): Record<string, Rij[]> {
  return {
    buildings: [
      { id: BLD, organization_id: ORG, total_tantiemes: 1000 },
      { id: ANDER_GEBOUW, organization_id: VREEMDE_ORG, total_tantiemes: 500 },
      { id: EIGEN_ANDER_GEBOUW, organization_id: ORG, total_tantiemes: 800 },
    ],
    blocks: [
      { id: BLOK, organization_id: ORG, building_id: BLD, code: "A", archived_at: null },
      {
        id: VREEMD_BLOK,
        organization_id: VREEMDE_ORG,
        building_id: ANDER_GEBOUW,
        code: "X",
        archived_at: null,
      },
      {
        id: EIGEN_ANDER_BLOK,
        organization_id: ORG,
        building_id: EIGEN_ANDER_GEBOUW,
        code: "C",
        archived_at: null,
      },
    ],
    units: [
      // `buildings` is de embed die `assertUnitInOrg` opvraagt.
      { id: LOT, building_id: BLD, label: "A-01", buildings: { organization_id: ORG } },
      {
        id: VREEMD_LOT,
        building_id: ANDER_GEBOUW,
        label: "X-01",
        buildings: { organization_id: VREEMDE_ORG },
      },
    ],
  };
}

/** Een fake die filtert zoals PostgREST en elke schrijfactie onthoudt. */
function fakeClient() {
  return {
    from(tabel: string) {
      const filters: Record<string, unknown> = {};
      const api: Record<string, unknown> = {};
      Object.assign(api, {
        select: () => api,
        eq: (kolom: string, waarde: unknown) => {
          filters[kolom] = waarde;
          return api;
        },
        maybeSingle: async () => {
          const rij = (state.db[tabel] ?? []).find((r) =>
            Object.entries(filters).every(([k, v]) => r[k] === v),
          );
          return { data: rij ?? null, error: null };
        },
        insert: async (payload: unknown) => {
          state.schrijf.push({ tabel, soort: "insert", payload });
          return { error: state.fout };
        },
        update: (payload: unknown) => {
          const u: Record<string, unknown> = {};
          Object.assign(u, {
            eq: (kolom: string, waarde: unknown) => {
              filters[kolom] = waarde;
              return u;
            },
            then: (res: (v: { error: unknown }) => unknown) => {
              state.schrijf.push({ tabel, soort: "update", payload });
              return Promise.resolve({ error: state.fout }).then(res);
            },
          });
          return u;
        },
      });
      return api;
    },
  };
}

vi.mock("next-intl/server", () => ({
  getTranslations: async (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  getLocale: async () => "fr",
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// `localeRedirect` gooit in productie (NEXT_REDIRECT). Hier geeft hij een
// herkenbare waarde terug, zodat "geslaagd" toetsbaar is zonder de throw.
vi.mock("@/lib/redirect", () => ({
  localeRedirect: async (href: string) => ({ redirected: href }),
}));

vi.mock("@/lib/org", () => ({
  requireOrg: async () => ({ role: state.rol, org: { id: ORG, name: "Org" } }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeClient(),
}));

import {
  createBlock,
  createLotsBulk,
  setBlockArchived,
  updateBlock,
  updateLotLayout,
} from "../src/app/[locale]/(app)/buildings/[id]/indeling/actions";

function fd(velden: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(velden)) f.set(k, v);
  return f;
}

function bulkFd(
  rijen: Array<Partial<{ label: string; unit_type: string; tantiemes: string }>>,
  over: Record<string, string> = {},
) {
  const f = new FormData();
  f.set("building_id", BLD);
  f.set("block_id", "");
  f.set("rows", String(rijen.length));
  rijen.forEach((r, i) => {
    f.set(`label_${i}`, r.label ?? "");
    f.set(`unit_type_${i}`, r.unit_type ?? "");
    f.set(`tantiemes_${i}`, r.tantiemes ?? "");
  });
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

const schrijfNaar = (tabel: string) => state.schrijf.filter((s) => s.tabel === tabel);

let logs: string[] = [];

beforeEach(() => {
  state.rol = "manager";
  state.db = verseDb();
  state.schrijf = [];
  state.fout = null;
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});

afterEach(() => vi.restoreAllMocks());

// ══════════════════════════════════════════════ autorisatie
describe("R — rol en tenantgrens", () => {
  it("R1 — een reader schrijft NIETS, bij geen enkele actie", async () => {
    state.rol = "reader";

    const uitkomsten = await Promise.all([
      createBlock(fd({ building_id: BLD, code: "B" })),
      updateBlock(fd({ building_id: BLD, block_id: BLOK, code: "B" })),
      setBlockArchived(fd({ building_id: BLD, block_id: BLOK, archived: "true" })),
      createLotsBulk(bulkFd([{ label: "A-1", tantiemes: "10" }])),
      updateLotLayout(
        fd({ building_id: BLD, unit_id: LOT, label: "A-1", tantiemes: "10", block_id: "" }),
      ),
    ]);

    expect(state.schrijf).toEqual([]);
    for (const u of uitkomsten) {
      expect((u as { error?: string }).error).toBe("indeling.errors.forbidden");
    }
  });

  it("R2 — elke schrijfrol mag wél", async () => {
    for (const rol of ["owner", "admin", "manager", "accountant"]) {
      state.db = verseDb();
      state.schrijf = [];
      state.rol = rol;
      await createBlock(fd({ building_id: BLD, code: `B-${rol}` }));
      expect(schrijfNaar("blocks").length, rol).toBe(1);
    }
  });

  it("R3 — een gebouw van een andere organisatie wordt geweigerd", async () => {
    const uit = await createBlock(fd({ building_id: ANDER_GEBOUW, code: "B" }));
    expect((uit as { error?: string }).error).toBe("indeling.errors.forbidden");
    expect(state.schrijf).toEqual([]);
  });

  it("R4 — een blok uit een ANDER gebouw kan niet worden bewerkt of gearchiveerd", async () => {
    const bewerk = await updateBlock(
      fd({ building_id: BLD, block_id: VREEMD_BLOK, code: "Z" }),
    );
    const archiveer = await setBlockArchived(
      fd({ building_id: BLD, block_id: VREEMD_BLOK, archived: "true" }),
    );

    expect((bewerk as { error?: string }).error).toBe("indeling.errors.forbidden");
    expect((archiveer as { error?: string }).error).toBe("indeling.errors.forbidden");
    expect(state.schrijf).toEqual([]);
  });

  it("R5 — een lot uit een ander gebouw kan niet worden bewerkt", async () => {
    const uit = await updateLotLayout(
      fd({
        building_id: BLD,
        unit_id: VREEMD_LOT,
        label: "gekaapt",
        tantiemes: "10",
        block_id: "",
      }),
    );
    expect((uit as { error?: string }).error).toBe("indeling.errors.forbidden");
    expect(state.schrijf).toEqual([]);
  });

  it("R6 — een lot verplaatsen naar een blok van een ander gebouw wordt geweigerd", async () => {
    const uit = await updateLotLayout(
      fd({
        building_id: BLD,
        unit_id: LOT,
        label: "A-01",
        tantiemes: "10",
        block_id: VREEMD_BLOK,
      }),
    );
    expect((uit as { error?: string }).error).toBe("indeling.errors.forbidden");
    expect(state.schrijf).toEqual([]);
  });

  it("R7 — bulk-lots in een blok van een ander gebouw wordt geweigerd", async () => {
    const uit = await createLotsBulk(
      bulkFd([{ label: "A-1", tantiemes: "10" }], { block_id: VREEMD_BLOK }),
    );
    expect((uit as { error?: string }).error).toBe("indeling.errors.forbidden");
    expect(state.schrijf).toEqual([]);
  });

  it("R8 — een blok van een ANDER gebouw van DEZELFDE organisatie wordt ook geweigerd", async () => {
    // R4 t/m R7 gebruiken een blok uit een vreemde ORGANISATIE; die sneuvelt al
    // op de organisatiecontrole. Dit blok is van de eigen organisatie en test
    // dus uitsluitend de GEBOUWscope — precies de controle die anders
    // ongemerkt kan verdwijnen.
    const uitkomsten = [
      await updateBlock(fd({ building_id: BLD, block_id: EIGEN_ANDER_BLOK, code: "Z" })),
      await setBlockArchived(
        fd({ building_id: BLD, block_id: EIGEN_ANDER_BLOK, archived: "true" }),
      ),
      await updateLotLayout(
        fd({
          building_id: BLD,
          unit_id: LOT,
          label: "A-01",
          tantiemes: "10",
          block_id: EIGEN_ANDER_BLOK,
        }),
      ),
      await createLotsBulk(
        bulkFd([{ label: "A-1", tantiemes: "10" }], { block_id: EIGEN_ANDER_BLOK }),
      ),
    ];

    for (const uit of uitkomsten) {
      expect((uit as { error?: string }).error).toBe("indeling.errors.forbidden");
    }
    expect(state.schrijf).toEqual([]);
  });

  it("R9 — een blok waarvan de ORGANISATIE niet klopt wordt geweigerd", async () => {
    // In een gezonde database kan dit niet: `blocks_building_org_fk` bindt de
    // organisatie van een blok aan die van zijn gebouw. Juist daarom staat die
    // controle hier — een rij die de FK ooit zou zijn gepasseerd, of een
    // handmatig herstelde rij, mag geen mutatie opleveren.
    state.db.blocks.push({
      id: "99999999-9999-9999-9999-999999999999",
      organization_id: VREEMDE_ORG,
      building_id: BLD,
      code: "SCHEEF",
      archived_at: null,
    });

    const uit = await updateBlock(
      fd({
        building_id: BLD,
        block_id: "99999999-9999-9999-9999-999999999999",
        code: "Z",
      }),
    );
    expect((uit as { error?: string }).error).toBe("indeling.errors.forbidden");
    expect(state.schrijf).toEqual([]);
  });
});

// ══════════════════════════════════════════════ blokken
describe("B — blokken", () => {
  it("B1 — aanmaken schrijft gebouw én organisatie mee", async () => {
    await createBlock(fd({ building_id: BLD, code: " A ", name: "Voorbouw", sort_order: "3" }));

    const [schrijf] = schrijfNaar("blocks");
    expect(schrijf.soort).toBe("insert");
    expect(schrijf.payload).toMatchObject({
      building_id: BLD,
      organization_id: ORG,
      code: "A",
      name: "Voorbouw",
      sort_order: 3,
    });
  });

  it("B2 — een blanco code komt niet eens bij de database", async () => {
    const uit = await createBlock(fd({ building_id: BLD, code: "   " }));
    expect((uit as { error?: string }).error).toBeTruthy();
    expect(state.schrijf).toEqual([]);
  });

  it("B3 — een dubbele code levert een VERTAALDE melding, geen databasetekst", async () => {
    state.fout = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "blocks_building_code_ci_idx" Key (building_id, lower(btrim(code)))=(…, a) already exists.',
    };
    const uit = await createBlock(fd({ building_id: BLD, code: "a" }));

    expect((uit as { error?: string }).error).toBe("indeling.errors.duplicateCode");
    expect(JSON.stringify(uit)).not.toContain("duplicate key");
    expect(JSON.stringify(uit)).not.toContain("blocks_building_code_ci_idx");
  });

  it("B4 — archiveren zet een tijdstip, heractiveren zet null", async () => {
    await setBlockArchived(fd({ building_id: BLD, block_id: BLOK, archived: "true" }));
    const na = schrijfNaar("blocks")[0].payload as { archived_at: string | null };
    expect(typeof na.archived_at).toBe("string");

    state.schrijf = [];
    await setBlockArchived(fd({ building_id: BLD, block_id: BLOK, archived: "false" }));
    expect((schrijfNaar("blocks")[0].payload as { archived_at: string | null }).archived_at).toBeNull();
  });

  it("B5 — archiveren raakt block_id van de lots NIET aan", async () => {
    // Dat is precies waarom de groep "onbereikbaar" op het scherm bestaat.
    await setBlockArchived(fd({ building_id: BLD, block_id: BLOK, archived: "true" }));
    expect(schrijfNaar("units")).toEqual([]);
  });
});

// ══════════════════════════════════════════════ bulk
describe("K — bulk-lots", () => {
  it("K1 — alle rijen gaan in ÉÉN insert: alles of niets", async () => {
    await createLotsBulk(
      bulkFd([
        { label: "A-1", tantiemes: "10" },
        { label: "A-2", tantiemes: "20" },
        { label: "A-3", tantiemes: "30" },
      ]),
    );

    const inserts = schrijfNaar("units");
    expect(inserts.length).toBe(1);
    expect(inserts[0].payload as unknown[]).toHaveLength(3);
  });

  it("K2 — een fout op de insert laat NIETS achter", async () => {
    state.fout = { code: "23505", message: 'duplicate key ... "units_label_key"' };
    const uit = await createLotsBulk(
      bulkFd([
        { label: "A-1", tantiemes: "10" },
        { label: "A-1", tantiemes: "20" },
      ]),
    );
    // Eén statement, dus de database maakt er geen halve set van. De actie
    // meldt dat en doet geen tweede poging met de rest.
    expect((uit as { error?: string }).error).toBeTruthy();
    expect(schrijfNaar("units").length).toBe(1);
  });

  it("K3 — volledig lege rijen tellen niet mee", async () => {
    await createLotsBulk(bulkFd([{ label: "A-1", tantiemes: "10" }, {}, {}]));
    expect((schrijfNaar("units")[0].payload as unknown[])).toHaveLength(1);
  });

  it("K4 — een HALF ingevulde rij wordt afgekeurd, niet stil overgeslagen", async () => {
    // Anders levert een vergeten label stilzwijgend een lot minder op.
    const uit = await createLotsBulk(
      bulkFd([{ label: "A-1", tantiemes: "10" }, { tantiemes: "20" }]),
    );
    expect((uit as { error?: string }).error).toBeTruthy();
    expect(state.schrijf).toEqual([]);
  });

  it("K5 — zonder rijen gebeurt er niets", async () => {
    const uit = await createLotsBulk(bulkFd([{}, {}]));
    expect((uit as { error?: string }).error).toBeTruthy();
    expect(state.schrijf).toEqual([]);
  });

  it("K6 — boven de bovengrens wordt geweigerd", async () => {
    const veel = Array.from({ length: 201 }, (_, i) => ({
      label: `A-${i}`,
      tantiemes: "1",
    }));
    const uit = await createLotsBulk(bulkFd(veel));
    expect((uit as { error?: string }).error).toBeTruthy();
    expect(state.schrijf).toEqual([]);
  });

  it("K7 — een leeg blok betekent 'zonder blok', niet 'ongeldig'", async () => {
    await createLotsBulk(bulkFd([{ label: "A-1", tantiemes: "10" }], { block_id: "" }));
    const rijen = schrijfNaar("units")[0].payload as Array<{ block_id: unknown }>;
    expect(rijen[0].block_id).toBeNull();
  });

  it("K8 — tantièmes blijven GEHEEL, met komma én met punt", async () => {
    // "10,5" wordt al geweigerd omdat het geen getal is; daarmee is over de
    // geheeltalligheid nog niets bewezen. "10.5" IS een getal en sneuvelt
    // uitsluitend op de integer-eis — dat is de echte toets.
    for (const waarde of ["10,5", "10.5"]) {
      state.schrijf = [];
      const uit = await createLotsBulk(bulkFd([{ label: "A-1", tantiemes: waarde }]));
      expect((uit as { error?: string }).error, waarde).toBeTruthy();
      expect(state.schrijf, waarde).toEqual([]);
    }
  });

  it("K9 — de rijenteller wordt begrensd vóór er ook maar iets wordt gelezen", async () => {
    // Een geposte teller van 5000 met drie ingevulde rijen komt nooit bij het
    // schema uit (drie rijen is ruim binnen de grens). Zonder deze bovengrens
    // in de parser zou zo'n post vijfduizend keer een leeg veld opvragen.
    const uit = await createLotsBulk(
      bulkFd([{ label: "A-1", tantiemes: "1" }], { rows: "5000" }),
    );
    expect((uit as { error?: string }).error).toBe("indeling.errors.generic");
    expect(state.schrijf).toEqual([]);
  });

  it("K10 — een onzinnige rijenteller levert niets op", async () => {
    for (const rows of ["-1", "1,5", "abc", "1e3"]) {
      state.schrijf = [];
      const uit = await createLotsBulk(bulkFd([{ label: "A-1", tantiemes: "1" }], { rows }));
      expect((uit as { error?: string }).error, `rows=${rows}`).toBeTruthy();
      expect(state.schrijf, `rows=${rows}`).toEqual([]);
    }
  });

  it("K11 — het schema begrenst de set ook los van de parser", () => {
    // De parser hierboven laat nooit meer dan 200 rijen door, dus deze grens is
    // een TWEEDE slot. Alleen rechtstreeks te toetsen — en dat is precies
    // waarom hij anders ongemerkt zou kunnen verdwijnen.
    const rij = { label: "A-1", unit_type: "appartement", tantiemes: 1 };
    const tweehonderd = bulkLotsSchema.safeParse({
      building_id: BLD,
      block_id: "",
      rows: Array.from({ length: 200 }, () => rij),
    });
    const eenTeveel = bulkLotsSchema.safeParse({
      building_id: BLD,
      block_id: "",
      rows: Array.from({ length: 201 }, () => rij),
    });

    expect(tweehonderd.success).toBe(true);
    expect(eenTeveel.success).toBe(false);
  });
});

// ══════════════════════════════════════════════ lot bewerken
describe("L — lot bewerken", () => {
  it("L1 — label, type, tantième en blok worden bijgewerkt", async () => {
    await updateLotLayout(
      fd({
        building_id: BLD,
        unit_id: LOT,
        label: "A-99",
        unit_type: "parking",
        tantiemes: "42",
        block_id: BLOK,
      }),
    );
    expect(schrijfNaar("units")[0].payload).toMatchObject({
      label: "A-99",
      unit_type: "parking",
      tantiemes: 42,
      block_id: BLOK,
    });
  });

  it("L2 — een leeg blok haalt het lot uit zijn blok", async () => {
    await updateLotLayout(
      fd({ building_id: BLD, unit_id: LOT, label: "A-01", tantiemes: "1", block_id: "" }),
    );
    expect((schrijfNaar("units")[0].payload as { block_id: unknown }).block_id).toBeNull();
  });

  it("L3 — het gebouw van een lot kan hier niet worden gewijzigd", async () => {
    // `building_id` dient als scope-bewijs, niet als doelwaarde: hij hoort
    // niet in de payload. De database weigert het ook, maar aanbieden wat
    // zeker faalt is geen formulier maar een val.
    await updateLotLayout(
      fd({ building_id: BLD, unit_id: LOT, label: "A-01", tantiemes: "1", block_id: "" }),
    );
    expect(schrijfNaar("units")[0].payload).not.toHaveProperty("building_id");
  });

  it("L4 — ook bij bewerken blijft het tantième geheel", async () => {
    // Dezelfde regel als K8, maar op het andere schema. Eén van de twee laten
    // versloffen zou betekenen dat een lot langs de bulk wél geheel blijft en
    // via het bewerkformulier niet.
    for (const waarde of ["10,5", "10.5"]) {
      state.schrijf = [];
      const uit = await updateLotLayout(
        fd({ building_id: BLD, unit_id: LOT, label: "A-01", tantiemes: waarde, block_id: "" }),
      );
      expect((uit as { error?: string }).error, waarde).toBeTruthy();
      expect(state.schrijf, waarde).toEqual([]);
    }
  });
});

// ══════════════════════════════════════════════ lekkage
describe("G — geen databasetekst, geen persoonsgegevens", () => {
  it("G1 — het log draagt alleen SQLSTATE en een bekende constraint", async () => {
    state.fout = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "blocks_building_code_ci_idx" Key ...=(Résidence Atlas, a) already exists.',
    };
    await createBlock(fd({ building_id: BLD, code: "a" }));

    const alles = logs.join(" ");
    expect(alles).toContain("sqlstate=23505");
    expect(alles).toContain("constraint=blocks_building_code_ci_idx");
    expect(alles).not.toContain("Résidence Atlas");
    expect(alles).not.toContain("duplicate key");
  });

  it("G2 — een ONBEKENDE constraint komt niet in het log terecht", async () => {
    state.fout = {
      code: "23505",
      message: 'duplicate key ... constraint "geheime_interne_index" ... Youssef El Amrani',
    };
    await createBlock(fd({ building_id: BLD, code: "a" }));

    const alles = logs.join(" ");
    expect(alles).toContain("constraint=?");
    expect(alles).not.toContain("geheime_interne_index");
    expect(alles).not.toContain("Youssef El Amrani");
  });

  it("G3 — de melding aan de gebruiker is altijd een sleutel", async () => {
    state.fout = { code: "XX999", message: "internal: pg_class corrupted at /var/lib/pg" };
    const uit = await createBlock(fd({ building_id: BLD, code: "a" }));
    expect((uit as { error?: string }).error).toBe("indeling.errors.generic");
    expect(JSON.stringify(uit)).not.toContain("pg_class");
  });
});

// ══════════════════════════════════════════════ foutvertaling
describe("F — foutvertaling", () => {
  it("F1 — elke bekende constraint krijgt zijn eigen sleutel", () => {
    const geval = (naam: string, code: string) =>
      blockErrorKey({ code, message: `violates constraint "${naam}"` });

    expect(geval("blocks_building_code_ci_idx", "23505")).toBe("duplicateCode");
    expect(geval("blocks_code_not_blank", "23514")).toBe("blankCode");
    expect(geval("units_block_building_fk", "23503")).toBe("blockNotInBuilding");
    expect(geval("blocks_building_org_fk", "23503")).toBe("forbidden");
  });

  it("F2 — de constraintnaam wint van de SQLSTATE", () => {
    // Anders zou een tweede unique index op deze tabellen de verkeerde
    // melding opleveren zodra hij wordt geschonden.
    expect(
      blockErrorKey({ code: "23505", message: 'violates constraint "units_block_building_fk"' }),
    ).toBe("blockNotInBuilding");
  });

  it("F3 — SQLSTATE is de terugval als de naam ontbreekt", () => {
    expect(blockErrorKey({ code: "23505", message: "geen naam hier" })).toBe("duplicateCode");
  });

  it("F4 — onbekend blijft generic, nooit de databasetekst", () => {
    expect(blockErrorKey({ code: "XX000", message: "iets volstrekt onbekends" })).toBe("generic");
    expect(blockErrorKey(null)).toBe("generic");
    expect(blockErrorKey(undefined)).toBe("generic");
  });

  it("F5 — de vingerafdruk noemt nooit iets wat we niet al kenden", () => {
    const vies = blockErrorFingerprint({
      code: "23505",
      message: 'constraint "onbekend_iets" waarde=(Fatima Zahra Bennani)',
    });
    expect(vies).toBe("sqlstate=23505 constraint=?");
    expect(vies).not.toContain("Fatima");
  });
});

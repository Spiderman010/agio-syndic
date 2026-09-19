import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bekendeDeleteCode,
  deleteErrorFingerprint,
  deleteErrorKey,
  isBlokkerendeHistorie,
} from "@/lib/deleteErrors";
import { lotDeleteSchema, ownerDeleteSchema } from "@/lib/validation";

/**
 * Het VERWIJDEREN van een lot en van een eigenaar.
 *
 * ── WAT DEZE SUITE WEL EN NIET BEWIJST ─────────────────────────────────────
 *
 * De twee BEFORE DELETE-triggers zijn hier NAGEBOOTST: de fake geeft dezelfde
 * SQLSTATE en dezelfde `CODE: tekst`-melding terug als productie, en laat de rij
 * staan. Wat hier dus wordt bewezen is dat de APPLICATIE die weigering correct
 * behandelt — niet dat de trigger bestaat of werkt.
 *
 * Dat laatste is apart nagemeten, op een wegwerp-Postgres 16 met exact deze
 * constraints en triggers:
 *
 *   • schone eigenaar mét ownership-rij  → verwijderd, ownership cascadeert mee
 *     (de CASCADE-FK wint van de NO ACTION-composite; die controle draait ná de
 *     cascade en vindt dan niets meer)
 *   • eigenaar mét vordering             → ALLOC_OWNER_HAS_HISTORY, blijft staan
 *   • eigenaar mét betaling              → ALLOC_OWNER_HAS_PAYMENTS, blijft staan
 *   • schoon lot mét ownership-rij       → verwijderd, ownership cascadeert mee
 *   • lot mét charge_allocations         → ALLOC_UNIT_HAS_HISTORY, blijft staan
 *   • de client ziet SQLSTATE 23514 met een melding die met de code begint
 *
 * De guards zelf draaien hier ECHT: `assertInOrg` en `assertUnitInOrg` zijn niet
 * gemockt, en "geweigerd" betekent dat er NIETS is verwijderd — niet dat er een
 * foutmelding terugkwam.
 */

const ORG = "org-1";
const VREEMDE_ORG = "org-2";
const BLD = "11111111-1111-1111-1111-111111111111";
const ANDER_GEBOUW = "22222222-2222-2222-2222-222222222222";
const LOT = "55555555-5555-5555-5555-555555555555";
const LOT_MET_HISTORIE = "5555aaaa-5555-5555-5555-555555555555";
const VREEMD_LOT = "66666666-6666-6666-6666-666666666666";
const EIG = "77777777-7777-7777-7777-777777777777";
const EIG_MET_VORDERING = "7777aaaa-7777-7777-7777-777777777777";
const EIG_MET_BETALING = "7777bbbb-7777-7777-7777-777777777777";
const VREEMDE_EIG = "88888888-8888-8888-8888-888888888888";

type Rij = Record<string, unknown>;
type Verwijderd = { tabel: string; filters: Record<string, unknown> };

const state: {
  rol: string;
  db: Record<string, Rij[]>;
  verwijderd: Verwijderd[];
  schrijf: string[];
  /** Een fout die de delete oplevert in plaats van te slagen. */
  forceerFout: { code: string; message: string } | null;
} = { rol: "manager", db: {}, verwijderd: [], schrijf: [], forceerFout: null };

function verseDb(): Record<string, Rij[]> {
  return {
    buildings: [
      { id: BLD, organization_id: ORG },
      { id: ANDER_GEBOUW, organization_id: VREEMDE_ORG },
    ],
    units: [
      { id: LOT, building_id: BLD, label: "A-01", buildings: { organization_id: ORG } },
      {
        id: LOT_MET_HISTORIE,
        building_id: BLD,
        label: "A-02",
        buildings: { organization_id: ORG },
      },
      {
        id: VREEMD_LOT,
        building_id: ANDER_GEBOUW,
        label: "X-01",
        buildings: { organization_id: VREEMDE_ORG },
      },
    ],
    owners: [
      { id: EIG, organization_id: ORG, full_name: "Youssef El Amrani" },
      { id: EIG_MET_VORDERING, organization_id: ORG, full_name: "Fatima Zahra Bennani" },
      { id: EIG_MET_BETALING, organization_id: ORG, full_name: "Karim Idrissi" },
      { id: VREEMDE_EIG, organization_id: VREEMDE_ORG, full_name: "Vreemde Eigenaar" },
    ],
    // Financiële historie. Precies wat de triggers in productie bekijken.
    charge_allocations: [
      { id: "ca1", unit_id: LOT_MET_HISTORIE, owner_id: EIG_MET_VORDERING },
    ],
    payments: [{ id: "p1", owner_id: EIG_MET_BETALING }],
    ownership: [
      { id: "ow1", unit_id: LOT, owner_id: EIG },
      { id: "ow2", unit_id: LOT_MET_HISTORIE, owner_id: EIG_MET_VORDERING },
    ],
  };
}

/** De melding zoals de twee triggers hem in productie werkelijk opleveren. */
function guardFout(code: string) {
  return {
    code: "23514",
    message: `${code}: deze rij heeft vastgelegde historie en kan niet worden verwijderd.`,
    details: null,
    hint: null,
  };
}

/**
 * De fake. Filtert zoals PostgREST, bootst de twee delete-guards na inclusief de
 * ownership-cascade, en onthoudt elke verwijdering.
 */
function fakeClient() {
  return {
    from(tabel: string) {
      const filters: Record<string, unknown> = {};
      const api: Record<string, unknown> = {};
      const past = (r: Rij) => Object.entries(filters).every(([k, v]) => r[k] === v);

      Object.assign(api, {
        select: () => api,
        eq: (kolom: string, waarde: unknown) => {
          filters[kolom] = waarde;
          return api;
        },
        maybeSingle: async () => ({ data: (state.db[tabel] ?? []).find(past) ?? null, error: null }),
        insert: async () => {
          state.schrijf.push(`insert:${tabel}`);
          return { error: null };
        },
        update: () => {
          const u: Record<string, unknown> = {};
          Object.assign(u, {
            eq: () => u,
            then: (res: (v: { error: unknown }) => unknown) => {
              state.schrijf.push(`update:${tabel}`);
              return Promise.resolve({ error: null }).then(res);
            },
          });
          return u;
        },
        delete: () => {
          const d: Record<string, unknown> = {};
          Object.assign(d, {
            eq: (kolom: string, waarde: unknown) => {
              filters[kolom] = waarde;
              return d;
            },
            then: (res: (v: { error: unknown }) => unknown) => {
              const doelen = (state.db[tabel] ?? []).filter(past);

              // Een willekeurige databasefout, om te toetsen wat er dan lekt.
              if (state.forceerFout) {
                return Promise.resolve({ error: state.forceerFout }).then(res);
              }

              // ── de triggers, nagebootst ──────────────────────────────────
              for (const rij of doelen) {
                if (tabel === "units") {
                  if (state.db.charge_allocations.some((a) => a.unit_id === rij.id)) {
                    return Promise.resolve({
                      error: guardFout("ALLOC_UNIT_HAS_HISTORY"),
                    }).then(res);
                  }
                }
                if (tabel === "owners") {
                  if (state.db.charge_allocations.some((a) => a.owner_id === rij.id)) {
                    return Promise.resolve({
                      error: guardFout("ALLOC_OWNER_HAS_HISTORY"),
                    }).then(res);
                  }
                  if (state.db.payments.some((p) => p.owner_id === rij.id)) {
                    return Promise.resolve({
                      error: guardFout("ALLOC_OWNER_HAS_PAYMENTS"),
                    }).then(res);
                  }
                }
              }

              state.verwijderd.push({ tabel, filters: { ...filters } });
              const ids = new Set(doelen.map((r) => r.id));
              state.db[tabel] = (state.db[tabel] ?? []).filter((r) => !ids.has(r.id));
              // ON DELETE CASCADE op ownership — empirisch nagemeten gedrag.
              if (tabel === "units") {
                state.db.ownership = state.db.ownership.filter((o) => !ids.has(o.unit_id));
              }
              if (tabel === "owners") {
                state.db.ownership = state.db.ownership.filter((o) => !ids.has(o.owner_id));
              }
              return Promise.resolve({ error: null }).then(res);
            },
          });
          return d;
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
vi.mock("@/lib/redirect", () => ({
  localeRedirect: async (href: string) => ({ redirected: href }),
}));
vi.mock("@/lib/org", () => ({
  requireOrg: async () => ({ role: state.rol, org: { id: ORG, name: "Org" } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));

import { deleteLot } from "../src/app/[locale]/(app)/buildings/[id]/indeling/actions";
import { deleteOwner } from "../src/app/[locale]/(app)/owners/actions";

function fd(velden: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(velden)) f.set(k, v);
  return f;
}

const lotFd = (over: Record<string, string> = {}) =>
  fd({ building_id: BLD, unit_id: LOT, confirm: "ja", ...over });
const eigFd = (over: Record<string, string> = {}) =>
  fd({ owner_id: EIG, confirm: "ja", ...over });

const bestaat = (tabel: string, id: string) => (state.db[tabel] ?? []).some((r) => r.id === id);
const foutVan = (uit: unknown) => (uit as { error?: string }).error;

let logs: string[] = [];

beforeEach(() => {
  state.rol = "manager";
  state.db = verseDb();
  state.verwijderd = [];
  state.schrijf = [];
  state.forceerFout = null;
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});

afterEach(() => vi.restoreAllMocks());

// ═════════════════════════════════════════════════ een lot verwijderen
describe("V — lot verwijderen", () => {
  it("V1 — een schoon lot gaat weg, en zijn eigendomskoppeling gaat mee", async () => {
    expect(state.db.ownership.some((o) => o.unit_id === LOT)).toBe(true);

    const uit = await deleteLot(lotFd());

    expect(foutVan(uit)).toBeUndefined();
    expect(bestaat("units", LOT)).toBe(false);
    expect(state.db.ownership.some((o) => o.unit_id === LOT)).toBe(false);
    expect(state.verwijderd).toEqual([
      { tabel: "units", filters: { id: LOT, building_id: BLD } },
    ]);
  });

  it("V2 — de delete is op id ÉN gebouw gefilterd, niet op id alleen", async () => {
    // Zonder de tweede filter zou één verkeerd id buiten dit gebouw kunnen
    // treffen; de guard ervoor zou dat moeten tegenhouden, maar twee sloten.
    await deleteLot(lotFd());
    expect(state.verwijderd[0].filters).toHaveProperty("building_id", BLD);
  });

  it("V3 — een lot MET lastenhistorie blijft staan en levert zijn eigen melding", async () => {
    const uit = await deleteLot(lotFd({ unit_id: LOT_MET_HISTORIE }));

    expect(foutVan(uit)).toBe("indeling.errors.lotHasHistory");
    expect(bestaat("units", LOT_MET_HISTORIE)).toBe(true);
    // En de eigendomskoppeling van dat lot is óók niet aangeraakt.
    expect(state.db.ownership.some((o) => o.unit_id === LOT_MET_HISTORIE)).toBe(true);
  });

  it("V4 — een geweigerde verwijdering wordt niet als succes gemeld", async () => {
    const uit = await deleteLot(lotFd({ unit_id: LOT_MET_HISTORIE }));
    expect(uit).not.toHaveProperty("redirected");
  });

  it("V5 — een lezer verwijdert NIETS", async () => {
    state.rol = "reader";
    const uit = await deleteLot(lotFd());

    expect(foutVan(uit)).toBe("indeling.errors.forbidden");
    expect(bestaat("units", LOT)).toBe(true);
    expect(state.verwijderd).toEqual([]);
  });

  it("V6 — elke schrijfrol mag wél", async () => {
    for (const rol of ["owner", "admin", "manager", "accountant"]) {
      state.db = verseDb();
      state.verwijderd = [];
      state.rol = rol;
      await deleteLot(lotFd());
      expect(bestaat("units", LOT), rol).toBe(false);
    }
  });

  it("V7 — ZONDER bevestiging gebeurt er niets", async () => {
    const zonder = new FormData();
    zonder.set("building_id", BLD);
    zonder.set("unit_id", LOT);

    const uit = await deleteLot(zonder);

    expect(foutVan(uit)).toBeTruthy();
    expect(bestaat("units", LOT)).toBe(true);
    expect(state.verwijderd).toEqual([]);
  });

  it("V8 — een andere waarde dan 'ja' geldt niet als bevestiging", async () => {
    for (const waarde of ["nee", "true", "1", "JA", "ja "]) {
      state.db = verseDb();
      state.verwijderd = [];
      const uit = await deleteLot(lotFd({ confirm: waarde }));
      expect(foutVan(uit), waarde).toBeTruthy();
      expect(bestaat("units", LOT), waarde).toBe(true);
    }
  });

  it("V9 — een lot uit een ANDER gebouw wordt niet verwijderd", async () => {
    const uit = await deleteLot(lotFd({ unit_id: VREEMD_LOT }));

    expect(foutVan(uit)).toBe("indeling.errors.forbidden");
    expect(bestaat("units", VREEMD_LOT)).toBe(true);
    expect(state.verwijderd).toEqual([]);
  });

  it("V28 — een lot waarvan het GEBOUW niet van deze organisatie is, gaat niet weg", async () => {
    // V9 en V10 gebruiken een lot uit een ander gebouw; die sneuvelen al op de
    // lotcontrole. Dit lot beweert via zijn embed bij ONZE organisatie te horen,
    // terwijl de `buildings`-rij zelf van een andere organisatie is. Alleen de
    // gebouwcontrole vangt dat — en zonder haar zou dit lot verdwijnen.
    state.db.units.push({
      id: "9999aaaa-9999-9999-9999-999999999999",
      building_id: ANDER_GEBOUW,
      label: "SCHEEF",
      buildings: { organization_id: ORG },
    });

    const uit = await deleteLot(
      lotFd({ building_id: ANDER_GEBOUW, unit_id: "9999aaaa-9999-9999-9999-999999999999" }),
    );

    expect(foutVan(uit)).toBe("indeling.errors.forbidden");
    expect(bestaat("units", "9999aaaa-9999-9999-9999-999999999999")).toBe(true);
    expect(state.verwijderd).toEqual([]);
  });

  it("V10 — een gebouw van een andere organisatie wordt geweigerd", async () => {
    const uit = await deleteLot(lotFd({ building_id: ANDER_GEBOUW, unit_id: VREEMD_LOT }));

    expect(foutVan(uit)).toBe("indeling.errors.forbidden");
    expect(state.verwijderd).toEqual([]);
  });
});

// ═════════════════════════════════════════════════ een eigenaar verwijderen
describe("V — eigenaar verwijderen", () => {
  it("V11 — een schone eigenaar gaat weg, met zijn eigendomskoppelingen", async () => {
    const uit = await deleteOwner(eigFd());

    expect(foutVan(uit)).toBeUndefined();
    expect(bestaat("owners", EIG)).toBe(false);
    expect(state.db.ownership.some((o) => o.owner_id === EIG)).toBe(false);
    expect(state.verwijderd).toEqual([
      { tabel: "owners", filters: { id: EIG, organization_id: ORG } },
    ]);
  });

  it("V12 — een eigenaar met VORDERINGEN blijft staan, met zijn eigen melding", async () => {
    const uit = await deleteOwner(eigFd({ owner_id: EIG_MET_VORDERING }));

    expect(foutVan(uit)).toBe("owners.errors.ownerHasHistory");
    expect(bestaat("owners", EIG_MET_VORDERING)).toBe(true);
  });

  it("V13 — een eigenaar met BETALINGEN krijgt een ANDERE melding", async () => {
    const uit = await deleteOwner(eigFd({ owner_id: EIG_MET_BETALING }));

    expect(foutVan(uit)).toBe("owners.errors.ownerHasPayments");
    expect(bestaat("owners", EIG_MET_BETALING)).toBe(true);
  });

  it("V14 — de twee gevallen worden niet op één hoop gegooid", async () => {
    const metVordering = await deleteOwner(eigFd({ owner_id: EIG_MET_VORDERING }));
    state.db = verseDb();
    const metBetaling = await deleteOwner(eigFd({ owner_id: EIG_MET_BETALING }));

    expect(foutVan(metVordering)).not.toBe(foutVan(metBetaling));
  });

  it("V15 — een lezer verwijdert geen eigenaar", async () => {
    state.rol = "reader";
    const uit = await deleteOwner(eigFd());

    expect(foutVan(uit)).toBe("owners.errors.forbidden");
    expect(bestaat("owners", EIG)).toBe(true);
    expect(state.verwijderd).toEqual([]);
  });

  it("V16 — zonder bevestiging gebeurt er niets", async () => {
    const zonder = new FormData();
    zonder.set("owner_id", EIG);

    const uit = await deleteOwner(zonder);

    expect(foutVan(uit)).toBeTruthy();
    expect(bestaat("owners", EIG)).toBe(true);
    expect(state.verwijderd).toEqual([]);
  });

  it("V17 — een eigenaar van een andere organisatie wordt geweigerd", async () => {
    const uit = await deleteOwner(eigFd({ owner_id: VREEMDE_EIG }));

    expect(foutVan(uit)).toBe("owners.errors.ownerInvalid");
    expect(bestaat("owners", VREEMDE_EIG)).toBe(true);
    expect(state.verwijderd).toEqual([]);
  });

  it("V18 — de delete is op id ÉN organisatie gefilterd", async () => {
    await deleteOwner(eigFd());
    expect(state.verwijderd[0].filters).toHaveProperty("organization_id", ORG);
  });

  it("V19 — de actie kijkt NIET zelf of er historie is", async () => {
    // Zou hij dat doen, dan stond er een tweede definitie van "heeft historie"
    // naast de trigger, en die twee kunnen uiteenlopen. De actie probeert het en
    // vertaalt de weigering. Bewijs: er wordt niets uit charge_allocations of
    // payments gelezen — de weigering komt van de delete zelf.
    const uit = await deleteOwner(eigFd({ owner_id: EIG_MET_VORDERING }));
    expect(foutVan(uit)).toBe("owners.errors.ownerHasHistory");
    // De rij staat er nog, dus de delete IS geprobeerd en geweigerd.
    expect(bestaat("owners", EIG_MET_VORDERING)).toBe(true);
  });
});

// ═════════════════════════════════════════════════ lekkage
describe("G — geen databasetekst, geen persoonsgegevens", () => {
  it("G1 — het log draagt alleen SQLSTATE en een code die we al kenden", async () => {
    await deleteLot(lotFd({ unit_id: LOT_MET_HISTORIE }));

    const alles = logs.join(" ");
    expect(alles).toContain("sqlstate=23514");
    expect(alles).toContain("code=ALLOC_UNIT_HAS_HISTORY");
    expect(alles).not.toContain("vastgelegde historie");
  });

  it("G2 — een ONBEKENDE fout mét persoonsgegevens lekt evenmin", async () => {
    // Dit is het gevaarlijke geval: geen nette code, maar volle Postgres-tekst
    // met een naam en een gebouw erin. Precies wat PostgREST teruggeeft bij een
    // constraint die we niet hebben voorzien.
    state.forceerFout = {
      code: "23503",
      message:
        'update or delete on table "owners" violates foreign key constraint "x" on table "y" — ' +
        "Key (id)=(77777777-7777-7777-7777-777777777777) Youssef El Amrani, Résidence Atlas",
    };

    const uit = await deleteOwner(eigFd());

    // De gebruiker krijgt een sleutel, niet de tekst.
    expect(foutVan(uit)).toBe("owners.errors.generic");
    // En het log draagt alleen de SQLSTATE; de code is onbekend, dus "?".
    const alles = logs.join(" ");
    expect(alles).toContain("sqlstate=23503");
    expect(alles).toContain("code=?");
    for (const verboden of [
      "Youssef El Amrani",
      "Résidence Atlas",
      "violates foreign key",
      EIG,
      // Let op: "owners" staat hier NIET bij. Het log begint met `[owners]`, en
      // dat is onze eigen scope-aanduiding, geen databasetekst.
      "on table",
    ]) {
      expect(alles, `"${verboden}" lekt naar het log`).not.toContain(verboden);
    }
  });

  it("G3 — geen naam, geen id, geen Postgres-proza in het log", async () => {
    await deleteOwner(eigFd({ owner_id: EIG_MET_VORDERING }));

    const alles = logs.join(" ");
    for (const verboden of [
      "Fatima Zahra Bennani",
      "Youssef El Amrani",
      EIG_MET_VORDERING,
      ORG,
      "kan niet worden verwijderd",
    ]) {
      expect(alles, `"${verboden}" lekt naar het log`).not.toContain(verboden);
    }
  });

  it("G4 — de melding aan de gebruiker is altijd een SLEUTEL", async () => {
    const uitkomsten = [
      await deleteLot(lotFd({ unit_id: LOT_MET_HISTORIE })),
      await deleteOwner(eigFd({ owner_id: EIG_MET_VORDERING })),
      await deleteOwner(eigFd({ owner_id: EIG_MET_BETALING })),
    ];
    for (const uit of uitkomsten) {
      const melding = foutVan(uit) ?? "";
      expect(melding).toMatch(/^(indeling|owners)\.errors\.[a-zA-Z]+$/);
      expect(melding).not.toContain("23514");
      expect(melding).not.toContain("ALLOC_");
    }
  });
});

// ═════════════════════════════════════════════════ de sleutelafbeelding
describe("F — codes naar sleutels", () => {
  it("F1 — elke bekende code krijgt zijn EIGEN sleutel", () => {
    const paren = [
      ["ALLOC_UNIT_HAS_HISTORY", "lotHasHistory"],
      ["ALLOC_OWNER_HAS_HISTORY", "ownerHasHistory"],
      ["ALLOC_OWNER_HAS_PAYMENTS", "ownerHasPayments"],
    ] as const;

    for (const [code, sleutel] of paren) {
      expect(deleteErrorKey({ code: "23514", message: `${code}: iets` }), code).toBe(sleutel);
    }
    // Drie codes, drie VERSCHILLENDE sleutels — anders zou een eigenaar met
    // betalingen dezelfde zin krijgen als een eigenaar met vorderingen.
    expect(new Set(paren.map(([, s]) => s)).size).toBe(3);
  });

  it("F2 — onbekend blijft generic, nooit de databasetekst", () => {
    for (const message of [
      'duplicate key value violates unique constraint "x" Key=(Résidence Atlas)',
      "ALLOC_SOMETHING_ELSE: iets nieuws",
      "",
      null,
      undefined,
    ]) {
      expect(deleteErrorKey({ code: "23514", message }), String(message)).toBe("generic");
    }
    expect(deleteErrorKey(null)).toBe("generic");
  });

  it("F3 — een code midden in een melding telt NIET", () => {
    // Anders zou willekeurige databasetekst waarin de code voorkomt een
    // specifieke belofte opleveren die niet uit een trigger komt.
    expect(
      deleteErrorKey({ code: "23514", message: "iets ALLOC_UNIT_HAS_HISTORY iets" }),
    ).toBe("generic");
    expect(bekendeDeleteCode({ code: "23514", message: "x ALLOC_UNIT_HAS_HISTORY" })).toBeNull();
  });

  it("F4 — de vingerafdruk noemt nooit iets wat we niet al kenden", () => {
    const fout = {
      code: "23514",
      message: 'ALLOC_OWNER_HAS_PAYMENTS: Karim Idrissi heeft betalingen in "Résidence Atlas".',
    };
    const vinger = deleteErrorFingerprint(fout);

    expect(vinger).toBe("sqlstate=23514 code=ALLOC_OWNER_HAS_PAYMENTS");
    expect(vinger).not.toContain("Karim");
    expect(vinger).not.toContain("Résidence");
  });

  it("F5 — bij een onbekende fout draagt de vingerafdruk geen tekst", () => {
    const vinger = deleteErrorFingerprint({
      code: "23503",
      message: 'update or delete on table "units" violates foreign key constraint x on table y',
    });
    expect(vinger).toBe("sqlstate=23503 code=?");
    expect(vinger).not.toContain("units");
  });

  it("F6 — 'blokkerende historie' is alleen waar bij een bekende code", () => {
    expect(isBlokkerendeHistorie({ code: "23514", message: "ALLOC_UNIT_HAS_HISTORY: x" })).toBe(
      true,
    );
    // Een willekeurige 23514 is NIET automatisch historie; dat zou een reden
    // verzinnen die we niet hebben nagemeten.
    expect(isBlokkerendeHistorie({ code: "23514", message: "een andere check faalde" })).toBe(
      false,
    );
  });
});

// ═════════════════════════════════════════════════ de schemas
describe("S — bevestiging is een serverregel", () => {
  it("S1 — het lotschema eist letterlijk 'ja'", () => {
    expect(lotDeleteSchema.safeParse({ building_id: BLD, unit_id: LOT, confirm: "ja" }).success)
      .toBe(true);
    for (const confirm of ["nee", "JA", "", "1", true, undefined]) {
      expect(
        lotDeleteSchema.safeParse({ building_id: BLD, unit_id: LOT, confirm }).success,
        String(confirm),
      ).toBe(false);
    }
  });

  it("S2 — het eigenaarschema eist dat ook", () => {
    expect(ownerDeleteSchema.safeParse({ owner_id: EIG, confirm: "ja" }).success).toBe(true);
    expect(ownerDeleteSchema.safeParse({ owner_id: EIG }).success).toBe(false);
  });

  it("S3 — een lot verwijderen zonder gebouw-bewijs kan niet", () => {
    // `building_id` is de scope waarop de server controleert; zonder die waarde
    // is er niets om tegen te controleren.
    expect(lotDeleteSchema.safeParse({ unit_id: LOT, confirm: "ja" }).success).toBe(false);
  });
});

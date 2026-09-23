import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTranslator } from "next-intl";
import {
  addDays,
  assembleOwnership,
  classifyOwnership,
  currentOwnership,
  currentOwnerships,
  groupByUnit,
  isActiveOn,
  isCurrent,
  lotStatus,
  matchesSearch,
  matchesUnitSearch,
  ownerFormState,
  ownerScopes,
  ownershipErrorKey,
  periodsOverlap,
  requiresRefresh,
  sortHistory,
  tantiemeOverzicht,
  transferability,
  type OwnerRow,
  type OwnershipClass,
  type OwnershipRow,
  type UnitRow,
} from "@/lib/ownership";
import { canWrite } from "@/lib/roles";
import { allNavHrefs, buildBreadcrumbs, buildingNavItems, globalNavItems } from "@/lib/nav";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const BLD_A = "aaaaaaaa-0000-0000-0000-00000000000a"; // gebouw A
const BLD_B = "bbbbbbbb-0000-0000-0000-00000000000b"; // gebouw B
const U1 = "11111111-0000-0000-0000-000000000001";
const U2 = "22222222-0000-0000-0000-000000000002";
const U3 = "33333333-0000-0000-0000-000000000003";
const O1 = "0a000000-0000-0000-0000-000000000001";
const O2 = "0b000000-0000-0000-0000-000000000002";

let teller = 0;
function own(over: Partial<OwnershipRow> = {}): OwnershipRow {
  teller += 1;
  return {
    id: `own-${String(teller).padStart(4, "0")}`,
    unit_id: U1,
    owner_id: O1,
    share: 1,
    start_date: "2026-01-01",
    end_date: null,
    is_primary_debtor: true,
    ...over,
  };
}

function unit(over: Partial<UnitRow> = {}): UnitRow {
  return {
    id: U1,
    building_id: BLD_A,
    label: "A1",
    unit_type: "appartement",
    tantiemes: 100,
    floor: null,
    area_m2: null,
    ...over,
  };
}

function owner(over: Partial<OwnerRow> = {}): OwnerRow {
  return {
    id: O1,
    full_name: "Yassine Belkacem",
    is_company: false,
    email: "yassine@example.ma",
    phone: "+212 612-345678",
    language: "fr",
    is_mre: false,
    ...over,
  };
}

// ── DATUMSEMANTIEK ──────────────────────────────────────────────────────────

describe("O — eigendom op een datum", () => {
  it("O1 — beide grenzen zijn INCLUSIEF, exact als fn_alloc_resolve_owner", () => {
    const rij = own({ start_date: "2026-03-01", end_date: "2026-06-30" });
    expect(isActiveOn(rij, "2026-02-28")).toBe(false);
    expect(isActiveOn(rij, "2026-03-01")).toBe(true); // eerste dag telt mee
    expect(isActiveOn(rij, "2026-06-30")).toBe(true); // laatste dag telt mee
    expect(isActiveOn(rij, "2026-07-01")).toBe(false);
  });

  it("O2 — een lopende periode heeft geen bovengrens", () => {
    const rij = own({ start_date: "2026-03-01", end_date: null });
    expect(isActiveOn(rij, "2026-03-01")).toBe(true);
    expect(isActiveOn(rij, "2099-12-31")).toBe(true);
    expect(isActiveOn(rij, "2026-02-28")).toBe(false);
    expect(isCurrent(rij)).toBe(true);
  });

  it("O3 — een overdracht op D laat oud en nieuw elkaar NIET overlappen", () => {
    // Precies wat transfer_ownership doet: oud t/m D-1, nieuw vanaf D.
    const oud = own({ start_date: "2026-01-01", end_date: "2026-08-31" });
    const nieuw = own({ owner_id: O2, start_date: "2026-09-01", end_date: null });
    expect(periodsOverlap(oud, nieuw)).toBe(false);
    expect(isActiveOn(oud, "2026-08-31")).toBe(true);
    expect(isActiveOn(nieuw, "2026-08-31")).toBe(false);
    expect(isActiveOn(oud, "2026-09-01")).toBe(false);
    expect(isActiveOn(nieuw, "2026-09-01")).toBe(true);
  });

  it("O4 — een einddatum GELIJK aan de nieuwe startdatum overlapt wél", () => {
    // De klassieke afsluitfout: end_date = D in plaats van D-1. Op dag D zijn er
    // dan twee eigenaars en faalt een lastenoproep met ALLOC_AMBIGUOUS_OWNER.
    const oud = own({ start_date: "2026-01-01", end_date: "2026-09-01" });
    const nieuw = own({ owner_id: O2, start_date: "2026-09-01", end_date: null });
    expect(periodsOverlap(oud, nieuw)).toBe(true);
    expect(isActiveOn(oud, "2026-09-01")).toBe(true);
    expect(isActiveOn(nieuw, "2026-09-01")).toBe(true);
  });

  it("O5 — twee gesloten perioden die elkaar raken overlappen op één dag", () => {
    const a = own({ start_date: "2025-01-01", end_date: "2025-12-31" });
    const b = own({ start_date: "2025-12-31", end_date: "2026-06-30" });
    expect(periodsOverlap(a, b)).toBe(true);
    const c = own({ start_date: "2026-01-01", end_date: "2026-06-30" });
    expect(periodsOverlap(a, c)).toBe(false);
  });
});

describe("H — actuele eigenaar en historie", () => {
  it("H1 — de aangewezen debiteur wint, net als de verdeelmotor", () => {
    const rijen = [
      own({ owner_id: O1, is_primary_debtor: false, share: 0.5 }),
      own({ owner_id: O2, is_primary_debtor: true, share: 0.5 }),
    ];
    expect(currentOwnership(rijen)?.owner_id).toBe(O2);
  });

  it("H2 — zonder lopende periode is er geen actuele eigenaar", () => {
    const rijen = [own({ end_date: "2026-05-31" })];
    expect(currentOwnership(rijen)).toBeNull();
    expect(currentOwnerships(rijen)).toEqual([]);
  });

  it("H3 — de ordening is TOTAAL: gelijke rijen breken op id", () => {
    const a = own({ id: "own-zzzz", owner_id: O1 });
    const b = own({ id: "own-aaaa", owner_id: O2 });
    expect(currentOwnership([a, b])?.id).toBe("own-aaaa");
    expect(currentOwnership([b, a])?.id).toBe("own-aaaa");
  });

  it("H4 — historie staat nieuwste eerst, lopende periode bovenaan", () => {
    const oud = own({ start_date: "2024-01-01", end_date: "2024-12-31" });
    const midden = own({ start_date: "2025-01-01", end_date: "2025-12-31" });
    const lopend = own({ start_date: "2026-01-01", end_date: null });
    const uit = sortHistory([midden, oud, lopend]);
    expect(uit.map((r) => r.start_date)).toEqual(["2026-01-01", "2025-01-01", "2024-01-01"]);
  });
});

// ── SCOPE ───────────────────────────────────────────────────────────────────

describe("S — scope van eigenaren en lots", () => {
  const unitBuilding = new Map([
    [U1, BLD_A],
    [U2, BLD_B],
    [U3, BLD_A],
  ]);
  const buildingNaam = new Map([
    [BLD_A, "Résidence Atlas"],
    [BLD_B, "Résidence Zerhoun"],
  ]);

  it("S1 — een eigenaar met lots in TWEE gebouwen verschijnt één keer", () => {
    const scopes = ownerScopes(
      [own({ unit_id: U1, owner_id: O1 }), own({ unit_id: U2, owner_id: O1 })],
      unitBuilding,
      buildingNaam,
    );
    expect(scopes.size).toBe(1);
    const scope = scopes.get(O1);
    expect(scope?.lotCount).toBe(2);
    expect(scope?.buildingIds).toHaveLength(2);
    expect(new Set(scope?.buildingIds)).toEqual(new Set([BLD_A, BLD_B]));
  });

  it("S2 — twee lots in HETZELFDE gebouw geven één gebouw, geen duplicaat", () => {
    const scopes = ownerScopes(
      [own({ unit_id: U1, owner_id: O1 }), own({ unit_id: U3, owner_id: O1 })],
      unitBuilding,
      buildingNaam,
    );
    expect(scopes.get(O1)?.lotCount).toBe(2);
    expect(scopes.get(O1)?.buildingIds).toEqual([BLD_A]);
  });

  it("S3 — een organisatie-eigenaar zonder actueel lot krijgt GEEN gebouw toegewezen", () => {
    // De kern van de scopefout: elke eigenaar is organisatiebreed, maar daaruit
    // volgt NIET dat hij bij elk gebouw hoort.
    const scopes = ownerScopes([own({ unit_id: U1, owner_id: O1 })], unitBuilding, buildingNaam);
    expect(scopes.has(O2)).toBe(false);
    expect(scopes.get(O2)).toBeUndefined();
  });

  it("S4 — een beëindigde eigendomsrij telt niet mee als actueel lot", () => {
    const scopes = ownerScopes(
      [own({ unit_id: U1, owner_id: O1, end_date: "2026-05-31" })],
      unitBuilding,
      buildingNaam,
    );
    expect(scopes.has(O1)).toBe(false);
  });

  it("S5 — een lot buiten de opgehaalde scope wordt niet toegerekend", () => {
    // Zou een eigenaar anders een gebouw geven dat we helemaal niet toonden.
    const scopes = ownerScopes(
      [own({ unit_id: "onbekend-lot", owner_id: O1 })],
      unitBuilding,
      buildingNaam,
    );
    expect(scopes.size).toBe(0);
  });

  it("S6 — groupByUnit houdt lots strikt gescheiden", () => {
    const perUnit = groupByUnit([
      own({ unit_id: U1 }),
      own({ unit_id: U2 }),
      own({ unit_id: U1, end_date: "2025-12-31" }),
    ]);
    expect(perUnit.get(U1)).toHaveLength(2);
    expect(perUnit.get(U2)).toHaveLength(1);
    expect(perUnit.get(U3)).toBeUndefined();
  });
});

// ── VOLLEDIGHEID ────────────────────────────────────────────────────────────

describe("V — volledigheid van lots", () => {
  it("V1 — een lot met één eigenaar en tantième is compleet", () => {
    expect(lotStatus(unit(), [own()])).toBe("compleet");
  });

  it("V2 — geen actuele eigenaar weegt zwaarder dan een tantième van nul", () => {
    // Zonder eigenaar faalt create_charge_call volledig (ALLOC_NO_OWNER);
    // tantième nul betekent alleen dat het lot niet meedeelt.
    expect(lotStatus(unit({ tantiemes: 0 }), [])).toBe("zonderEigenaar");
    expect(lotStatus(unit({ tantiemes: 0 }), [own()])).toBe("zonderTantieme");
  });

  it("V3 — twee actuele eigenaars: GELDIG met één debiteur, ambigu zonder", () => {
    // Deze test bleef eerder groen ook zonder de reparatie, omdat de fixture per
    // ongeluk al een geldige mede-eigendom was. Het onderscheid dat de reparatie
    // aanbrengt wordt nu wél afgedwongen: dezelfde twee eigenaars leveren een
    // ANDERE status op zodra de aangewezen debiteur ontbreekt.
    const geldig = [own({ owner_id: O1 }), own({ owner_id: O2, is_primary_debtor: false })];
    expect(lotStatus(unit(), geldig)).toBe("medeEigendom");

    const ambigu = [
      own({ owner_id: O1, is_primary_debtor: false }),
      own({ owner_id: O2, is_primary_debtor: false }),
    ];
    expect(lotStatus(unit(), ambigu)).toBe("ambigu");
  });

  it("V4 — het tantièmetotaal wordt tegen de declaratie afgezet", () => {
    const units = [unit({ id: U1, tantiemes: 400 }), unit({ id: U2, tantiemes: 500 })];
    const perUnit = new Map([
      [U1, [own({ unit_id: U1 })]],
      [U2, [own({ unit_id: U2, owner_id: O2 })]],
    ]);
    const uit = tantiemeOverzicht(units, perUnit, 1000);
    expect(uit.toegekend).toBe(900);
    expect(uit.verklaard).toBe(1000);
    expect(uit.verschil).toBe(-100);
    expect(uit.oproepVeilig).toBe(false);
  });

  it("V5 — pas bij volledige dekking is een oproep veilig", () => {
    const units = [unit({ id: U1, tantiemes: 600 }), unit({ id: U2, tantiemes: 400 })];
    const perUnit = new Map([
      [U1, [own({ unit_id: U1 })]],
      [U2, [own({ unit_id: U2, owner_id: O2 })]],
    ]);
    expect(tantiemeOverzicht(units, perUnit, 1000).oproepVeilig).toBe(true);
  });

  it("V6 — een lot zonder eigenaar maakt de oproep onveilig, ook bij kloppend totaal", () => {
    const units = [unit({ id: U1, tantiemes: 600 }), unit({ id: U2, tantiemes: 400 })];
    const perUnit = new Map([[U1, [own({ unit_id: U1 })]]]);
    const uit = tantiemeOverzicht(units, perUnit, 1000);
    expect(uit.verschil).toBe(0);
    expect(uit.zonderEigenaar).toBe(1);
    expect(uit.oproepVeilig).toBe(false);
  });

  it("V7 — een gebouw zonder lots is nooit 'veilig'", () => {
    expect(tantiemeOverzicht([], new Map(), 1000).oproepVeilig).toBe(false);
  });
});

// ── ZOEKEN ──────────────────────────────────────────────────────────────────

describe("Z — zoeken", () => {
  it("Z1 — zoekt op naam, e-mail en telefoon", () => {
    expect(matchesSearch(owner(), "belkacem")).toBe(true);
    expect(matchesSearch(owner(), "yassine@example")).toBe(true);
    expect(matchesSearch(owner(), "612")).toBe(true);
    expect(matchesSearch(owner(), "zzzz")).toBe(false);
  });

  it("Z2 — diakrieten en hoofdletters doen er niet toe", () => {
    expect(matchesSearch(owner({ full_name: "Belkacém" }), "belkacem")).toBe(true);
    expect(matchesSearch(owner({ full_name: "Belkacem" }), "BELKACÉM")).toBe(true);
  });

  it("Z3 — een telefoonnummer matcht ongeacht spaties en streepjes", () => {
    expect(matchesSearch(owner({ phone: "+212 612-345678" }), "0612 34")).toBe(false);
    expect(matchesSearch(owner({ phone: "+212 612-345678" }), "612-345")).toBe(true);
    expect(matchesSearch(owner({ phone: "06 12 34 56 78" }), "0612")).toBe(true);
  });

  it("Z4 — een lege zoekterm toont alles", () => {
    expect(matchesSearch(owner(), "")).toBe(true);
    expect(matchesSearch(owner(), "   ")).toBe(true);
    expect(matchesUnitSearch(unit(), "")).toBe(true);
  });

  it("Z5 — een eigenaar zonder contactgegevens laat zoeken niet crashen", () => {
    const zonder = owner({ email: null, phone: null });
    expect(matchesSearch(zonder, "yassine")).toBe(true);
    expect(matchesSearch(zonder, "612")).toBe(false);
  });

  it("Z6 — lots zijn te vinden op label, type en verdieping", () => {
    const lot = unit({ label: "B12", unit_type: "parking", floor: "2" });
    expect(matchesUnitSearch(lot, "b12")).toBe(true);
    expect(matchesUnitSearch(lot, "parking")).toBe(true);
    expect(matchesUnitSearch(lot, "2")).toBe(true);
    expect(matchesUnitSearch(lot, "kelder")).toBe(false);
  });
});

// ── FAIL-CLOSED ─────────────────────────────────────────────────────────────

describe("F — een queryfout wordt nooit een geldige lege toestand", () => {
  it("F1 — een mislukte ownersquery levert GEEN lege lijst op", () => {
    const uit = assembleOwnership({ units: [], ownership: [], owners: null });
    expect(uit.status).toBe("error");
    if (uit.status === "error") expect(uit.failed).toContain("owners");
  });

  it("F2 — een mislukte unitsquery levert GEEN lege lijst op", () => {
    const uit = assembleOwnership({ units: null, ownership: [], owners: [] });
    expect(uit.status).toBe("error");
    if (uit.status === "error") expect(uit.failed).toContain("units");
  });

  it("F3 — een mislukte ownershipquery leest NOOIT als 'zonder eigenaar'", () => {
    // Dit is het gevaarlijkste geval: een leeg resultaat zou een beheerder
    // ertoe verleiden een eigenaar te koppelen die er al is.
    const uit = assembleOwnership({ units: [unit()], ownership: null, owners: [owner()] });
    expect(uit.status).toBe("error");
    if (uit.status === "error") expect(uit.failed).toContain("ownership");
  });

  it("F4 — leeg is iets anders dan mislukt", () => {
    const uit = assembleOwnership({ units: [], ownership: [], owners: [] });
    expect(uit.status).toBe("ok");
    if (uit.status === "ok") {
      expect(uit.units).toEqual([]);
      expect(lotStatus(unit(), [...uit.ownership])).toBe("zonderEigenaar");
    }
  });

  it("F5 — één mislukte bron onderdrukt ALLE bronnen", () => {
    const uit = assembleOwnership({ units: [unit()], ownership: [own()], owners: null });
    expect(uit.status).toBe("error");
  });
});

// ── FOUTCODES ───────────────────────────────────────────────────────────────

describe("E — databasefoutcodes", () => {
  it("E1 — elke RPC-code krijgt een eigen sleutel", () => {
    expect(ownershipErrorKey("OWNERSHIP_STALE")).toBe("stale");
    expect(ownershipErrorKey("OWNERSHIP_COOWNED")).toBe("coowned");
    expect(ownershipErrorKey("OWNERSHIP_HISTORY_EXISTS")).toBe("historyExists");
    expect(ownershipErrorKey("OWNERSHIP_DATE_FUTURE")).toBe("dateFuture");
    expect(ownershipErrorKey("OWNERSHIP_DELETE_FORBIDDEN")).toBe("deleteForbidden");
    expect(ownershipErrorKey("OWNERSHIP_NOT_FULL")).toBe("notFull");
    expect(ownershipErrorKey("OWNERSHIP_OVERLAP")).toBe("overlap");
  });

  it("E2 — unauthenticated en forbidden lopen samen: geen bestaansorakel", () => {
    expect(ownershipErrorKey("OWNERSHIP_FORBIDDEN")).toBe("forbidden");
    expect(ownershipErrorKey("OWNERSHIP_UNAUTHENTICATED")).toBe("forbidden");
  });

  it("E3 — onbekende databasetekst wordt NOOIT doorgegeven aan de gebruiker", () => {
    expect(ownershipErrorKey('duplicate key value violates unique constraint "x"')).toBe(
      "generic",
    );
    expect(ownershipErrorKey("permission denied for table ownership")).toBe("generic");
    expect(ownershipErrorKey(null)).toBe("generic");
    expect(ownershipErrorKey("")).toBe("generic");
  });

  it("E4 — alleen een stale write vraagt om verversen", () => {
    expect(requiresRefresh("OWNERSHIP_STALE")).toBe(true);
    expect(requiresRefresh("OWNERSHIP_COOWNED")).toBe(false);
    expect(requiresRefresh(null)).toBe(false);
  });

  it("E5 — elke sleutel bestaat als vertaling in alle drie de talen", () => {
    const talen: Record<string, unknown> = { fr, nl, ar };
    const codes = [
      "OWNERSHIP_FORBIDDEN",
      "OWNERSHIP_UNAUTHENTICATED",
      "OWNERSHIP_OWNER_INVALID",
      "OWNERSHIP_DATE_INVALID",
      "OWNERSHIP_DATE_FUTURE",
      "OWNERSHIP_HISTORY_EXISTS",
      "OWNERSHIP_NO_CURRENT",
      "OWNERSHIP_COOWNED",
      "OWNERSHIP_STALE",
      "OWNERSHIP_NOT_PRIMARY",
      "OWNERSHIP_NOT_FULL",
      "OWNERSHIP_SAME_OWNER",
      "OWNERSHIP_DATE_NOT_AFTER_START",
      "OWNERSHIP_OVERLAP",
      "OWNERSHIP_DELETE_FORBIDDEN",
      "iets volstrekt onbekends",
    ];
    for (const [naam, berichten] of Object.entries(talen)) {
      const errors = (
        (berichten as Record<string, Record<string, unknown>>).owners as Record<string, unknown>
      ).errors as Record<string, unknown>;
      for (const code of codes) {
        const sleutel = ownershipErrorKey(code);
        expect(typeof errors[sleutel], `${naam} owners.errors.${sleutel}`).toBe("string");
      }
    }
  });
});

// ── ROLLEN ──────────────────────────────────────────────────────────────────

describe("R — rollen spiegelen can_write", () => {
  it("R1 — een reader mag niets muteren", () => {
    expect(canWrite("reader")).toBe(false);
  });

  it("R2 — de schrijvende rollen zijn exact die uit can_write", () => {
    for (const rol of ["owner", "admin", "manager", "accountant"] as const) {
      expect(canWrite(rol), rol).toBe(true);
    }
  });

  it("R3 — de mutatieformulieren staan achter dezelfde beslissing", () => {
    // De pagina's renderen elk formulier binnen `mayWrite ? ... : null`. Deze
    // test bewaakt dat die poort niet per ongeluk verdwijnt; de database blijft
    // de echte grens.
    const paden = [
      join(REPO, "src", "app", "[locale]", "(app)", "owners", "page.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "page.tsx"),
    ];
    for (const pad of paden) {
      const bron = readFileSync(pad, "utf8");
      expect(bron, pad).toContain("canWrite(role)");
      expect(bron, pad).toContain("mayWrite ?");
    }
  });
});

// ── ARCHITECTUUR ────────────────────────────────────────────────────────────

describe("A — eigendom loopt uitsluitend via de RPC's", () => {
  function alleBronnen(map: string): string[] {
    const uit: string[] = [];
    for (const naam of readdirSync(map)) {
      if (naam === "node_modules" || naam === ".next") continue;
      const pad = join(map, naam);
      if (statSync(pad).isDirectory()) uit.push(...alleBronnen(pad));
      else if (/\.(ts|tsx)$/.test(naam)) uit.push(pad);
    }
    return uit;
  }

  const bronnen = alleBronnen(join(REPO, "src"));

  it("A1 — nergens nog een directe schrijfactie op ownership", () => {
    // Sinds m30 heeft `authenticated` alleen SELECT op `ownership`. Een insert,
    // update of delete zou dus sowieso falen; deze test voorkomt dat er ooit een
    // terugval terugsluipt die de bedoelde regels omzeilt.
    for (const pad of bronnen) {
      const bron = readFileSync(pad, "utf8");
      const raakt = /from\(\s*["']ownership["']\s*\)([\s\S]{0,200}?)\.(insert|update|delete|upsert)\(/;
      expect(raakt.test(bron), `${pad} schrijft rechtstreeks in ownership`).toBe(false);
    }
  });

  it("A2 — de eerste koppeling gebruikt link_first_owner", () => {
    const paden = [
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "actions.ts"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "actions.ts"),
    ];
    for (const pad of paden) {
      expect(readFileSync(pad, "utf8"), pad).toContain('rpc("link_first_owner"');
    }
  });

  it("A3 — de overdracht stuurt ALTIJD een verwachte huidige rij mee", () => {
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "actions.ts"),
      "utf8",
    );
    expect(bron).toContain('rpc("transfer_ownership"');
    expect(bron).toContain("p_expected_current_ownership_id");

    // Het formulier moet die waarde ook werkelijk renderen, anders is de
    // stale-bescherming een lege huls.
    const formulier = readFileSync(
      join(
        REPO,
        "src",
        "app",
        "[locale]",
        "(app)",
        "buildings",
        "[id]",
        "lots",
        "OwnershipForms.tsx",
      ),
      "utf8",
    );
    expect(formulier).toContain('name="expected_ownership_id"');
    expect(formulier).toContain("current.id");
  });

  /**
   * A4 stond hier oorspronkelijk als "nergens een delete". Dat was juist zolang
   * er niets verwijderd kon worden; nu kunnen een lot en een eigenaar weg, en
   * dan is een blanco verbod geen guard meer maar een leugen die vroeg of laat
   * wordt weggehaald.
   *
   * Wat er WEL te bewaken valt is de grens: er mag uit precies twee tabellen
   * worden verwijderd, en `ownership` staat daar niet bij. Eigendom beëindigen
   * of overdragen loopt via de RPC's met hun eigen stale-bescherming; een kale
   * DELETE op `ownership` zou die hele flow omzeilen en de historie stilletjes
   * uitgummen.
   */
  it("A4 — er wordt uit precies twee tabellen verwijderd, en nooit uit ownership", () => {
    const DIRS = [
      ["owners"],
      ["buildings", "[id]", "lots"],
      ["buildings", "[id]", "indeling"],
    ];
    /** Elke `.delete()` met de tabel waar hij bij hoort. */
    const deletes = (bron: string): string[] => {
      const uit: string[] = [];
      for (const m of bron.matchAll(/\.delete\(\)/g)) {
        const daarvoor = bron.slice(0, m.index);
        const tabel = [...daarvoor.matchAll(/\.from\("([a-z_]+)"\)/g)].at(-1)?.[1];
        uit.push(tabel ?? "?");
      }
      return uit;
    };

    const gevonden: string[] = [];
    for (const map of DIRS) {
      for (const pad of alleBronnen(join(REPO, "src", "app", "[locale]", "(app)", ...map))) {
        const bron = readFileSync(pad, "utf8");
        for (const tabel of deletes(bron)) gevonden.push(`${tabel} @ ${pad}`);
        // Het lotsscherm zelf verwijdert niets; daar zit de eigendomsflow.
        if (map.includes("lots")) {
          expect(deletes(bron), `${pad}: het lotsscherm verwijdert niets`).toEqual([]);
        }
      }
    }

    const tabellen = [...new Set(gevonden.map((g) => g.split(" @ ")[0]))].sort();
    expect(tabellen, `gevonden deletes: ${gevonden.join(", ")}`).toEqual(["owners", "units"]);
    // En dus zeker niet: ownership.
    expect(tabellen).not.toContain("ownership");
  });
});

// ── NAVIGATIE ───────────────────────────────────────────────────────────────

describe("N — navigatie", () => {
  it("N1 — de nieuwe items staan in de navigatie", () => {
    expect(globalNavItems().map((i) => i.href)).toContain("/owners");
    expect(buildingNavItems("bid").map((i) => i.href)).toContain("/buildings/bid/lots");
  });

  it("N2 — elke href verwijst naar een BESTAANDE route", () => {
    for (const href of allNavHrefs("bid")) {
      const segmenten = href.split("/").filter(Boolean).map((s) => (s === "bid" ? "[id]" : s));
      const pad = join(REPO, "src", "app", "[locale]", "(app)", ...segmenten, "page.tsx");
      expect(() => statSync(pad), `dode link: ${href}`).not.toThrow();
    }
  });

  it("N3 — de kruimels van de eigenarenroute stoppen bij Copropriétaires", () => {
    const crumbs = buildBreadcrumbs({
      pathname: "/owners/abc",
      orgName: "Syndic Atlas",
      buildingName: null,
    });
    expect(crumbs.at(-1)?.labelKey).toBe("owners");
    expect(crumbs.at(-1)?.href).toBeNull();
  });

  it("N4 — de lotsroute krijgt een eigen kruimel binnen het gebouw", () => {
    const crumbs = buildBreadcrumbs({
      pathname: "/buildings/bid/lots",
      orgName: "Syndic Atlas",
      buildingName: "Résidence Atlas",
    });
    expect(crumbs.map((c) => c.labelKey ?? c.text)).toEqual([
      "Syndic Atlas",
      "buildings",
      "Résidence Atlas",
      "lots",
    ]);
  });
});

// ── VERTALINGEN ─────────────────────────────────────────────────────────────

describe("I — vertaalpariteit fr, nl en ar", () => {
  const talen: Record<string, unknown> = { fr, nl, ar };

  function sleutels(waarde: unknown, prefix = ""): string[] {
    if (typeof waarde !== "object" || waarde === null) return [prefix];
    return Object.entries(waarde as Record<string, unknown>).flatMap(([k, v]) =>
      sleutels(v, prefix ? `${prefix}.${k}` : k),
    );
  }

  it("I1 — owners, lots en nav hebben EXACT dezelfde sleutels in alle drie de talen", () => {
    for (const namespace of ["owners", "lots", "nav"]) {
      const perTaal = Object.entries(talen).map(([naam, berichten]) => ({
        naam,
        keys: sleutels((berichten as Record<string, unknown>)[namespace]).sort(),
      }));
      for (const taal of perTaal.slice(1)) {
        expect(taal.keys, `${namespace} in ${taal.naam}`).toEqual(perTaal[0].keys);
      }
    }
  });

  it("I2 — geen enkele waarde is leeg", () => {
    for (const [naam, berichten] of Object.entries(talen)) {
      for (const namespace of ["owners", "lots"]) {
        const blok = (berichten as Record<string, unknown>)[namespace];
        for (const sleutel of sleutels(blok)) {
          const waarde = sleutel
            .split(".")
            .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], blok);
          expect(typeof waarde, `${naam} ${namespace}.${sleutel}`).toBe("string");
          expect((waarde as string).trim().length, `${naam} ${namespace}.${sleutel}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("I3 — de interpolaties renderen met de echte ICU-pipeline", () => {
    const maak = createTranslator as unknown as (opties: {
      locale: string;
      messages: unknown;
      namespace: string;
    }) => (sleutel: string, waarden?: Record<string, string | number>) => string;

    for (const [naam, berichten] of Object.entries(talen)) {
      const tOwners = maak({ locale: naam, messages: berichten, namespace: "owners" });
      const tLots = maak({ locale: naam, messages: berichten, namespace: "lots" });

      const zoek = tOwners("search.none", { term: "Belkacem" });
      expect(zoek, naam).toContain("Belkacem");
      expect(zoek, naam).not.toContain("{");

      const sub = tLots("subtitle", { building: "Résidence Atlas" });
      expect(sub, naam).toContain("Résidence Atlas");
      expect(sub, naam).not.toContain("{");

      const sinds = tLots("ownership.since", { date: "02-09-2026" });
      expect(sinds, naam).toContain("02-09-2026");
      expect(sinds, naam).not.toContain("{");
    }
  });

  it("I4 — de nieuwe navigatielabels bestaan in alle drie de talen", () => {
    for (const [naam, berichten] of Object.entries(talen)) {
      const nav = (berichten as Record<string, Record<string, unknown>>).nav;
      expect(typeof nav.owners, `${naam} nav.owners`).toBe("string");
      expect(typeof nav.lots, `${naam} nav.lots`).toBe("string");
    }
  });
});

// ── RENDERVORM ──────────────────────────────────────────────────────────────

describe("D — geen overflowgevoelige of richtingsgebonden opmaak", () => {
  /**
   * De matchers staan op describe-niveau zodat D1 (die BESTANDEN scant) en D3
   * (die de MATCHER zelf toetst) dezelfde objecten gebruiken. Een kopie in de
   * test zou kunnen afdrijven van wat er werkelijk draait — dan bewaakt de
   * guard een regex die niemand meer uitvoert.
   */

  /** Breekpuntprefix eraf: `sm:-mr-1` wordt `-mr-1`. */
  const zonderBreekpunt = (token: string) => token.slice(token.lastIndexOf(":") + 1);

  const VASTE_BREEDTE = /^w-\[\d+px\]$/;
  // De `-?` is niet cosmetisch: `-ml-2` en `sm:-mr-1` zijn even fysiek als
  // hun positieve broers, maar beginnen met een koppelteken. Een anker op
  // `^` zonder die optie liet ze door — terwijl de oudere `\bml-`-variant
  // ze wél ving. Dat was een regressie, en hij is hier gerepareerd.
  const FYSIEK = /^-?(ml|mr|pl|pr)-|^text-(left|right)$|^border-(l|r)$/;

  /** Weigert D1 deze klasse? Exact de beslissing die D1 per token neemt. */
  const wordtGeweigerd = (klasse: string) => {
    const token = zonderBreekpunt(klasse);
    return VASTE_BREEDTE.test(token) || FYSIEK.test(token);
  };

  it("D1 — geen vaste pixelbreedtes of fysieke richtingen in de nieuwe schermen", () => {
    // ELK nieuw presentatiebestand in deze stroom hoort hier bij te komen, en
    // wel VOORDAT het wordt toegevoegd. Een bestand dat niet in deze lijst
    // staat wordt niet gescand, en dan valt de RTL-waarborg stil zonder dat
    // er iets rood wordt — precies het soort gat dat niemand opmerkt.
    const bestanden = [
      join(REPO, "src", "app", "[locale]", "(app)", "owners", "page.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "owners", "[owner_id]", "page.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "owners", "OwnerForm.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "page.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotForm.tsx"),
      join(
        REPO,
        "src",
        "app",
        "[locale]",
        "(app)",
        "buildings",
        "[id]",
        "lots",
        "OwnershipForms.tsx",
      ),
      join(REPO, "src", "components", "ui", "Empty.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "indeling", "page.tsx"),
      join(REPO, "src", "lib", "layout.ts"),
      join(REPO, "src", "lib", "blockErrors.ts"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "indeling", "actions.ts"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "indeling", "BlokBeheer.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "indeling", "BulkLots.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "indeling", "LotBewerken.tsx"),
      join(REPO, "src", "lib", "deleteErrors.ts"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "indeling", "LotVerwijderen.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "owners", "[owner_id]", "EigenaarVerwijderen.tsx"),
      join(REPO, "src", "lib", "wizard.ts"),
      join(REPO, "src", "lib", "paginate.ts"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "wizard", "page.tsx"),
      join(REPO, "src", "lib", "lots.ts"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotsStats.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotsToolbar.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotsTable.tsx"),
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotActions.tsx"),
    ];
    // De oorspronkelijke versie zocht letterlijk naar `className="..."`. Dat
    // mist ALLES wat via `cn(...)` loopt, en dat is precies hoe elke primitive
    // onder `components/ui` zijn klassen schrijft. Een bestand aan de lijst
    // toevoegen zonder dit te repareren zou een lege uitbreiding zijn: het
    // wordt dan wel ingelezen, maar er valt niets te vinden.
    //
    // Daarom: haal commentaar weg (toelichtingen CITEREN deze klassen) en
    // beoordeel elke losse token uit elke string, waar hij ook staat.
    const klasseTokens = (bron: string): string[] => {
      const kaal = bron
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const uit: string[] = [];
      // Zowel "..." als `...`: dit scherm schrijft klassen in beide vormen,
      // en een template literal is even fysiek als een gewone string.
      const strings = [
        ...[...kaal.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]),
        ...[...kaal.matchAll(/`([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, " ")),
      ];
      for (const str of strings) {
        for (const token of str.split(/\s+/)) {
          // Breekpuntprefixen doen er niet toe: `sm:ml-2` is even fysiek.
          if (token) uit.push(zonderBreekpunt(token));
        }
      }
      return uit;
    };

    for (const bestand of bestanden) {
      const bron = readFileSync(bestand, "utf8");
      expect(bron, bestand).not.toMatch(/style=\{\{[^}]*width:\s*\d/);

      const tokens = klasseTokens(bron);
      expect(tokens.filter((t) => VASTE_BREEDTE.test(t)), `${bestand}: vaste breedte`).toEqual([]);
      expect(tokens.filter((t) => FYSIEK.test(t)), `${bestand}: fysieke richting`).toEqual([]);
    }
  });

  it("D3 — de matcher zelf: fysiek eruit, logisch erin", () => {
    /**
     * Waarom deze test bestaat.
     *
     * D1 scant bestanden. Als de MATCHER stuk is, vindt D1 niets en wordt er
     * niets rood — de waarborg valt dan stil zonder enig signaal. Dat is in
     * deze stroom twee keer gebeurd: eerst zag hij alleen `className="..."`
     * en miste alles wat via `cn(...)` loopt, daarna liet het anker op `^`
     * de negatieve varianten door.
     *
     * Beide keren was het bewijs dat het gerepareerd was een HANDMATIGE
     * mutatietoets, en die leeft in een rapport, niet in de suite. Hier staat
     * dat bewijs permanent: wie de matcher versoepelt, krijgt deze test rood.
     *
     * Getoetst wordt `wordtGeweigerd` — exact de beslissing die D1 per token
     * neemt, met dezelfde prefix-stripping. Geen kopie van de regex.
     */
    const SLECHT = [
      "ml-2",
      "-ml-2",
      "sm:-mr-1",
      "pl-3",
      "pr-4",
      "sm:pr-4",
      "text-left",
      "text-right",
      "border-l",
      "border-r",
      "w-[320px]",
    ];

    // Logische tegenhangers: die spiegelen mee met de leesrichting en horen
    // juist NIET geweigerd te worden. Zonder deze helft zou een matcher die
    // domweg alles afkeurt de test óók halen.
    const GOED = [
      "ms-2",
      "me-2",
      "ps-4",
      "pe-4",
      "text-center",
      "border",
      "rounded-l-lg",
      "w-full",
    ];

    for (const klasse of SLECHT) {
      expect(wordtGeweigerd(klasse), `${klasse} hoort geweigerd te worden`).toBe(true);
    }
    for (const klasse of GOED) {
      expect(wordtGeweigerd(klasse), `${klasse} is richtingsneutraal en mag blijven`).toBe(false);
    }
  });

  it("D2 — elk formulierveld heeft een gekoppeld label", () => {
    // `Field` koppelt label en controle via id; deze test bewaakt dat de nieuwe
    // formulieren die wrapper gebruiken in plaats van een kaal input-element.
    for (const bestand of ["OwnerForm.tsx", "LotForm.tsx", "OwnershipForms.tsx"]) {
      const pad = bestand.startsWith("Owner") && bestand !== "OwnershipForms.tsx"
        ? join(REPO, "src", "app", "[locale]", "(app)", "owners", bestand)
        : join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", bestand);
      const bron = readFileSync(pad, "utf8");
      expect(bron, pad).toContain("<Field");
      expect(bron, pad).toContain("SubmitButton");
    }
  });
});

// ── MEDE-EIGENDOM VOLGENS DE ALLOCATION ENGINE ──────────────────────────────

/**
 * De engine, letterlijk. Uit `create_charge_call` (m20, regels 267 en 276):
 *
 *     WHERE ... o.owner_id IS NULL                   -> ALLOC_NO_OWNER
 *     WHERE ... o.n_active > 1 AND o.n_primary <> 1  -> ALLOC_AMBIGUOUS_OWNER
 *
 * Alles wat door geen van beide condities wordt geraakt, slaagt. Deze suite legt
 * dat vast als waarheidstabel, zodat de app-logica er niet ongemerkt van kan
 * afdrijven — de vorige versie deed dat wél en noemde élke gedeelde eigendom
 * financieel onveilig.
 */
describe("M — mede-eigendom: de app spiegelt de engine exact", () => {
  /**
   * Bouwt `aantal` actuele rijen waarvan `primair` er de debiteur zijn.
   *
   * De debiteuren staan bewust ACHTERAAN. Zetten we ze vooraan, dan is elke
   * assertie op "welke rij wordt de debiteur" triviaal waar — ook wanneer de
   * sorteervolgorde uit `fn_alloc_resolve_owner` helemaal niet zou worden
   * toegepast. Zo dwingt de fixture af dat `is_primary_debtor DESC` echt werkt.
   */
  function actief(aantal: number, primair: number): OwnershipRow[] {
    return Array.from({ length: aantal }, (_, i) =>
      own({
        id: `own-m-${aantal}-${primair}-${i}`,
        owner_id: `owner-${i}`,
        end_date: null,
        is_primary_debtor: i >= aantal - primair,
      }),
    );
  }

  it("M1 — geen actieve eigenaar: geen debiteur en niet toerekenbaar", () => {
    const rijen = actief(0, 0);
    const c = classifyOwnership(rijen);
    expect(c.nActive).toBe(0);
    expect(c.klasse).toBe("geenEigenaar");
    expect(c.debiteur).toBeNull();
    expect(c.toewijsbaar).toBe(false);
    expect(lotStatus(unit(), rijen)).toBe("zonderEigenaar");
    expect(
      tantiemeOverzicht([unit({ tantiemes: 1000 })], new Map(), 1000).oproepVeilig,
    ).toBe(false);
  });

  it("M2 — één actieve primaire eigenaar: gewoon toerekenbaar", () => {
    const rijen = actief(1, 1);
    const c = classifyOwnership(rijen);
    expect(c.klasse).toBe("enkel");
    expect(c.nPrimary).toBe(1);
    expect(c.toewijsbaar).toBe(true);
    expect(lotStatus(unit(), rijen)).toBe("compleet");

    const perUnit = new Map([[U1, rijen]]);
    const uit = tantiemeOverzicht([unit({ tantiemes: 1000 })], perUnit, 1000);
    expect(uit.oproepVeilig).toBe(true);
    expect(uit.medeEigendom).toBe(0);
    expect(uit.ambigu).toBe(0);
  });

  it("M3 — één actieve NIET-primaire eigenaar is toegestaan door de engine", () => {
    // Vastgelegd omdat het contra-intuïtief is. De ambiguïteitscontrole begint
    // bij `n_active > 1`; bij één actieve rij wordt `n_primary` niet eens
    // gewogen, en `fn_alloc_resolve_owner` retourneert die ene rij. De oproep
    // slaagt dus. Dat is mogelijk onbedoeld in de engine, maar het IS het
    // gedrag; de UI mag er niet voor waarschuwen alsof het faalt.
    const rijen = actief(1, 0);
    const c = classifyOwnership(rijen);
    expect(c.nActive).toBe(1);
    expect(c.nPrimary).toBe(0);
    expect(c.klasse).toBe("enkel");
    expect(c.toewijsbaar).toBe(true);
    expect(c.debiteur?.id).toBe(rijen[0].id);
    expect(lotStatus(unit(), rijen)).toBe("compleet");

    const uit = tantiemeOverzicht(
      [unit({ tantiemes: 1000 })],
      new Map([[U1, rijen]]),
      1000,
    );
    expect(uit.oproepVeilig).toBe(true);
  });

  it("M4 — twee actieve eigenaars met exact één debiteur: GELDIG", () => {
    // De kern van de bevinding. Dit is geen fout maar een ondersteunde
    // toestand: de volledige last gaat naar de aangewezen debiteur.
    const rijen = actief(2, 1);
    const c = classifyOwnership(rijen);
    expect(c.nActive).toBe(2);
    expect(c.nPrimary).toBe(1);
    expect(c.klasse).toBe("medeEigendom");
    expect(c.toewijsbaar).toBe(true);
    expect(c.debiteur?.is_primary_debtor).toBe(true);
    // owner-1 is de LAATSTE rij; dat de classificatie hem toch kiest bewijst
    // dat `is_primary_debtor DESC` uit de verdeelmotor daadwerkelijk wordt
    // toegepast en niet simpelweg de eerste rij wordt gepakt.
    expect(c.debiteur?.owner_id).toBe("owner-1");
    expect(rijen[0].is_primary_debtor).toBe(false);
    expect(lotStatus(unit(), rijen)).toBe("medeEigendom");

    const uit = tantiemeOverzicht(
      [unit({ tantiemes: 1000 })],
      new Map([[U1, rijen]]),
      1000,
    );
    expect(uit.medeEigendom).toBe(1);
    expect(uit.ambigu).toBe(0);
    expect(uit.eigendomVeilig).toBe(true);
    expect(uit.oproepVeilig).toBe(true); // <- was onterecht false
  });

  it("M5 — twee actieve eigenaars ZONDER debiteur: ambigu en onveilig", () => {
    const rijen = actief(2, 0);
    const c = classifyOwnership(rijen);
    expect(c.nPrimary).toBe(0);
    expect(c.klasse).toBe("ambigu");
    expect(c.toewijsbaar).toBe(false);
    expect(lotStatus(unit(), rijen)).toBe("ambigu");

    const uit = tantiemeOverzicht(
      [unit({ tantiemes: 1000 })],
      new Map([[U1, rijen]]),
      1000,
    );
    expect(uit.ambigu).toBe(1);
    expect(uit.medeEigendom).toBe(0);
    expect(uit.eigendomVeilig).toBe(false);
    expect(uit.oproepVeilig).toBe(false);
  });

  it("M6 — twee actieve eigenaars die BEIDE debiteur zijn: ambigu", () => {
    // `n_primary = 2` voldoet aan `n_primary <> 1`, dus de engine weigert. m30
    // hoort deze toestand op databaseniveau te verhinderen via
    // ownership_primary_active_idx en ownership_primary_period_excl; de
    // app-logica moet hem toch correct classificeren voor het geval een
    // privileged pad hem alsnog aanmaakt.
    const rijen = actief(2, 2);
    const c = classifyOwnership(rijen);
    expect(c.nPrimary).toBe(2);
    expect(c.klasse).toBe("ambigu");
    expect(c.toewijsbaar).toBe(false);
    expect(lotStatus(unit(), rijen)).toBe("ambigu");
  });

  it("M7 — geldige mede-eigendom met scheve tantièmes blijft onveilig OM DE TANTIÈMES", () => {
    const rijen = actief(2, 1);
    const c = classifyOwnership(rijen);
    expect(c.klasse).toBe("medeEigendom"); // eigendom is NIET het probleem

    const uit = tantiemeOverzicht(
      [unit({ id: U1, tantiemes: 400 }), unit({ id: U2, tantiemes: 100 })],
      new Map([
        [U1, rijen],
        [U2, actief(1, 1).map((r) => ({ ...r, id: `${r.id}-u2` }))],
      ]),
      1000,
    );
    expect(uit.eigendomVeilig).toBe(true); // eigendom in orde
    expect(uit.tantiemesKloppen).toBe(false); // tantièmes niet
    expect(uit.verschil).toBe(-500);
    expect(uit.oproepVeilig).toBe(false); // onveilig, maar om de juiste reden
  });

  it("M8 — de waarheidstabel volgt letterlijk n_active en n_primary", () => {
    // Elke rij is een directe vertaling van:
    //   owner_id IS NULL            -> ALLOC_NO_OWNER
    //   n_active > 1 AND n_primary <> 1 -> ALLOC_AMBIGUOUS_OWNER
    const tabel: Array<[number, number, OwnershipClass, boolean]> = [
      [0, 0, "geenEigenaar", false],
      [1, 0, "enkel", true],
      [1, 1, "enkel", true],
      [2, 0, "ambigu", false],
      [2, 1, "medeEigendom", true],
      [2, 2, "ambigu", false],
      [3, 0, "ambigu", false],
      [3, 1, "medeEigendom", true],
      [3, 2, "ambigu", false],
      [3, 3, "ambigu", false],
    ];
    for (const [nActive, nPrimary, klasse, toewijsbaar] of tabel) {
      const c = classifyOwnership(actief(nActive, nPrimary));
      const waar = `n_active=${nActive} n_primary=${nPrimary}`;
      expect(c.nActive, waar).toBe(nActive);
      expect(c.nPrimary, waar).toBe(nPrimary);
      expect(c.klasse, waar).toBe(klasse);
      expect(c.toewijsbaar, waar).toBe(toewijsbaar);
      // Het complement van de twee SQL-condities, onafhankelijk nagerekend:
      const sqlWeigert = nActive === 0 || (nActive > 1 && nPrimary !== 1);
      expect(c.toewijsbaar, `${waar} tegenover de SQL`).toBe(!sqlWeigert);
    }
  });

  it("M9 — gesloten perioden tellen niet mee in de classificatie", () => {
    // Alle drie de rijen moeten in de database kunnen bestaan: end_date mag
    // nooit vóór start_date liggen (CHECK ownership_check), en twee perioden van
    // dezelfde primaire debiteur mogen elkaar niet overlappen (m30).
    const rijen = [
      own({
        id: "oud-1",
        owner_id: "owner-x",
        start_date: "2024-01-01",
        end_date: "2024-12-31",
      }),
      own({
        id: "oud-2",
        owner_id: "owner-y",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      }),
      own({ id: "nu", owner_id: "owner-z", start_date: "2026-01-01", end_date: null }),
    ];
    const c = classifyOwnership(rijen);
    expect(c.nActive).toBe(1);
    expect(c.klasse).toBe("enkel");
    expect(c.debiteur?.id).toBe("nu");
  });

  it("M10 — eigendom en tantièmes worden APART geteld", () => {
    // Een gedeeld lot met tantième nul moet in BEIDE emmers vallen. De vorige
    // versie telde elk lot in precies één emmer via lotStatus en verloor
    // daardoor het tantièmeprobleem van een gedeeld lot volledig.
    const uit = tantiemeOverzicht(
      [unit({ id: U1, tantiemes: 0 })],
      new Map([[U1, actief(2, 1)]]),
      0,
    );
    expect(uit.medeEigendom).toBe(1);
    expect(uit.zonderTantieme).toBe(1);
    expect(uit.eigendomVeilig).toBe(true);
    expect(uit.tantiemesKloppen).toBe(true);
    // De EIGENDOM blokkeert niet — dat is de kern van deze test. Het lot is wél
    // onvolledig: een tantième van nul geeft ALLOC_WEIGHT_MISSING zodra het lot
    // meedoet, dus de gebouwbrede gereedheid is onwaar. Twee losse oordelen.
    expect(uit.oproepVeilig).toBe(false);
    // De statusbadge toont het tantièmeprobleem; de eigenaarskolom toont de
    // gedeelde eigendom. Zie de precedentie in lotStatus.
    expect(lotStatus(unit({ tantiemes: 0 }), actief(2, 1))).toBe("zonderTantieme");
  });

  it("M11 — de statusbadge onderscheidt geldige van ambigue mede-eigendom", () => {
    expect(lotStatus(unit(), actief(2, 1))).toBe("medeEigendom");
    expect(lotStatus(unit(), actief(2, 0))).toBe("ambigu");
    // En ambigu weegt zwaarder dan een tantièmeprobleem: de oproep faalt dan al.
    expect(lotStatus(unit({ tantiemes: 0 }), actief(2, 0))).toBe("ambigu");
  });

  it("M11b — de app oordeelt over NU; op de laatste dag van een periode wijkt de engine af", () => {
    // Bewust vastgelegd, niet gerepareerd. De app telt "actueel"
    // (end_date IS NULL); de engine telt "actief op p_call_date"
    // (end_date >= p_call_date). Op de LAATSTE dag van een aflopende periode
    // ziet de engine dus één eigenaar meer dan het scherm.
    const laatsteDag = "2026-09-03";
    const aflopend = own({
      id: "aflopend",
      owner_id: "owner-oud",
      start_date: "2026-01-01",
      end_date: laatsteDag,
      is_primary_debtor: false,
    });
    const nieuw = own({
      id: "nieuw",
      owner_id: "owner-nieuw",
      start_date: laatsteDag,
      end_date: null,
      is_primary_debtor: false,
    });

    // Wat het SCHERM ziet: één actuele rij, dus "enkel" en toerekenbaar.
    const c = classifyOwnership([aflopend, nieuw]);
    expect(c.nActive).toBe(1);
    expect(c.klasse).toBe("enkel");
    expect(c.toewijsbaar).toBe(true);

    // Wat de ENGINE op die dag ziet: beide rijen actief, geen debiteur.
    const actiefVolgensEngine = [aflopend, nieuw].filter((r) => isActiveOn(r, laatsteDag));
    expect(actiefVolgensEngine).toHaveLength(2);
    const nPrimary = actiefVolgensEngine.filter((r) => r.is_primary_debtor).length;
    expect(nPrimary).toBe(0);
    // n_active > 1 AND n_primary <> 1 -> ALLOC_AMBIGUOUS_OWNER
    expect(actiefVolgensEngine.length > 1 && nPrimary !== 1).toBe(true);

    // Daarom formuleren de schermteksten zich als HUIDIGE stand en beloven ze
    // niets over een oproep met een andere call_date.
    expect(nl.lots.tantiemes.warningOwnership).toContain("Op dit moment");
  });

  it("M12 — de teksten bestaan in fr, nl en ar en noemen geen SQL of tabelnamen", () => {
    const talen: Record<string, unknown> = { fr, nl, ar };
    const sleutels = [
      "status.ambigu",
      "primaryDebtor",
      "tantiemes.warningOwnership",
      "tantiemes.warningTantiemes",
      "tantiemes.coOwnershipNote",
      "ownership.coOwned",
      "ownership.ambiguous",
    ];
    for (const [naam, berichten] of Object.entries(talen)) {
      const lots = (berichten as Record<string, unknown>).lots;
      for (const sleutel of sleutels) {
        const waarde = sleutel
          .split(".")
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], lots) as string;
        expect(typeof waarde, `${naam} lots.${sleutel}`).toBe("string");
        expect(waarde.trim().length, `${naam} lots.${sleutel}`).toBeGreaterThan(0);
        // Geen technische namen op het scherm.
        expect(waarde, `${naam} lots.${sleutel}`).not.toMatch(
          /n_active|n_primary|is_primary_debtor|charge_call|ownership|ALLOC_|SQL/i,
        );
      }
    }
  });

  it("M13 — de nieuwe teksten renderen met de echte ICU-pipeline", () => {
    const maak = createTranslator as unknown as (opties: {
      locale: string;
      messages: unknown;
      namespace: string;
    }) => (sleutel: string, waarden?: Record<string, string | number>) => string;

    for (const [naam, berichten] of Object.entries({ fr, nl, ar })) {
      const t = maak({ locale: naam, messages: berichten, namespace: "lots" });
      for (const count of [0, 1, 2, 3, 11]) {
        const zin = t("tantiemes.coOwnershipNote", { count });
        expect(zin.length, `${naam} count=${count}`).toBeGreaterThan(0);
        expect(zin, `${naam} count=${count}`).not.toContain("{");
      }
      const gedeeld = t("ownership.coOwned", { debiteur: "Yassine Belkacem" });
      expect(gedeeld, naam).toContain("Yassine Belkacem");
      expect(gedeeld, naam).not.toContain("{");
    }
  });

  it("M14 — geldige mede-eigendom levert GEEN foutwaarschuwing op het scherm", () => {
    // De pagina toont de waarschuwing alleen bij !oproepVeilig, en kiest dan
    // tussen een eigendoms- en een tantièmetekst. Bij uitsluitend geldige
    // mede-eigendom blijft ze dus weg.
    const uit = tantiemeOverzicht(
      [unit({ id: U1, tantiemes: 1000 })],
      new Map([[U1, actief(2, 1)]]),
      1000,
    );
    expect(uit.oproepVeilig).toBe(true);
    expect(uit.medeEigendom).toBe(1);

    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotsStats.tsx"),
      "utf8",
    );
    // Drie ONAFHANKELIJKE condities, elk met een eigen blok; geen ternary die er
    // maar één van kan tonen. De toelichting hangt aan medeEigendom.
    expect(bron).toContain("!overzicht.eigendomVeilig");
    expect(bron).toContain("overzicht.zonderTantieme > 0");
    expect(bron).toContain("!overzicht.tantiemesKloppen");
    expect(bron).toContain("overzicht.medeEigendom > 0");
    expect(bron).toContain("tantiemes.coOwnershipNote");
    // En de oude ongedifferentieerde waarschuwing bestaat niet meer.
    expect(bron).not.toContain('t("tantiemes.warning")');
  });
});

// ── OVERDRAAGBAARHEID EN DATUMGRENZEN ───────────────────────────────────────

/**
 * `transferability()` spiegelt de vooraf kenbare precondities van
 * `transfer_ownership`. Elke tak hier komt overeen met één weigering van de RPC:
 *
 *     OWNERSHIP_NO_CURRENT · OWNERSHIP_COOWNED · OWNERSHIP_NOT_PRIMARY
 *     OWNERSHIP_NOT_FULL   · OWNERSHIP_DATE_NOT_AFTER_START
 *     OWNERSHIP_DATE_FUTURE
 *
 * Het doel is niet beveiliging — de RPC blijft de grens — maar voorkomen dat het
 * scherm een formulier aanbiedt waarvan vooraf vaststaat dat het wordt geweigerd.
 */
describe("TR — overdraagbaarheid", () => {
  const VANDAAG = "2026-09-03";

  it("TR1 — één volledige primaire eigenaar, begonnen vóór vandaag: toegestaan", () => {
    const rijen = [own({ start_date: "2026-01-01", is_primary_debtor: true, share: 1 })];
    const uit = transferability(rijen, VANDAAG);
    expect(uit.allowed).toBe(true);
    if (uit.allowed) {
      expect(uit.current.id).toBe(rijen[0].id);
      expect(uit.minDate).toBe("2026-01-02");
      expect(uit.maxDate).toBe(VANDAAG);
    }
  });

  it("TR2 — één NIET-primaire eigenaar: geen formulier, eigen reden", () => {
    const rijen = [own({ start_date: "2026-01-01", is_primary_debtor: false })];
    const uit = transferability(rijen, VANDAAG);
    expect(uit.allowed).toBe(false);
    if (!uit.allowed) {
      expect(uit.reason).toBe("nietPrimair");
      expect(uit.current?.id).toBe(rijen[0].id);
    }
    // De toestand is toerekenbaar; alleen deze flow ondersteunt hem niet.
    expect(classifyOwnership(rijen).toewijsbaar).toBe(true);
  });

  it("TR3 — één GEDEELTELIJK aandeel: geen formulier, eigen reden", () => {
    const rijen = [own({ start_date: "2026-01-01", is_primary_debtor: true, share: 0.5 })];
    const uit = transferability(rijen, VANDAAG);
    expect(uit.allowed).toBe(false);
    if (!uit.allowed) expect(uit.reason).toBe("gedeeltelijkAandeel");
    expect(classifyOwnership(rijen).toewijsbaar).toBe(true);
  });

  it("TR3b — een aandeel als tekst telt net zo goed als een getal", () => {
    // PostgREST levert `numeric` als string; "0.5" mag niet stil als 1 gelden.
    const rijen = [own({ start_date: "2026-01-01", share: "0.5" })];
    const uit = transferability(rijen, VANDAAG);
    expect(uit.allowed).toBe(false);
    if (!uit.allowed) expect(uit.reason).toBe("gedeeltelijkAandeel");

    const heel = transferability([own({ start_date: "2026-01-01", share: "1" })], VANDAAG);
    expect(heel.allowed).toBe(true);
  });

  it("TR4 — eigendom die VANDAAG begon heeft geen geldige overdrachtsdatum", () => {
    // De datum moet ná start_date liggen én mag niet in de toekomst; op de dag
    // van ingang is dat venster leeg. Een formulier tonen zou gegarandeerd
    // OWNERSHIP_DATE_NOT_AFTER_START opleveren.
    const rijen = [own({ start_date: VANDAAG })];
    const uit = transferability(rijen, VANDAAG);
    expect(uit.allowed).toBe(false);
    if (!uit.allowed) expect(uit.reason).toBe("vandaagBegonnen");
    // Het venster is aantoonbaar leeg: min ligt ná max.
    expect(addDays(VANDAAG, 1) > VANDAAG).toBe(true);
  });

  it("TR5 — minimum is exact start_date + 1, maximum is vandaag, default ertussen", () => {
    const rijen = [own({ start_date: "2026-08-31" })];
    const uit = transferability(rijen, VANDAAG);
    expect(uit.allowed).toBe(true);
    if (uit.allowed) {
      expect(uit.minDate).toBe("2026-09-01");
      expect(uit.maxDate).toBe("2026-09-03");
      expect(uit.defaultDate >= uit.minDate).toBe(true);
      expect(uit.defaultDate <= uit.maxDate).toBe(true);
    }
  });

  it("TR5b — één dag verschil is genoeg: gisteren begonnen mag vandaag over", () => {
    const gisteren = addDays(VANDAAG, -1);
    const uit = transferability([own({ start_date: gisteren })], VANDAAG);
    expect(uit.allowed).toBe(true);
    if (uit.allowed) {
      expect(uit.minDate).toBe(VANDAAG);
      expect(uit.maxDate).toBe(VANDAAG);
      expect(uit.defaultDate).toBe(VANDAAG);
    }
  });

  it("TR6 — geen actuele eigenaar of ambigue eigendom: geen formulier", () => {
    const geen = transferability([own({ end_date: "2026-05-31" })], VANDAAG);
    expect(geen.allowed).toBe(false);
    if (!geen.allowed) expect(geen.reason).toBe("geenEigenaar");

    const ambigu = transferability(
      [
        own({ owner_id: O1, is_primary_debtor: false }),
        own({ owner_id: O2, is_primary_debtor: false }),
      ],
      VANDAAG,
    );
    expect(ambigu.allowed).toBe(false);
    if (!ambigu.allowed) expect(ambigu.reason).toBe("ambigu");
  });

  it("TR7 — geldige mede-eigendom blijft read-only maar is WEL toerekenbaar", () => {
    const rijen = [
      own({ owner_id: O1, is_primary_debtor: false }),
      own({ owner_id: O2, is_primary_debtor: true }),
    ];
    const uit = transferability(rijen, VANDAAG);
    expect(uit.allowed).toBe(false);
    if (!uit.allowed) {
      expect(uit.reason).toBe("medeEigendom");
      // De aangewezen debiteur wordt meegegeven, zodat het scherm hem kan noemen.
      expect(uit.current?.owner_id).toBe(O2);
    }
    // En dit is expliciet GEEN allocatieprobleem.
    expect(classifyOwnership(rijen).toewijsbaar).toBe(true);
    const overzicht = tantiemeOverzicht(
      [unit({ id: U1, tantiemes: 1000 })],
      new Map([[U1, rijen]]),
      1000,
    );
    expect(overzicht.eigendomVeilig).toBe(true);
    expect(overzicht.oproepVeilig).toBe(true);
  });
});

describe("DT — datumrekenkunde", () => {
  it("DT1 — maandeinde", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-04-30", 1)).toBe("2026-05-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // 2026 is geen schrikkeljaar
  });

  it("DT2 — jaargrens", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("DT3 — schrikkeljaar", () => {
    // 2028 is een schrikkeljaar, 2100 niet (deelbaar door 100, niet door 400).
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDays("2100-02-28", 1)).toBe("2100-03-01");
    expect(addDays("2000-02-28", 1)).toBe("2000-02-29"); // deelbaar door 400
  });

  it("DT4 — nul dagen laat de datum ongemoeid en de vorm intact", () => {
    expect(addDays("2026-09-03", 0)).toBe("2026-09-03");
    expect(addDays("2026-01-05", 0)).toBe("2026-01-05"); // voorloopnullen blijven
  });

  it("DT5 — geen tijdzoneverschuiving: het resultaat is stabiel", () => {
    // Een implementatie met `new Date(iso).getDate()` schuift in een tijdzone
    // achter UTC een dag terug. Deze reeks zou dan uiteenlopen.
    let d = "2026-01-01";
    for (let i = 0; i < 365; i += 1) d = addDays(d, 1);
    expect(d).toBe("2027-01-01");
  });
});

describe("GR — gebouwbrede gereedheid", () => {
  it("GR1 — een lot met tantième nul maakt het gebouw NIET gereed", () => {
    // Ook wanneer het totaal toevallig klopt: ALLOC_WEIGHT_MISSING vuurt op het
    // lot zelf, niet op de som.
    const units = [unit({ id: U1, tantiemes: 1000 }), unit({ id: U2, tantiemes: 0 })];
    const perUnit = new Map([
      [U1, [own({ unit_id: U1 })]],
      [U2, [own({ unit_id: U2, owner_id: O2 })]],
    ]);
    const uit = tantiemeOverzicht(units, perUnit, 1000);
    expect(uit.tantiemesKloppen).toBe(true); // 1000 + 0 === 1000
    expect(uit.eigendomVeilig).toBe(true);
    expect(uit.zonderTantieme).toBe(1);
    expect(uit.oproepVeilig).toBe(false); // <- was ten onrechte true
  });

  it("GR2 — zonder tantièmeprobleem en zonder eigendomsprobleem is het gebouw gereed", () => {
    const units = [unit({ id: U1, tantiemes: 600 }), unit({ id: U2, tantiemes: 400 })];
    const perUnit = new Map([
      [U1, [own({ unit_id: U1 })]],
      [U2, [own({ unit_id: U2, owner_id: O2 })]],
    ]);
    const uit = tantiemeOverzicht(units, perUnit, 1000);
    expect(uit.zonderTantieme).toBe(0);
    expect(uit.oproepVeilig).toBe(true);
  });

  it("GR3 — eigendomsprobleem ÉN tantièmeprobleem zijn tegelijk zichtbaar", () => {
    // Het gebouw heeft een ambigu lot, een lot met tantième nul, en een som die
    // het règlement niet haalt. Alle drie moeten los afleesbaar zijn.
    const units = [
      unit({ id: U1, tantiemes: 400 }),
      unit({ id: U2, tantiemes: 0 }),
      unit({ id: U3, tantiemes: 100 }),
    ];
    const perUnit = new Map([
      [
        U1,
        [
          own({ unit_id: U1, owner_id: O1, is_primary_debtor: false }),
          own({ unit_id: U1, owner_id: O2, is_primary_debtor: false }),
        ],
      ],
      [U2, [own({ unit_id: U2, owner_id: O1 })]],
      [U3, [own({ unit_id: U3, owner_id: O2 })]],
    ]);
    const uit = tantiemeOverzicht(units, perUnit, 1000);

    expect(uit.ambigu).toBe(1);
    expect(uit.eigendomVeilig).toBe(false);
    expect(uit.zonderTantieme).toBe(1);
    expect(uit.tantiemesKloppen).toBe(false);
    expect(uit.verschil).toBe(-500);
    expect(uit.oproepVeilig).toBe(false);

    // De pagina rendert deze drie als ONAFHANKELIJKE blokken; een ternary zou er
    // maar één kunnen tonen en de andere twee verzwijgen.
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotsStats.tsx"),
      "utf8",
    );
    expect(bron).not.toMatch(/overzicht\.eigendomVeilig\s*\n?\s*\?\s*t\("tantiemes/);
    for (const conditie of [
      "!overzicht.eigendomVeilig",
      "overzicht.zonderTantieme > 0",
      "!overzicht.tantiemesKloppen",
    ]) {
      expect(bron, conditie).toContain(conditie);
    }
  });

  it("GR4 — role=alert alleen voor de onvoorwaardelijk blokkerende meldingen", () => {
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotsStats.tsx"),
      "utf8",
    );
    // Het controletotaal kent in de engine een gedocumenteerde afwijking
    // (partial_denominator_until_year) en is dus geen absolute blokkade.
    const tantiemeBlok = bron.slice(
      bron.indexOf("!overzicht.tantiemesKloppen"),
      bron.indexOf("overzicht.medeEigendom > 0"),
    );
    expect(tantiemeBlok).toContain('role="status"');
    expect(tantiemeBlok).not.toContain('role="alert"');
  });
});

describe("BL — blokkadeteksten", () => {
  const talen: Record<string, unknown> = { fr, nl, ar };
  const sleutels = [
    "ownership.notPrimary",
    "ownership.partialShare",
    "ownership.tooRecent",
    "transfer.dateRange",
    "tantiemes.warningZeroTantieme",
  ];

  it("BL1 — alle nieuwe sleutels bestaan paritair in fr, nl en ar", () => {
    for (const [naam, berichten] of Object.entries(talen)) {
      const lots = (berichten as Record<string, unknown>).lots;
      for (const sleutel of sleutels) {
        const waarde = sleutel
          .split(".")
          .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], lots) as string;
        expect(typeof waarde, `${naam} lots.${sleutel}`).toBe("string");
        expect(waarde.trim().length, `${naam} lots.${sleutel}`).toBeGreaterThan(0);
      }
    }
  });

  it("BL2 — geen RPC-, tabel- of foutcodenamen in de blokkadeteksten", () => {
    for (const [naam, berichten] of Object.entries(talen)) {
      const lots = (berichten as Record<string, Record<string, unknown>>).lots;
      const ownership = lots.ownership as Record<string, string>;
      for (const sleutel of ["notPrimary", "partialShare", "tooRecent", "ambiguous", "coOwned"]) {
        expect(ownership[sleutel], `${naam} ${sleutel}`).not.toMatch(
          /OWNERSHIP_|ALLOC_|transfer_ownership|link_first_owner|is_primary_debtor|n_active|n_primary|charge_call|SQL/i,
        );
      }
    }
  });

  it("BL3 — de nieuwe teksten renderen met de echte ICU-pipeline", () => {
    const maak = createTranslator as unknown as (opties: {
      locale: string;
      messages: unknown;
      namespace: string;
    }) => (sleutel: string, waarden?: Record<string, string | number>) => string;

    for (const [naam, berichten] of Object.entries(talen)) {
      const t = maak({ locale: naam, messages: berichten, namespace: "lots" });
      const venster = t("transfer.dateRange", { min: "2026-01-02", max: "2026-09-03" });
      expect(venster, naam).toContain("2026-01-02");
      expect(venster, naam).toContain("2026-09-03");
      expect(venster, naam).not.toContain("{");

      for (const count of [0, 1, 2, 3, 11]) {
        const zin = t("tantiemes.warningZeroTantieme", { count });
        expect(zin.length, `${naam} count=${count}`).toBeGreaterThan(0);
        expect(zin, `${naam} count=${count}`).not.toContain("{");
      }
    }
  });

  it("BL4 — elke blokkadereden heeft een tekst en het formulier krijgt grenzen", () => {
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "LotActions.tsx"),
      "utf8",
    );
    for (const reden of [
      "geenEigenaar",
      "medeEigendom",
      "ambigu",
      "nietPrimair",
      "gedeeltelijkAandeel",
      "vandaagBegonnen",
    ]) {
      expect(bron, reden).toContain(`${reden}:`);
    }
    // Het formulier verschijnt uitsluitend achter de poort.
    expect(bron).toContain("overdracht.allowed ?");
    expect(bron).not.toContain("klassering.nActive === 1 ? lopend[0]");

    const formulier = readFileSync(
      join(
        REPO,
        "src",
        "app",
        "[locale]",
        "(app)",
        "buildings",
        "[id]",
        "lots",
        "OwnershipForms.tsx",
      ),
      "utf8",
    );
    expect(formulier).toContain("min={minDate}");
    expect(formulier).toContain("max={maxDate}");
    expect(formulier).toContain("defaultValue={defaultDate}");
  });
});

/**
 * Review finding (PR #10): de legacy gebouwpagina behandelde "geen actuele
 * eigenaar" altijd als "nog nooit gekoppeld" en toonde het `assignOwner`-
 * formulier ook voor een lot met uitsluitend AFGESLOTEN historische rijen.
 * `link_first_owner` weigert die aanroep terecht met OWNERSHIP_HISTORY_EXISTS,
 * dus dat formulier kon nooit slagen. `ownerFormState` maakt het onderscheid
 * dat de pagina miste; deze suite bewijst de classificatie zelf en dat de
 * pagina hem daadwerkelijk gebruikt om het formulier te verbergen.
 */
describe("OFS — ownerFormState (legacy gebouwpagina)", () => {
  const eigenaar = { id: "o1", full_name: "Jamal" };

  it("nul historische rijen → 'geen': het eerste-koppelingsformulier hoort zichtbaar te zijn", () => {
    expect(ownerFormState([])).toBe("geen");
  });

  it("uitsluitend afgesloten historie → 'historieZonderEigenaar': geen formulier", () => {
    expect(
      ownerFormState([
        { end_date: "2025-06-30", owners: eigenaar },
        { end_date: "2024-01-15", owners: eigenaar },
      ]),
    ).toBe("historieZonderEigenaar");
  });

  it("precies één actuele rij → 'eenEigenaar'", () => {
    expect(
      ownerFormState([
        { end_date: "2024-01-15", owners: eigenaar },
        { end_date: null, owners: eigenaar },
      ]),
    ).toBe("eenEigenaar");
  });

  it("meerdere actuele rijen → 'ambigu'", () => {
    expect(
      ownerFormState([
        { end_date: null, owners: eigenaar },
        { end_date: null, owners: eigenaar },
      ]),
    ).toBe("ambigu");
  });

  it("een rij waarvan de eigenaar niet resolveert telt niet mee als actueel", () => {
    // Verdedigend: zonder gekoppelde eigenaar is er niets zinvols te tonen of
    // over te dragen, ook al is end_date null.
    expect(ownerFormState([{ end_date: null, owners: null }])).toBe("historieZonderEigenaar");
  });

  it("de legacy pagina gebruikt ownerFormState om het formulier te poorten, niet !currentOwner(u)", () => {
    const bron = readFileSync(
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "page.tsx"),
      "utf8",
    );
    expect(bron).toContain('status === "geen"');
    expect(bron).toContain('status === "historieZonderEigenaar"');
    expect(bron).toContain("ownerFormState(u.ownership");
    expect(bron).toContain("ownership.historyOnly");
    // De oorspronkelijke, te ruime poort mag niet terugkomen.
    expect(bron).not.toContain("!currentOwner(u) && owners.length > 0 && (");
  });

  it("de melding is beschikbaar in fr, nl en ar", () => {
    for (const [naam, berichten] of Object.entries({ fr, nl, ar })) {
      const lots = (berichten as Record<string, unknown>).lots as
        | { ownership?: { historyOnly?: string } }
        | undefined;
      expect(lots?.ownership?.historyOnly, `lots.ownership.historyOnly ontbreekt in ${naam}`).toBeTruthy();
    }
  });
});

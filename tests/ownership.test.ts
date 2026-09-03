import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTranslator } from "next-intl";
import {
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
  ownerScopes,
  ownershipErrorKey,
  periodsOverlap,
  requiresRefresh,
  sortHistory,
  tantiemeOverzicht,
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

  it("A4 — er zijn geen verwijderknoppen voor eigenaren, lots of eigendom", () => {
    for (const map of ["owners", join("buildings", "[id]", "lots")]) {
      const dir = join(REPO, "src", "app", "[locale]", "(app)", ...map.split(/[\\/]/));
      for (const pad of alleBronnen(dir)) {
        const bron = readFileSync(pad, "utf8");
        expect(/\.delete\(\)/.test(bron), `${pad} bevat een delete`).toBe(false);
      }
    }
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
  it("D1 — geen vaste pixelbreedtes of fysieke richtingen in de nieuwe schermen", () => {
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
    ];
    for (const bestand of bestanden) {
      const bron = readFileSync(bestand, "utf8");
      expect(bron, bestand).not.toMatch(/className="[^"]*\bw-\[\d+px\]/);
      expect(bron, bestand).not.toMatch(/style=\{\{[^}]*width:\s*\d/);
      expect(bron, bestand).not.toMatch(
        /className="[^"]*\b(ml-|mr-|pl-|pr-|text-left|text-right|border-l\b|border-r\b)/,
      );
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
    // De conclusie waar het om gaat: gedeelde eigendom met een aangewezen
    // debiteur blokkeert een oproep NIET, ook niet met een tantième van nul.
    expect(uit.oproepVeilig).toBe(true);
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
      join(REPO, "src", "app", "[locale]", "(app)", "buildings", "[id]", "lots", "page.tsx"),
      "utf8",
    );
    // De waarschuwing hangt aan oproepVeilig, de toelichting aan medeEigendom.
    expect(bron).toContain("!overzicht.oproepVeilig");
    expect(bron).toContain("overzicht.medeEigendom > 0");
    expect(bron).toContain("tantiemes.coOwnershipNote");
    // En de oude ongedifferentieerde waarschuwing bestaat niet meer.
    expect(bron).not.toContain('t("tantiemes.warning")');
  });
});

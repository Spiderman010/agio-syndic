// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

/**
 * De verwijdersectie op de detailpagina van een eigenaar.
 *
 * Alleen COMPOSITIE: wie krijgt de tussenstap te zien, wanneer verschijnt de
 * bevestiging, en met welke gegevens. Wat de actie doet staat in
 * `tests/delete-lot-owner.test.ts`.
 *
 * WAT HIER NIET WORDT BEWEZEN: hoe dit eruitziet. jsdom doet geen layout en
 * evalueert geen media queries; over de RTL-spiegeling zegt geen assertie hier
 * iets.
 */

const ORG = "org-1";
const EIG = "77777777-7777-7777-7777-777777777777";
const LOT = "55555555-5555-5555-5555-555555555555";
const BLD = "11111111-1111-1111-1111-111111111111";

type Resultaat = { data: unknown; error: unknown };

const state: { tabellen: Record<string, Resultaat>; rol: string } = {
  tabellen: {},
  rol: "manager",
};

function standaard(): Record<string, Resultaat> {
  return {
    owners: {
      data: {
        id: EIG,
        full_name: "Youssef El Amrani",
        is_company: false,
        email: null,
        phone: null,
        language: "fr",
        is_mre: false,
      },
      error: null,
    },
    ownership: {
      data: [
        {
          id: "ow1",
          unit_id: LOT,
          owner_id: EIG,
          share: 1,
          start_date: "2026-01-01",
          end_date: null,
          is_primary_debtor: true,
        },
      ],
      error: null,
    },
    units: {
      data: [
        { id: LOT, building_id: BLD, label: "A-01", unit_type: "appartement", tantiemes: 100 },
      ],
      error: null,
    },
    buildings: { data: [{ id: BLD, name: "Résidence Atlas" }], error: null },
  };
}

function keten(resultaat: Resultaat) {
  const c: Record<string, unknown> = {};
  const zelf = () => c;
  Object.assign(c, {
    select: zelf,
    eq: zelf,
    in: zelf,
    order: zelf,
    maybeSingle: async () => resultaat,
    then: (res: (v: Resultaat) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resultaat).then(res, rej),
  });
  return c;
}

vi.mock("next-intl/server", () => ({
  getTranslations: async (ns?: string) => (key: string, waarden?: Record<string, unknown>) => {
    const basis = ns ? `${ns}.${key}` : key;
    return waarden ? `${basis}(${Object.values(waarden).join(",")})` : basis;
  },
  getLocale: async () => "fr",
}));

vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => {
    const fn = (key: string, waarden?: Record<string, unknown>) => {
      const basis = ns ? `${ns}.${key}` : key;
      return waarden ? `${basis}(${Object.values(waarden).join(",")})` : basis;
    };
    return Object.assign(fn, { rich: fn, markup: fn, raw: fn, has: () => true });
  },
  useLocale: () => "fr",
}));

vi.mock("@/lib/org", () => ({
  requireOrg: async () => ({ role: state.rol, org: { id: ORG, name: "Org" } }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabel: string) => keten(state.tabellen[tabel] ?? { data: [], error: null }),
  }),
}));

vi.mock("@/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Async server components en client forms: hier gaat het om de compositie.
vi.mock("../src/app/[locale]/(app)/owners/[owner_id]/EigenaarVerwijderen", () => ({
  default: ({
    ownerId,
    naam,
    aantalKoppelingen,
  }: {
    ownerId: string;
    naam: string;
    aantalKoppelingen: number;
  }) => (
    <div
      data-testid="stub-eigenaar-verwijderen"
      data-owner={ownerId}
      data-naam={naam}
      data-koppelingen={aantalKoppelingen}
    />
  ),
}));
vi.mock("../src/app/[locale]/(app)/owners/OwnerForm", () => ({
  default: () => <div data-testid="stub-owner-form" />,
}));
vi.mock("../src/app/[locale]/(app)/owners/actions", () => ({
  updateOwner: async () => undefined,
  deleteOwner: async () => undefined,
}));

import OwnerDetailPage from "../src/app/[locale]/(app)/owners/[owner_id]/page";

async function toon(zoek: { verwijder?: string } = {}) {
  return render(
    await OwnerDetailPage({
      params: Promise.resolve({ locale: "fr", owner_id: EIG }),
      searchParams: Promise.resolve(zoek),
    }),
  );
}

beforeEach(() => {
  state.rol = "manager";
  state.tabellen = standaard();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("O — de verwijdersectie", () => {
  it("O1 — een schrijver ziet de tussenstap, nog niet de bevestiging", async () => {
    await toon();
    expect(screen.getByTestId("owner-verwijder-start")).toBeTruthy();
    expect(screen.queryByTestId("stub-eigenaar-verwijderen")).toBeNull();
  });

  it("O2 — de tussenstap wijst naar de bevestiging op deze pagina", async () => {
    await toon();
    expect(screen.getByTestId("owner-verwijder-start").getAttribute("href")).toBe(
      `/owners/${EIG}?verwijder=1#owner-verwijder-paneel`,
    );
  });

  it("O3 — een LEZER ziet de hele sectie niet", async () => {
    state.rol = "reader";
    await toon();
    expect(screen.queryByTestId("owner-verwijder-start")).toBeNull();
    expect(screen.queryByTestId("stub-eigenaar-verwijderen")).toBeNull();
    expect(document.querySelector("#owner-verwijder-paneel")).toBeNull();
  });

  it("O4 — ?verwijder=1 opent de bevestiging en haalt de tussenstap weg", async () => {
    await toon({ verwijder: "1" });
    expect(screen.getByTestId("stub-eigenaar-verwijderen")).toBeTruthy();
    // De tussenstap is vervangen, niet verdubbeld: één ding op het scherm.
    expect(screen.queryByTestId("owner-verwijder-start")).toBeNull();
  });

  it("O5 — de bevestiging krijgt naam en aantal koppelingen mee", async () => {
    await toon({ verwijder: "1" });
    const paneel = screen.getByTestId("stub-eigenaar-verwijderen");
    expect(paneel.getAttribute("data-owner")).toBe(EIG);
    expect(paneel.getAttribute("data-naam")).toBe("Youssef El Amrani");
    // Eén ownership-rij in de fixture: dat is wat er meeverdwijnt.
    expect(paneel.getAttribute("data-koppelingen")).toBe("1");
  });

  it("O6 — een LEZER krijgt geen bevestiging, ook niet met de parameter", async () => {
    state.rol = "reader";
    await toon({ verwijder: "1" });
    expect(screen.queryByTestId("stub-eigenaar-verwijderen")).toBeNull();
  });

  it("O7 — een andere parameterwaarde opent niets", async () => {
    for (const waarde of ["0", "ja", "true", ""]) {
      cleanup();
      await toon({ verwijder: waarde });
      expect(screen.queryByTestId("stub-eigenaar-verwijderen"), waarde).toBeNull();
      expect(screen.getByTestId("owner-verwijder-start"), waarde).toBeTruthy();
    }
  });

  it("O8 — bij een onbekende eigenaar is er niets te verwijderen", async () => {
    state.tabellen.owners = { data: null, error: null };
    await toon({ verwijder: "1" });
    expect(screen.queryByTestId("owner-verwijder-start")).toBeNull();
    expect(screen.queryByTestId("stub-eigenaar-verwijderen")).toBeNull();
  });

  it("O9 — bij een STORING is er niets te verwijderen", async () => {
    state.tabellen.ownership = {
      data: null,
      error: { code: "42501", message: 'permission denied for table "ownership" — Atlas' },
    };
    await toon({ verwijder: "1" });
    expect(screen.queryByTestId("stub-eigenaar-verwijderen")).toBeNull();
    expect(screen.queryByTestId("owner-verwijder-start")).toBeNull();
  });
});

describe("I — de vertalingen van het verwijderen", () => {
  const TALEN: Array<[string, Record<string, unknown>]> = [
    ["fr", fr as Record<string, unknown>],
    ["nl", nl as Record<string, unknown>],
    ["ar", ar as Record<string, unknown>],
  ];

  const sleutelsVan = (o: Record<string, unknown>, pad = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? sleutelsVan(v as Record<string, unknown>, `${pad}${k}.`)
        : [`${pad}${k}`],
    );

  const deel = (berichten: Record<string, unknown>, pad: string[]) =>
    pad.reduce<Record<string, unknown>>(
      (o, k) => (o?.[k] ?? {}) as Record<string, unknown>,
      berichten,
    );

  it("I5 — owners.delete heeft in alle drie de talen dezelfde sleutels", () => {
    const [, eerste] = TALEN[0];
    const verwacht = sleutelsVan(deel(eerste, ["owners", "delete"])).sort();
    expect(verwacht.length).toBeGreaterThan(5);
    for (const [naam, berichten] of TALEN) {
      expect(sleutelsVan(deel(berichten, ["owners", "delete"])).sort(), naam).toEqual(verwacht);
    }
  });

  it("I6 — de drie foutsleutels bestaan in alle drie de talen", () => {
    for (const [naam, berichten] of TALEN) {
      const indelingErrors = deel(berichten, ["indeling", "errors"]);
      const ownerErrors = deel(berichten, ["owners", "errors"]);
      expect(typeof indelingErrors.lotHasHistory, `${naam} lotHasHistory`).toBe("string");
      expect(typeof ownerErrors.ownerHasHistory, `${naam} ownerHasHistory`).toBe("string");
      expect(typeof ownerErrors.ownerHasPayments, `${naam} ownerHasPayments`).toBe("string");
    }
  });

  it("I7 — de twee eigenaarsmeldingen zijn VERSCHILLEND in elke taal", () => {
    // Vorderingen en betalingen zijn twee verschillende situaties; dezelfde zin
    // tweemaal zou de gebruiker niet vertellen wat er aan de hand is.
    for (const [naam, berichten] of TALEN) {
      const e = deel(berichten, ["owners", "errors"]);
      expect(e.ownerHasHistory, naam).not.toBe(e.ownerHasPayments);
    }
  });

  it("I8 — de interpolaties overleven de vertaling", () => {
    for (const [naam, berichten] of TALEN) {
      const d = deel(berichten, ["owners", "delete"]);
      expect(String(d.title), `${naam} title`).toContain("{name}");
      expect(String(d.cascade), `${naam} cascade`).toContain("{count}");
      const m = deel(berichten, ["indeling", "manage"]);
      expect(String(m.deleteLotTitle), `${naam} deleteLotTitle`).toContain("{label}");
    }
  });

  it("I9 — het Arabisch is daadwerkelijk Arabisch schrift", () => {
    const arabisch = /[؀-ۿ]/;
    const d = deel(ar as Record<string, unknown>, ["owners", "delete"]);
    for (const [sleutel, waarde] of Object.entries(d)) {
      if (typeof waarde !== "string" || !/\p{L}/u.test(waarde)) continue;
      expect(arabisch.test(waarde), `owners.delete.${sleutel}: ${waarde}`).toBe(true);
    }
  });

  it("I10 — geen onvertaalde kopie tussen fr en nl", () => {
    const frD = deel(fr as Record<string, unknown>, ["owners", "delete"]);
    const nlD = deel(nl as Record<string, unknown>, ["owners", "delete"]);
    for (const sleutel of Object.keys(frD)) {
      const a = String(frD[sleutel]);
      const b = String(nlD[sleutel]);
      // Alleen meerwoordige, letterhoudende waarden: "…" is in elke taal "…".
      if (!/\p{L}/u.test(a) || a.trim().split(/\s+/).length < 2) continue;
      expect(b, `owners.delete.${sleutel} is niet vertaald`).not.toBe(a);
    }
  });
});

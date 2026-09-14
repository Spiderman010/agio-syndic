import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Review finding (PR #10): `building_id` en `unit_id` werden afzonderlijk
 * tegen dezelfde organisatie gecontroleerd, wat niet bewijst dat het lot bij
 * het meegegeven gebouw hoort. Een gemanipuleerd formulier kon daardoor
 * `building_id` van gebouw A combineren met `unit_id` van gebouw B binnen
 * dezelfde organisatie, gebouw B muteren via `link_first_owner` of
 * `transfer_ownership`, en daarna gebouw A revalideren/redirecten.
 *
 * Deze suite bewijst dat `assertUnitInOrg` nu ook `building_id` verifieert en
 * dat een mismatch nooit de RPC bereikt — voor de eerste koppeling, de
 * overdracht, en de legacy `assignOwner`-actie.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "99999999-9999-9999-9999-999999999999";
const BUILDING_A = "22222222-2222-2222-2222-222222222222";
const BUILDING_B = "33333333-3333-3333-3333-333333333333";
const UNIT = "44444444-4444-4444-4444-444444444444";
const OWNER = "55555555-5555-5555-5555-555555555555";
const EXPECTED_OWNERSHIP = "66666666-6666-6666-6666-666666666666";

type Row = { data: Record<string, unknown> | null; error: unknown };

const state: {
  activeOrg: { role: string; org: { id: string; name: string } } | null;
  rows: Record<string, Row>;
  rpcCalls: { name: string; params: Record<string, unknown> }[];
  rpcResult: { error: { code?: string; message?: string } | null };
  revalidated: string[];
} = {
  activeOrg: null,
  rows: {},
  rpcCalls: [],
  rpcResult: { error: null },
  revalidated: [],
};

vi.mock("@/lib/org", () => ({
  requireOrg: async () => state.activeOrg,
}));

vi.mock("@/lib/roles", () => ({
  canWrite: () => true,
}));

vi.mock("@/lib/redirect", () => ({
  localeRedirect: async (href: string) => {
    throw new Error(`REDIRECT:${href}`);
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    state.revalidated.push(p);
  },
}));

// Zelfde aanpak als tests/reversal-actions.test.ts: de vertaalfunctie geeft de
// sleutel terug, zodat we de foutafhandeling testen zonder aan Franse zinnen
// vast te zitten.
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "fr",
}));

// `from(table)` geeft per tabel een eigen rij terug — building-, unit- en
// owner-guard bevragen elk een andere tabel binnen dezelfde actie.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => state.rows[table] ?? { data: null, error: null },
      };
      return chain;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      state.rpcCalls.push({ name, params });
      return state.rpcResult;
    },
  }),
}));

const { linkFirstOwner, transferOwnership } = await import(
  "@/app/[locale]/(app)/buildings/[id]/lots/actions"
);
const { assignOwner } = await import("@/app/[locale]/(app)/buildings/[id]/actions");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

function setBuilding(orgId: string) {
  state.rows.buildings = { data: { organization_id: orgId }, error: null };
}
function setUnit(unitBuildingId: string, orgId: string) {
  state.rows.units = {
    data: { id: UNIT, building_id: unitBuildingId, buildings: { organization_id: orgId } },
    error: null,
  };
}
function setOwner(orgId: string) {
  state.rows.owners = { data: { organization_id: orgId }, error: null };
}

beforeEach(() => {
  state.activeOrg = { role: "manager", org: { id: ORG, name: "Org" } };
  state.rows = {};
  state.rpcCalls = [];
  state.rpcResult = { error: null };
  state.revalidated = [];
  setBuilding(ORG);
  setOwner(ORG);
});

describe("linkFirstOwner — het lot moet bij het opgegeven gebouw horen", () => {
  test("geldig lot in het opgegeven gebouw → RPC wordt aangeroepen", async () => {
    setUnit(BUILDING_A, ORG);
    await expect(
      linkFirstOwner(
        fd({ building_id: BUILDING_A, unit_id: UNIT, owner_id: OWNER, start_date: "2026-01-01" }),
      ),
    ).rejects.toThrow(/^REDIRECT:/);

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("link_first_owner");
  });

  test("lot van een ANDER gebouw binnen dezelfde organisatie → geen RPC", async () => {
    setUnit(BUILDING_B, ORG); // unit hoort bij gebouw B; formulier claimt gebouw A
    const r = await linkFirstOwner(
      fd({ building_id: BUILDING_A, unit_id: UNIT, owner_id: OWNER, start_date: "2026-01-01" }),
    );
    expect(r?.error).toBe("forbidden");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("lot van een ANDERE organisatie → geen RPC", async () => {
    setUnit(BUILDING_A, OTHER_ORG);
    const r = await linkFirstOwner(
      fd({ building_id: BUILDING_A, unit_id: UNIT, owner_id: OWNER, start_date: "2026-01-01" }),
    );
    expect(r?.error).toBe("forbidden");
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("transferOwnership — het lot moet bij het opgegeven gebouw horen", () => {
  const payload = (buildingId: string) => ({
    building_id: buildingId,
    unit_id: UNIT,
    expected_ownership_id: EXPECTED_OWNERSHIP,
    new_owner_id: OWNER,
    transfer_date: "2026-01-02",
  });

  test("geldig lot in het opgegeven gebouw → RPC wordt aangeroepen", async () => {
    setUnit(BUILDING_A, ORG);
    await expect(transferOwnership(fd(payload(BUILDING_A)))).rejects.toThrow(/^REDIRECT:/);

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("transfer_ownership");
  });

  test("lot van een ANDER gebouw binnen dezelfde organisatie → geen RPC", async () => {
    setUnit(BUILDING_B, ORG);
    const r = await transferOwnership(fd(payload(BUILDING_A)));
    expect(r?.error).toBe("forbidden");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("lot van een ANDERE organisatie → geen RPC", async () => {
    setUnit(BUILDING_A, OTHER_ORG);
    const r = await transferOwnership(fd(payload(BUILDING_A)));
    expect(r?.error).toBe("forbidden");
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("assignOwner (legacy) — eveneens fail-closed op gebouwmismatch", () => {
  test("geldig lot in het opgegeven gebouw → RPC wordt aangeroepen", async () => {
    setUnit(BUILDING_A, ORG);
    await expect(
      assignOwner(fd({ building_id: BUILDING_A, unit_id: UNIT, owner_id: OWNER })),
    ).rejects.toThrow(/^REDIRECT:/);

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("link_first_owner");
  });

  test("lot van een ANDER gebouw binnen dezelfde organisatie → geen RPC", async () => {
    setUnit(BUILDING_B, ORG);
    const r = await assignOwner(fd({ building_id: BUILDING_A, unit_id: UNIT, owner_id: OWNER }));
    expect(r?.error).toBe("forbidden");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("lot van een ANDERE organisatie → geen RPC", async () => {
    setUnit(BUILDING_A, OTHER_ORG);
    const r = await assignOwner(fd({ building_id: BUILDING_A, unit_id: UNIT, owner_id: OWNER }));
    expect(r?.error).toBe("forbidden");
    expect(state.rpcCalls).toHaveLength(0);
  });
});

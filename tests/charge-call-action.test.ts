import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * `createChargeCall` — de Server Action die geld vastlegt.
 *
 * De database blijft de security boundary: `create_charge_call` toetst
 * `can_write` zelf, SECURITY DEFINER, op basis van `auth.uid()`. Wat deze
 * suite vastlegt is de applicatielaag eromheen: dat een leesrol de RPC niet
 * bereikt, dat een gemanipuleerd gebouw-, boekjaar- of regel-id nooit tot een
 * aanroep leidt, dat een geldige aanvraag exact ÉÉN RPC doet, en dat er nooit
 * rauwe Nederlandse enginetekst naar de gebruiker lekt.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const ORG = "11111111-1111-1111-1111-111111111111";
const ANDERE_ORG = "99999999-9999-9999-9999-999999999999";
const GEBOUW_A = "22222222-2222-2222-2222-222222222222";
const GEBOUW_B = "33333333-3333-3333-3333-333333333333";
const FY = "44444444-4444-4444-4444-444444444444";
const REGEL = "55555555-5555-5555-5555-555555555555";

type Rij = { data: Record<string, unknown> | null; error: unknown };

const state: {
  activeOrg: { role: string; org: { id: string; name: string } } | null;
  rows: Record<string, Rij>;
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
  getActiveOrg: async () => state.activeOrg,
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

// De vertaalfunctie geeft de SLEUTEL terug. Zo zien we meteen of er per
// ongeluk rauwe databasetekst wordt doorgegeven in plaats van een sleutel.
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "fr",
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
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

const { createChargeCall } = await import(
  "@/app/[locale]/(app)/buildings/[id]/boekjaren/actions"
);

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

/** Een volledig geldig formulier voor gebouw A. */
function geldig(over: Record<string, string> = {}): FormData {
  return fd({
    building_id: GEBOUW_A,
    fiscal_year_id: FY,
    type: "regulier",
    total_amount: "1200.00",
    call_date: "2026-06-30",
    ...over,
  });
}

function zetBoekjaar(orgId = ORG, buildingId = GEBOUW_A, status = "open") {
  state.rows.fiscal_years = {
    data: { organization_id: orgId, building_id: buildingId, status },
    error: null,
  };
}

function zetRegel(buildingId = GEBOUW_A, status = "active") {
  state.rows.allocation_rules = { data: { building_id: buildingId, status }, error: null };
}

beforeEach(() => {
  state.activeOrg = { role: "manager", org: { id: ORG, name: "Org" } };
  state.rows = {};
  state.rpcCalls = [];
  state.rpcResult = { error: null };
  state.revalidated = [];
  zetBoekjaar();
  zetRegel();
});

describe("RL — rolcontrole", () => {
  test("RL1 — een viewer bereikt de RPC niet, ook niet via een directe aanroep", async () => {
    state.activeOrg = { role: "viewer", org: { id: ORG, name: "Org" } };
    const r = await createChargeCall(geldig());
    expect(r?.error).toBe("forbidden");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("RL2 — elke rol zonder schrijfrecht wordt geweigerd", async () => {
    for (const rol of ["viewer", "guest", "onbekend"]) {
      state.rpcCalls = [];
      state.activeOrg = { role: rol, org: { id: ORG, name: "Org" } };
      const r = await createChargeCall(geldig());
      expect(r?.error, rol).toBe("forbidden");
      expect(state.rpcCalls, rol).toHaveLength(0);
    }
  });

  test("RL3 — elke schrijfrol komt wél door de rolpoort", async () => {
    for (const rol of ["owner", "admin", "manager", "accountant"]) {
      state.rpcCalls = [];
      state.activeOrg = { role: rol, org: { id: ORG, name: "Org" } };
      await expect(createChargeCall(geldig())).rejects.toThrow(/^REDIRECT:/);
      expect(state.rpcCalls, rol).toHaveLength(1);
    }
  });
});

describe("SC — scope van gebouw, boekjaar en regel", () => {
  test("SC1 — een boekjaar van een andere organisatie start geen RPC", async () => {
    zetBoekjaar(ANDERE_ORG, GEBOUW_A);
    const r = await createChargeCall(geldig());
    expect(r?.error).toBe("fiscalYearNotFound");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("SC2 — een onbekend boekjaar start geen RPC", async () => {
    state.rows.fiscal_years = { data: null, error: null };
    const r = await createChargeCall(geldig());
    expect(r?.error).toBe("fiscalYearNotFound");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("SC3 — een gemanipuleerd building_id start geen RPC", async () => {
    // Het boekjaar hoort bij gebouw B; het formulier claimt gebouw A.
    zetBoekjaar(ORG, GEBOUW_B);
    const r = await createChargeCall(geldig({ building_id: GEBOUW_A }));
    expect(r?.error).toBe("fiscalYearNotFound");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("SC4 — een verdeelregel van een ander gebouw start geen RPC", async () => {
    zetRegel(GEBOUW_B);
    const r = await createChargeCall(geldig({ allocation_rule_id: REGEL }));
    expect(r?.error).toBe("ruleWrongBuilding");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("SC5 — een onbekende verdeelregel start geen RPC", async () => {
    state.rows.allocation_rules = { data: null, error: null };
    const r = await createChargeCall(geldig({ allocation_rule_id: REGEL }));
    expect(r?.error).toBe("ruleNotFound");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("SC6 — een niet-actieve verdeelregel start geen RPC", async () => {
    zetRegel(GEBOUW_A, "draft");
    const r = await createChargeCall(geldig({ allocation_rule_id: REGEL }));
    expect(r?.error).toBe("ruleInactive");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("SC7 — een gesloten boekjaar start geen RPC", async () => {
    zetBoekjaar(ORG, GEBOUW_A, "closed");
    const r = await createChargeCall(geldig());
    expect(r?.error).toBe("fiscalYearClosed");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("SC8 — zonder gekozen regel wordt de regelcontrole overgeslagen: de database kiest", async () => {
    state.rows.allocation_rules = { data: null, error: null };
    await expect(createChargeCall(geldig())).rejects.toThrow(/^REDIRECT:/);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].params.p_allocation_rule_id).toBeNull();
  });
});

describe("RPC — precies één aanroep met precies de juiste parameters", () => {
  test("RPC1 — een geldige aanvraag roept exact één keer create_charge_call aan", async () => {
    await expect(
      createChargeCall(
        geldig({
          period: "T2 2026",
          label: "Entretien ascenseur",
          due_date: "2026-07-31",
          allocation_rule_id: REGEL,
        }),
      ),
    ).rejects.toThrow(/^REDIRECT:/);

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("create_charge_call");
    expect(state.rpcCalls[0].params).toEqual({
      p_fiscal_year_id: FY,
      p_type: "regulier",
      p_total_amount: 1200,
      p_call_date: "2026-06-30",
      p_due_date: "2026-07-31",
      p_period: "T2 2026",
      p_label: "Entretien ascenseur",
      p_resolution_ref: null,
      p_allocation_rule_id: REGEL,
      p_manual_lines: null,
    });
    expect(state.revalidated.length).toBeGreaterThan(0);
  });

  test("RPC2 — handmatige bedragen gaan ongewijzigd mee als centregels", async () => {
    await expect(
      createChargeCall(geldig({ "manual_unit-a": "600,00", "manual_unit-b": "600.00" })),
    ).rejects.toThrow(/^REDIRECT:/);

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].params.p_manual_lines).toEqual([
      { unit_id: "unit-a", amount_cents: 60000 },
      { unit_id: "unit-b", amount_cents: 60000 },
    ]);
  });

  test("RPC3 — een ongeldig handmatig bedrag start geen RPC", async () => {
    const r = await createChargeCall(geldig({ "manual_unit-a": "zeshonderd" }));
    expect(r?.error).toBe("manualInvalidNumber");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("RPC4 — validatiefouten starten geen RPC", async () => {
    const r = await createChargeCall(fd({ fiscal_year_id: FY, total_amount: "0", call_date: "2026-06-30" }));
    expect(r?.error).toBeTruthy();
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("FT — foutvertaling van de engine", () => {
  test("FT1 — een ALLOC-code wordt een vertaalsleutel, geen databasetekst", async () => {
    state.rpcResult = {
      error: {
        code: "23514",
        message:
          "ALLOC_NO_OWNER: deze lots hebben geen eigenaar op 30-06-2026: A3, B2. Leg de eigenaar vast.",
      },
    };
    const r = await createChargeCall(geldig());
    expect(r?.error).toBe("noOwner");
  });

  test("FT2 — geen enkele Nederlandse enginezin of lotlabel lekt naar de gebruiker", async () => {
    const meldingen = [
      "ALLOC_WEIGHT_MISSING: deze deelnemende lots hebben geen tantième: A3. Vul die in of sluit ze uit.",
      "ALLOC_CONTROL_TOTAL: de som van de tantièmes van de deelnemende lots (980) wijkt af van de vastgestelde tantièmes van het gebouw (1000).",
      "ALLOC_MANUAL_SUM: de handmatige bedragen tellen op tot 900.00 MAD, de lastenoproep is 1200.00 MAD. Verschil 300.00 MAD.",
    ];
    for (const message of meldingen) {
      state.rpcCalls = [];
      state.rpcResult = { error: { code: "23514", message } };
      const r = await createChargeCall(geldig());
      expect(r?.error, message).not.toMatch(/deze|lots|tantième|MAD|wijkt/i);
      expect(r?.error, message).not.toContain("A3");
      expect(r?.error, message).not.toContain("ALLOC_");
    }
  });

  test("FT3 — een onbekende databasefout valt terug op de generieke sleutel", async () => {
    state.rpcResult = {
      error: { code: "42501", message: 'permission denied for table charge_calls' },
    };
    const r = await createChargeCall(geldig());
    expect(r?.error).toBe("generic");
  });

  test("FT4 — er wordt geen SQLSTATE of constraintnaam getoond", async () => {
    state.rpcResult = {
      error: { code: "23505", message: 'duplicate key value violates unique constraint "cc_pkey"' },
    };
    const r = await createChargeCall(geldig());
    expect(r?.error).toBe("generic");
    expect(r?.error).not.toContain("cc_pkey");
    expect(r?.error).not.toContain("23505");
  });
});

describe("UI — de aanmaakactie is achter schrijfrecht gezet", () => {
  const pagina = readFileSync(
    join(
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
    ),
    "utf8",
  );

  test("UI1 — de workflow verschijnt alleen met schrijfrecht en een open boekjaar", () => {
    expect(pagina).toContain('mayWrite && fy.status === "open"');
    expect(pagina).toContain("canWrite(role)");
  });

  test("UI2 — de workflow verschijnt alleen wanneer zijn eigen bronnen goed zijn geladen", () => {
    // De poort van de aanmaakworkflow staat LOS van die van de weergave: een
    // fout in units/rules/gewichten/eigendom blokkeert het formulier, maar
    // verbergt de reeds vastgelegde oproepen niet.
    expect(pagina).toContain("workflowOk ?");
    expect(pagina).not.toContain("bronnenOk");
    const poort = /const workflowOk =([\s\S]*?);/.exec(pagina);
    expect(poort).not.toBeNull();
    const bronnen = poort![1];
    for (const bron of [
      "unitsRes.error",
      "rulesRes.error",
      "ruleUnitsRes.error",
      "ruleWeightsRes.error",
      "ownershipRes.error",
    ]) {
      expect(bronnen, bron).toContain(bron);
    }
    // En juist NIET de financiële bronnen: die hebben hun eigen poort.
    expect(bronnen).not.toContain("callsError");
    expect(bronnen).not.toContain("linesRes");
    expect(bronnen).not.toContain("allocError");
  });

  test("UI4 — de pagina leest de stornostatus met de STRIKTE helper", () => {
    // `fetchReversalIndex()` is de fail-open variant en vertaalt een leesfout
    // naar een lege index. Op dit scherm hangt daar een storno-/correctieknop
    // aan; hier hoort uitsluitend de variant die de foutstatus meegeeft.
    expect(pagina).toContain("fetchReversalIndexResult");
    expect(pagina).not.toMatch(/\bfetchReversalIndex\b(?!Result)/);

    // En de foutstatus wordt ook werkelijk gebruikt, niet alleen uitgepakt.
    expect(pagina).toMatch(/const reversalsOk = !reversalError;/);
    expect(pagina).toMatch(/const actionStatusOk = !journalError;/);
  });

  test("UI5 — het formulier voor een nieuwe betaling hangt aan alle financiële bronnen", () => {
    const poort = /const paymentFormOk =([\s\S]*?);/.exec(pagina);
    expect(poort).not.toBeNull();
    const bronnen = poort![1];
    for (const bron of ["ownersOk", "paymentsOk", "callsOk", "saldoOk"]) {
      expect(bronnen, bron).toContain(bron);
    }
    expect(bronnen).toContain('fy.status === "open"');
  });

  test("UI3 — de oude, hardgecodeerde Franse labels zijn weg", () => {
    expect(pagina).not.toContain("parts égales");
    expect(pagina).not.toContain("tout le bâtiment");
    expect(pagina).not.toContain("Nouvel appel de charges");
  });
});


// ── m31: de databasecode bereikt de gebruiker als begrijpelijke tekst ───────

describe("M31 — ALLOC_CALL_DATE_OUTSIDE_FY door de foutvertaling", () => {
  /**
   * Een REALISTISCH Supabase/PostgREST-foutobject voor een RAISE EXCEPTION uit
   * een RPC. De app-check is UX; als een race of een omzeiling de trigger toch
   * laat aanslaan, moet de gebruiker dezelfde begrijpelijke melding krijgen en
   * niet de ruwe code.
   */
  beforeEach(() => {
    zetBoekjaar();
    zetRegel();
  });

  const POSTGREST_FOUT = {
    message:
      "ALLOC_CALL_DATE_OUTSIDE_FY: oproepdatum valt buiten de periode van het boekjaar",
    code: "23514",
  };

  test("M31a — het foutobject van de RPC mapt op de vertaalsleutel", async () => {
    state.rpcResult = { error: POSTGREST_FOUT };
    const uit = await createChargeCall(geldig());
    expect(uit?.error).toBe("callDateOutsideFy");
    // Nooit de ruwe code of de databasetekst.
    expect(uit?.error).not.toContain("ALLOC_");
    expect(uit?.error).not.toContain("23514");
  });

  test("M31b — de NULL-variant van dezelfde code krijgt dezelfde melding", async () => {
    // m31 kent twee meldingen onder één code; beide moeten landen op dezelfde
    // sleutel, want de gebruiker hoeft dat onderscheid niet te kennen.
    state.rpcResult = {
      error: { ...POSTGREST_FOUT, message: "ALLOC_CALL_DATE_OUTSIDE_FY: oproepdatum of boekjaarperiode ontbreekt" },
    };
    const uit = await createChargeCall(geldig());
    expect(uit?.error).toBe("callDateOutsideFy");
  });

  test("M31c — de oudertrigger-melding met een aantal valt op dezelfde sleutel", async () => {
    state.rpcResult = {
      error: {
        ...POSTGREST_FOUT,
        message:
          "ALLOC_CALL_DATE_OUTSIDE_FY: de nieuwe periode laat 2 vastgelegde lastenoproep(en) buiten het boekjaar vallen",
      },
    };
    const uit = await createChargeCall(geldig());
    expect(uit?.error).toBe("callDateOutsideFy");
  });
});

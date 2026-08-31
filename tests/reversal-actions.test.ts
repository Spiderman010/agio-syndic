import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * S1, S5–S11 — de server actions.
 *
 * De database is hier gemockt. Dat is bewust: de financiële invarianten worden
 * bewezen door de SQL-suites onder `supabase/tests` (223 tests) en worden hier
 * NIET nagebouwd. Wat hier wordt vastgelegd is precies wat de applicatielaag
 * belooft: sessiecontrole, validatie, tenantcontrole, exact één RPC-aanroep met
 * exact de juiste parameters, en dat er nooit een database-object of rauwe
 * PostgreSQL-tekst naar de client lekt.
 */

const UUID = "3f8c1a52-9b7e-4d21-8a30-6c5f2e1d4b09";
const OTHER_ORG_UUID = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ORG = "11111111-1111-1111-1111-111111111111";
const BUILDING = "22222222-2222-2222-2222-222222222222";
const reason = "Bedrag verkeerd overgenomen uit het bankbestand";

// --- mocks -----------------------------------------------------------------

const state: {
  activeOrg: { role: string; org: { id: string; name: string } } | null;
  row: { data: Record<string, unknown> | null; error: unknown };
  rpcResult: { error: { code?: string; message?: string } | null };
  rpcCalls: { name: string; params: Record<string, unknown> }[];
  revalidated: string[];
} = {
  activeOrg: null,
  row: { data: null, error: null },
  rpcResult: { error: null },
  rpcCalls: [],
  revalidated: [],
};

vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => state.activeOrg,
  requireOrg: async () => state.activeOrg,
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

// De vertaalfunctie geeft de SLEUTEL terug. Zo testen we de foutafhandeling
// zonder aan Franse zinnen vast te zitten, en zien we meteen of er per ongeluk
// een rauwe databasetekst wordt doorgegeven in plaats van een sleutel.
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "fr",
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => state.row,
      };
      return chain;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      state.rpcCalls.push({ name, params });
      return state.rpcResult;
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null }),
      }),
    },
  }),
}));

const { reversePayment, correctPayment } = await import(
  "@/app/[locale]/buildings/[id]/boekjaren/actions"
);
const { reverseExpense, correctExpense } = await import(
  "@/app/[locale]/buildings/[id]/expenses/actions"
);

// --- helpers ---------------------------------------------------------------

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

function signedIn(role = "manager") {
  state.activeOrg = { role, org: { id: ORG, name: "Org" } };
  state.row = {
    data: { id: UUID, organization_id: ORG, building_id: BUILDING, account_id: null, receipt_path: null },
    error: null,
  };
}

beforeEach(() => {
  state.activeOrg = null;
  state.row = { data: null, error: null };
  state.rpcResult = { error: null };
  state.rpcCalls = [];
  state.revalidated = [];
});

// --- tests -----------------------------------------------------------------

describe("S1 — zonder sessie", () => {
  test("reversePayment wordt geblokkeerd en raakt de database niet", async () => {
    const r = await reversePayment(fd({ payment_id: UUID, reason }));
    expect(r.error).toBe("errors.notAuthenticated");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("correctPayment, reverseExpense en correctExpense idem", async () => {
    expect((await correctPayment(fd({ payment_id: UUID, amount: "800", value_date: "2026-04-10", method: "virement", reason }))).error)
      .toBe("errors.notAuthenticated");
    expect((await reverseExpense(fd({ expense_id: UUID, reason }))).error).toBe("errors.notAuthenticated");
    expect((await correctExpense(fd({ expense_id: UUID, amount: "900", expense_date: "2026-05-04", reason }))).error)
      .toBe("errors.notAuthenticated");
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("cross-tenant en verzonnen id's", () => {
  test("een betaling van een andere organisatie geeft notFound en geen RPC", async () => {
    state.activeOrg = { role: "manager", org: { id: ORG, name: "Org" } };
    state.row = { data: { id: UUID, organization_id: OTHER_ORG_UUID, building_id: BUILDING }, error: null };

    const r = await reversePayment(fd({ payment_id: UUID, reason }));
    expect(r.error).toBe("errors.notFound");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("een verzonnen betalings-id geeft notFound en geen RPC", async () => {
    state.activeOrg = { role: "manager", org: { id: ORG, name: "Org" } };
    state.row = { data: null, error: null };

    const r = await reversePayment(fd({ payment_id: UUID, reason }));
    expect(r.error).toBe("errors.notFound");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("een verzonnen uitgave-id geeft notFound en geen RPC", async () => {
    state.activeOrg = { role: "manager", org: { id: ORG, name: "Org" } };
    state.row = { data: null, error: null };

    const r = await reverseExpense(fd({ expense_id: UUID, reason }));
    expect(r.error).toBe("errors.notFound");
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("S8–S11 — geslaagde aanroepen", () => {
  test("S8 reversePayment roept exact reverse_payment aan", async () => {
    signedIn();
    const r = await reversePayment(fd({ payment_id: UUID, reason, fy_id: BUILDING }));

    expect(r.error).toBeUndefined();
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("reverse_payment");
    expect(state.rpcCalls[0].params).toEqual({ p_payment_id: UUID, p_reason: reason });
    expect(state.revalidated.length).toBeGreaterThan(0);
  });

  test("S9 correctPayment geeft precies de RPC-parameters door", async () => {
    signedIn();
    const r = await correctPayment(
      fd({ payment_id: UUID, amount: "800,50", value_date: "2026-04-10", method: "cheque", reference: "VIR-9", reason }),
    );

    expect(r.error).toBeUndefined();
    expect(state.rpcCalls[0].name).toBe("correct_payment");
    expect(state.rpcCalls[0].params).toEqual({
      p_payment_id: UUID,
      p_amount: 800.5,
      p_value_date: "2026-04-10",
      p_method: "cheque",
      p_reference: "VIR-9",
      p_reason: reason,
    });
  });

  test("S10 reverseExpense roept exact reverse_expense aan", async () => {
    signedIn();
    const r = await reverseExpense(fd({ expense_id: UUID, reason }));

    expect(r.error).toBeUndefined();
    expect(state.rpcCalls[0].name).toBe("reverse_expense");
    expect(state.rpcCalls[0].params).toEqual({ p_expense_id: UUID, p_reason: reason });
  });

  test("S11 correctExpense neemt de rekening van het origineel, niet van het formulier", async () => {
    state.activeOrg = { role: "manager", org: { id: ORG, name: "Org" } };
    state.row = {
      data: {
        id: UUID, organization_id: ORG, building_id: BUILDING,
        account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        receipt_path: "org/geb/bewijs.pdf",
      },
      error: null,
    };

    const r = await correctExpense(
      fd({
        expense_id: UUID, amount: "900", expense_date: "2026-05-04",
        supplier: "Elektricien", description: "Gecorrigeerd", reason,
        // Een aangeleverde rekening moet worden genegeerd.
        account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    );

    expect(r.error).toBeUndefined();
    const params = state.rpcCalls[0].params;
    expect(state.rpcCalls[0].name).toBe("correct_expense");
    expect(params.p_account_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(params.p_amount).toBe(900);
    // Zonder nieuw bestand erft de correctie het bewijsstuk van het origineel.
    expect(params.p_receipt_path).toBe("org/geb/bewijs.pdf");
  });
});

describe("S7 — organization_id wordt nooit uit FormData vertrouwd", () => {
  test("een meegestuurde organization_id komt niet in de RPC terecht", async () => {
    signedIn();
    await correctPayment(
      fd({
        payment_id: UUID, amount: "800", value_date: "2026-04-10", method: "virement", reason,
        organization_id: OTHER_ORG_UUID,
      }),
    );

    const params = state.rpcCalls[0].params;
    expect(Object.keys(params)).not.toContain("organization_id");
    expect(JSON.stringify(params)).not.toContain(OTHER_ORG_UUID);
  });
});

describe("adversariële review — dubbele FormData-sleutel", () => {
  /**
   * formData.get() geeft de EERSTE waarde van een herhaalde sleutel, terwijl
   * parseForm() over entries() loopt en dus de LAATSTE overhoudt. Zonder
   * override zou de tenantcontrole op de ene rij draaien en de RPC op de andere.
   */
  test("de gecontroleerde payment_id wint van een tweede, bijgesmokkelde waarde", async () => {
    signedIn();
    const smokkel = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const f = new FormData();
    f.append("payment_id", UUID);      // deze wordt gecontroleerd
    f.append("payment_id", smokkel);   // deze zou anders naar de RPC gaan
    f.append("reason", reason);

    await reversePayment(f);

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].params.p_payment_id).toBe(UUID);
    expect(JSON.stringify(state.rpcCalls[0].params)).not.toContain(smokkel);
  });

  test("idem voor correctPayment", async () => {
    signedIn();
    const smokkel = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const f = new FormData();
    f.append("payment_id", UUID);
    f.append("payment_id", smokkel);
    f.append("amount", "800");
    f.append("value_date", "2026-04-10");
    f.append("method", "virement");
    f.append("reason", reason);

    await correctPayment(f);
    expect(state.rpcCalls[0].params.p_payment_id).toBe(UUID);
  });

  test("idem voor reverseExpense en correctExpense", async () => {
    signedIn();
    const smokkel = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const f1 = new FormData();
    f1.append("expense_id", UUID);
    f1.append("expense_id", smokkel);
    f1.append("reason", reason);
    await reverseExpense(f1);
    expect(state.rpcCalls[0].params.p_expense_id).toBe(UUID);

    state.rpcCalls = [];
    const f2 = new FormData();
    f2.append("expense_id", UUID);
    f2.append("expense_id", smokkel);
    f2.append("amount", "900");
    f2.append("expense_date", "2026-05-04");
    f2.append("reason", reason);
    await correctExpense(f2);
    expect(state.rpcCalls[0].params.p_expense_id).toBe(UUID);
  });
});

describe("S5/S6 — foutafhandeling vanuit de database", () => {
  test("S5 ALREADY_REVERSED wordt een nette sleutel (U4: geen tweede storno)", async () => {
    signedIn();
    state.rpcResult = { error: { code: "23505", message: "ALREADY_REVERSED: deze betaling is al gestorneerd." } };

    const r = await reversePayment(fd({ payment_id: UUID, reason }));
    expect(r.error).toBe("errors.alreadyReversed");
  });

  test("S5b REVERSAL_FORBIDDEN_CLOSED_FY wordt correct onderscheiden", async () => {
    signedIn("manager");
    state.rpcResult = { error: { code: "42501", message: "REVERSAL_FORBIDDEN_CLOSED_FY: alleen owner of admin." } };

    const r = await reversePayment(fd({ payment_id: UUID, reason }));
    expect(r.error).toBe("errors.forbiddenClosedFy");
  });

  test("S6 een onbekende databasefout wordt gesaneerd", async () => {
    signedIn();
    state.rpcResult = {
      error: { code: "XX000", message: 'stack trace: relation "payments" line 42 near "settled_amount"' },
    };

    const r = await reversePayment(fd({ payment_id: UUID, reason }));
    expect(r.error).toBe("errors.unknown");
    expect(r.error).not.toContain("settled_amount");
    expect(r.error).not.toContain("payments");
  });

  test("bij een RPC-fout wordt er niets gerevalideerd", async () => {
    signedIn();
    state.rpcResult = { error: { code: "23505", message: "ALREADY_REVERSED: x" } };

    await reversePayment(fd({ payment_id: UUID, reason }));
    expect(state.revalidated).toHaveLength(0);
  });
});

describe("validatie vóór de database", () => {
  test("een te korte reden bereikt de database niet", async () => {
    signedIn();
    const r = await reversePayment(fd({ payment_id: UUID, reason: "kort" }));
    expect(r.error).toBe("errors.reasonRequired");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("een negatief correctiebedrag bereikt de database niet", async () => {
    signedIn();
    const r = await correctPayment(
      fd({ payment_id: UUID, amount: "-5", value_date: "2026-04-10", method: "virement", reason }),
    );
    expect(r.error).toBe("errors.amountInvalid");
    expect(state.rpcCalls).toHaveLength(0);
  });

  test("het resultaat bevat uitsluitend een error-veld, nooit een database-object", async () => {
    signedIn();
    state.rpcResult = { error: { code: "23514", message: "SETTLEMENT_NOT_DERIVED: intern" } };

    const r = await reversePayment(fd({ payment_id: UUID, reason }));
    expect(Object.keys(r)).toEqual(["error"]);
    expect(typeof r.error).toBe("string");
  });
});

import { describe, expect, test } from "vitest";
import {
  correctExpenseSchema,
  correctPaymentSchema,
  parseForm,
  reversalValidationKey,
  reverseExpenseSchema,
  reversePaymentSchema,
} from "@/lib/validation";
import { reversalErrorFingerprint, reversalErrorKey } from "@/lib/reversalErrors";
import { canManageMembers, canReverse, canWrite } from "@/lib/roles";

const UUID = "3f8c1a52-9b7e-4d21-8a30-6c5f2e1d4b09";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

const geldigeReden = "Bedrag verkeerd overgenomen uit het bankbestand";

describe("S2/S3/S4 — invoervalidatie", () => {
  test("S2 een misvormde UUID wordt geweigerd", () => {
    const r = parseForm(reversePaymentSchema, fd({ payment_id: "geen-uuid", reason: geldigeReden }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("idInvalid");
  });

  test("S3 een te korte reden wordt geweigerd", () => {
    const r = parseForm(reversePaymentSchema, fd({ payment_id: UUID, reason: "te kort" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("reasonRequired");
  });

  test("S3b een reden van meer dan 500 tekens wordt geweigerd", () => {
    const r = parseForm(reversePaymentSchema, fd({ payment_id: UUID, reason: "x".repeat(501) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("reasonRequired");
  });

  test("de reden wordt getrimd; spaties tellen niet mee voor de ondergrens", () => {
    const r = parseForm(reversePaymentSchema, fd({ payment_id: UUID, reason: "   kort    " }));
    expect(r.ok).toBe(false);
  });

  test("een geldige storno-invoer wordt geaccepteerd en getrimd", () => {
    const r = parseForm(reversePaymentSchema, fd({ payment_id: UUID, reason: `  ${geldigeReden}  ` }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.reason).toBe(geldigeReden);
  });

  test("S4 een bedrag van nul of lager wordt geweigerd", () => {
    for (const bedrag of ["0", "-5", "-0.01"]) {
      const r = parseForm(
        correctPaymentSchema,
        fd({ payment_id: UUID, amount: bedrag, value_date: "2026-04-10", method: "virement", reason: geldigeReden }),
      );
      expect(r.ok, `bedrag ${bedrag}`).toBe(false);
      if (!r.ok) expect(r.error).toBe("amountInvalid");
    }
  });

  test("S4b een bedrag dat geen getal is wordt geweigerd", () => {
    const r = parseForm(
      correctPaymentSchema,
      fd({ payment_id: UUID, amount: "duizend", value_date: "2026-04-10", method: "virement", reason: geldigeReden }),
    );
    expect(r.ok).toBe(false);
  });

  test("een komma als decimaalteken wordt genormaliseerd", () => {
    const r = parseForm(
      correctPaymentSchema,
      fd({ payment_id: UUID, amount: "1 234,56", value_date: "2026-04-10", method: "virement", reason: geldigeReden }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.amount).toBe(1234.56);
  });

  /**
   * Adversariële review: het oude `parseFloat`-patroon las het langste geldige
   * VOORVOEGSEL en verving alleen de EERSTE komma. "1.200,50" werd daardoor
   * stilzwijgend 1,20 en "1200x" gewoon 1200. Bij een correctie is dat fataal:
   * het origineel is dan al gestorneerd, dus het verkeerde bedrag belandt
   * rechtstreeks in de vervangende betaling en in het grootboek.
   */
  const bedragGevallen: [string, string][] = [
    ["1.200,50", "duizendtalscheiding met punt is dubbelzinnig"],
    ["1200x", "achtervoegsel"],
    ["12OO", "letters O in plaats van nullen"],
    ["1,2,3", "meerdere scheidingstekens"],
    ["1200.505", "meer dan twee decimalen"],
    ["--5", "dubbel minteken"],
    ["1e3", "wetenschappelijke notatie"],
    ["", "leeg"],
  ];

  for (const [invoer, waarom] of bedragGevallen) {
    test(`bedrag "${invoer}" wordt geweigerd (${waarom})`, () => {
      const r = parseForm(
        correctPaymentSchema,
        fd({ payment_id: UUID, amount: invoer, value_date: "2026-04-10", method: "virement", reason: geldigeReden }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("amountInvalid");
    });
  }

  const geldigeBedragen: [string, number][] = [
    ["1200", 1200],
    ["1200,50", 1200.5],
    ["1200.50", 1200.5],
    ["1 200,50", 1200.5],
    ["0,01", 0.01],
  ];

  for (const [invoer, verwacht] of geldigeBedragen) {
    test(`bedrag "${invoer}" wordt exact ${verwacht}`, () => {
      const r = parseForm(
        correctPaymentSchema,
        fd({ payment_id: UUID, amount: invoer, value_date: "2026-04-10", method: "virement", reason: geldigeReden }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.amount).toBe(verwacht);
    });
  }

  test("een onbekende betaalwijze wordt geweigerd", () => {
    const r = parseForm(
      correctPaymentSchema,
      fd({ payment_id: UUID, amount: "800", value_date: "2026-04-10", method: "bitcoin", reason: geldigeReden }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("methodInvalid");
  });

  test("een ongeldige datum wordt geweigerd", () => {
    const r = parseForm(
      correctPaymentSchema,
      fd({ payment_id: UUID, amount: "800", value_date: "10-04-2026", method: "virement", reason: geldigeReden }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("dateInvalid");
  });

  test("een te lange referentie wordt geweigerd", () => {
    const r = parseForm(
      correctPaymentSchema,
      fd({
        payment_id: UUID, amount: "800", value_date: "2026-04-10", method: "virement",
        reference: "r".repeat(81), reason: geldigeReden,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("referenceTooLong");
  });

  test("een lege referentie wordt null en niet een lege string", () => {
    const r = parseForm(
      correctPaymentSchema,
      fd({ payment_id: UUID, amount: "800", value_date: "2026-04-10", method: "virement", reference: "", reason: geldigeReden }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.reference).toBeNull();
  });

  test("S7 een meegestuurde organization_id wordt genegeerd, niet overgenomen", () => {
    const r = parseForm(
      correctPaymentSchema,
      fd({
        payment_id: UUID, amount: "800", value_date: "2026-04-10", method: "virement",
        reason: geldigeReden,
        organization_id: "11111111-1111-1111-1111-111111111111",
      }),
    );
    expect(r.ok).toBe(true);
    // Het schema is `strip`: onbekende velden komen niet in het resultaat.
    if (r.ok) expect(Object.keys(r.data)).not.toContain("organization_id");
  });

  test("uitgavecorrectie accepteert geen account_id vanuit het formulier", () => {
    const r = parseForm(
      correctExpenseSchema,
      fd({
        expense_id: UUID, amount: "900", expense_date: "2026-05-04",
        reason: geldigeReden,
        account_id: "22222222-2222-2222-2222-222222222222",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.data)).not.toContain("account_id");
  });

  test("uitgavestorno vereist een geldig expense_id", () => {
    expect(parseForm(reverseExpenseSchema, fd({ expense_id: "x", reason: geldigeReden })).ok).toBe(false);
    expect(parseForm(reverseExpenseSchema, fd({ expense_id: UUID, reason: geldigeReden })).ok).toBe(true);
  });

  test("onbekende validatiesleutels vallen terug op invalidInput", () => {
    expect(reversalValidationKey("reasonRequired")).toBe("reasonRequired");
    expect(reversalValidationKey("Ongeldige invoer.")).toBe("invalidInput");
    expect(reversalValidationKey("<script>")).toBe("invalidInput");
  });
});

describe("S5/S6 — foutvertaling", () => {
  test("S5 elke stabiele engine-code krijgt een eigen sleutel", () => {
    const gevallen: [string, string][] = [
      ["ALREADY_REVERSED", "alreadyReversed"],
      ["PAYMENT_NOT_FOUND", "notFound"],
      ["EXPENSE_NOT_FOUND", "notFound"],
      ["REVERSAL_FORBIDDEN", "forbidden"],
      ["REVERSAL_FORBIDDEN_CLOSED_FY", "forbiddenClosedFy"],
      ["REVERSAL_NO_OPEN_FISCAL_YEAR", "noOpenFiscalYear"],
      ["PAYMENT_NOT_JOURNALED", "paymentNotJournaled"],
      ["EXPENSE_NOT_JOURNALED", "expenseNotJournaled"],
      ["REVERSAL_REASON_REQUIRED", "reasonRequired"],
      ["CORRECTION_AMOUNT_INVALID", "amountInvalid"],
      ["PAYMENT_IMMUTABLE", "immutable"],
      ["EXPENSE_IMMUTABLE", "immutable"],
      ["SETTLEMENT_NOT_DERIVED", "integrity"],
      ["ALLOCATION_EXCEEDS_PAYMENT", "integrity"],
      ["REVERSAL_ALLOCATION_MISMATCH", "integrity"],
      ["PAYMENT_HAS_FINANCIAL_HISTORY", "hasHistory"],
    ];
    for (const [code, sleutel] of gevallen) {
      expect(reversalErrorKey({ code: "23514", message: `${code}: uitleg` }), code).toBe(sleutel);
    }
  });

  test("S6 een onbekende databasefout wordt generiek", () => {
    expect(reversalErrorKey({ code: "XX000", message: "internal error near line 42" })).toBe("unknown");
    expect(reversalErrorKey(null)).toBe("unknown");
    expect(reversalErrorKey({ code: null, message: null })).toBe("unknown");
  });

  test("S6b rauwe PostgreSQL-tekst lekt nooit als sleutel naar buiten", () => {
    const sleutel = reversalErrorKey({
      code: "23514",
      message: 'new row for relation "payments" violates check constraint "payments_amount_check"',
    });
    expect(sleutel).toBe("unknown");
    expect(sleutel).not.toContain("payments_amount_check");
  });

  test("een kale 42501 zonder engine-prefix wordt 'forbidden'", () => {
    expect(reversalErrorKey({ code: "42501", message: "permission denied for table payments" })).toBe("forbidden");
  });

  test("de logvingerafdruk bevat geen payload, alleen codes", () => {
    const fp = reversalErrorFingerprint({
      code: "23514",
      message: "ALREADY_REVERSED: deze betaling van 1000 MAD van Naim Bouzian is al gestorneerd",
    });
    expect(fp).toBe("sqlstate=23514 engine=ALREADY_REVERSED");
    expect(fp).not.toContain("1000");
    expect(fp).not.toContain("Bouzian");
  });
});

describe("U1/U2/U3 — rolgedrag in de UI", () => {
  test("U1 een reader krijgt geen storno-actie", () => {
    expect(canWrite("reader")).toBe(false);
    expect(canReverse("reader", false)).toBe(false);
    expect(canReverse("reader", true)).toBe(false);
  });

  test("U2 schrijfbevoegde rollen mogen storneren in een open boekjaar", () => {
    for (const rol of ["owner", "admin", "manager", "accountant"] as const) {
      expect(canReverse(rol, false), rol).toBe(true);
    }
  });

  test("U3 bij een afgesloten origineel blijft alleen owner/admin over", () => {
    expect(canReverse("owner", true)).toBe(true);
    expect(canReverse("admin", true)).toBe(true);
    expect(canReverse("manager", true)).toBe(false);
    expect(canReverse("accountant", true)).toBe(false);
    expect(canManageMembers("manager")).toBe(false);
  });
});

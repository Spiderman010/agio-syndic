// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AllocationRuleRow, ChargeUnitRow } from "@/lib/charges";
import type { OwnershipRow } from "@/lib/ownership";

/**
 * De workflow in de browser: invoeren -> controleren -> bevestigen -> aanmaken.
 *
 * Wat hier wordt vastgelegd is het GEDRAG van de drie poorten. De knop die geld
 * vastlegt bestaat niet vóór de controle, is geblokkeerd zolang er niet
 * expliciet is bevestigd, en blijft geblokkeerd tijdens het verzenden. Elke
 * invoerwijziging maakt een eerdere uitkomst ongeldig.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const BLD = "11111111-1111-1111-1111-111111111111";
const U1 = "u1111111-0000-0000-0000-000000000001";
const U2 = "u2222222-0000-0000-0000-000000000002";
const REGEL = "r1111111-0000-0000-0000-000000000001";

const acties: FormData[] = [];

vi.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => {
    const fn = (key: string, waarden?: Record<string, unknown>) => {
      const basis = namespace ? `${namespace}.${key}` : key;
      return waarden ? `${basis}(${Object.values(waarden).join(",")})` : basis;
    };
    return Object.assign(fn, { rich: fn, markup: fn, raw: fn, has: () => true });
  },
  useLocale: () => "fr",
}));

vi.mock("@/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href} onClick={(e) => e.preventDefault()}>
      {children}
    </a>
  ),
}));

vi.mock("../src/app/[locale]/(app)/buildings/[id]/boekjaren/actions", () => ({
  createChargeCall: async (formData: FormData) => {
    acties.push(formData);
    return undefined;
  },
}));

vi.mock("@/app/[locale]/(app)/buildings/[id]/boekjaren/actions", () => ({
  createChargeCall: async (formData: FormData) => {
    acties.push(formData);
    return undefined;
  },
}));

const { default: ChargeCallWorkflow } = await import(
  "@/app/[locale]/(app)/buildings/[id]/boekjaren/[fy_id]/ChargeCallWorkflow"
);

function unit(id: string, label: string, tantiemes: number): ChargeUnitRow {
  return { id, building_id: BLD, label, tantiemes, block_id: null };
}

function bezit(unitId: string, over: Partial<OwnershipRow> = {}): OwnershipRow {
  return {
    id: `own-${unitId}`,
    unit_id: unitId,
    owner_id: "o1",
    share: 1,
    start_date: "2026-01-01",
    end_date: null,
    is_primary_debtor: true,
    ...over,
  };
}

const REGEL_STANDAARD: AllocationRuleRow = {
  id: REGEL,
  building_id: BLD,
  code: "general",
  label: "Charges générales",
  method: "tantieme",
  scope: "whole_building",
  weight_source: "unit_tantiemes",
  scope_block_id: null,
  uncovered_unit_policy: "scope_default",
  status: "active",
  is_default: true,
  partial_denominator_until_year: null,
};

/**
 * Rendert de workflow en vult standaard een GELDIG oproepbedrag in.
 *
 * Zonder bedrag is de controle terecht niet groen — dat is het gedrag dat
 * blokker 2 heeft toegevoegd. Tests die over scope, eigendom of bevestiging
 * gaan moeten dus met een geldig bedrag beginnen; wie de lege staat wil
 * onderzoeken geeft `{ bedrag: null }` mee.
 */
function toon(
  over: Partial<React.ComponentProps<typeof ChargeCallWorkflow>> = {},
  opties: { bedrag?: string | null } = {},
) {
  const resultaat = render(
    <ChargeCallWorkflow
      buildingId={BLD}
      fiscalYearId="fy-1"
      fiscalYear={{ year: 2026, status: "open", startDate: "2026-01-01", endDate: "2026-12-31" }}
      declaredTantiemes={100}
      rules={[REGEL_STANDAARD]}
      units={[unit(U1, "A1", 60), unit(U2, "A2", 40)]}
      ruleUnits={[]}
      ruleWeights={[]}
      ownership={[bezit(U1), bezit(U2)]}
      today="2026-06-30"
      {...over}
    />,
  );

  const bedrag = opties.bedrag === undefined ? "1200,00" : opties.bedrag;
  const veld = resultaat.container.querySelector("#cc-amount");
  if (bedrag !== null && veld) {
    act(() => {
      fireEvent.change(veld, { target: { value: bedrag } });
    });
  }
  return resultaat;
}

beforeEach(() => {
  acties.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("WF — de drie stappen", () => {
  it("WF1 — vóór de controle bestaat er geen aanmaakknop", () => {
    toon();
    expect(screen.queryByTestId("readiness")).toBeNull();
    expect(screen.queryByTestId("final-submit")).toBeNull();
    expect(screen.queryByTestId("confirm-checkbox")).toBeNull();
  });

  it("WF2 — de controle toont de uitkomst en het aantal deelnemende lots", () => {
    toon();
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("readiness")).toBeTruthy();
    expect(screen.getByTestId("clear")).toBeTruthy();
    expect(screen.getByTestId("readiness").textContent).toContain("2");
  });

  it("WF3 — een blokkade krijgt role=alert en er komt geen aanmaakknop", () => {
    // A2 heeft geen eigenaar op de oproepdatum.
    toon({ ownership: [bezit(U1)] });
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });

    const blokkades = screen.getByTestId("blockers");
    expect(blokkades.getAttribute("role")).toBe("alert");
    expect(blokkades.textContent).toContain("charges.errors.noOwner");
    // Het lotlabel komt uit de eigen query, niet uit databasefouttekst.
    expect(blokkades.textContent).toContain("A2");
    expect(screen.queryByTestId("final-submit")).toBeNull();
  });

  it("WF4 — de controle belooft nooit dat het aanmaken zal slagen", () => {
    toon();
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    const tekst = screen.getByTestId("readiness").textContent ?? "";
    expect(tekst).toContain("charges.check.notGuarantee");
    expect(tekst).not.toContain("charges.check.willSucceed");
  });
});

describe("BV — bevestigen en verzenden", () => {
  it("BV1 — zonder bevestiging is de aanmaakknop geblokkeerd", () => {
    toon();
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    const knop = screen.getByTestId("final-submit");
    expect(knop.getAttribute("aria-disabled")).toBe("true");
  });

  it("BV2 — na bevestiging is de knop vrij", () => {
    toon();
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("confirm-checkbox"));
    });
    expect(screen.getByTestId("final-submit").getAttribute("aria-disabled")).toBe("false");
  });

  it("BV3 — een geblokkeerde knop start geen verzending, ook niet bij dubbelklikken", () => {
    toon();
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    const knop = screen.getByTestId("final-submit");
    act(() => {
      fireEvent.click(knop);
      fireEvent.click(knop);
    });
    expect(acties).toHaveLength(0);
  });

  it("BV4 — een invoerwijziging maakt controle én bevestiging ongeldig", () => {
    toon();
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("confirm-checkbox"));
    });
    expect(screen.getByTestId("final-submit").getAttribute("aria-disabled")).toBe("false");

    // Een andere oproepdatum hoort de eerdere uitkomst te laten vervallen.
    act(() => {
      fireEvent.change(screen.getByLabelText(/charges\.callDate/), {
        target: { value: "2026-09-01" },
      });
    });
    expect(screen.queryByTestId("readiness")).toBeNull();
    expect(screen.queryByTestId("final-submit")).toBeNull();
  });

  it("BV5 — de oproepdatum stuurt de eigenaarscontrole", () => {
    // A1 wisselt op 01-06-2026 van eigenaar; A2 heeft pas eigendom vanaf juli.
    toon({
      ownership: [
        bezit(U1, { start_date: "2026-01-01", end_date: "2026-05-31" }),
        bezit(U1, { id: "own-u1-b", owner_id: "o2", start_date: "2026-06-01" }),
        bezit(U2, { start_date: "2026-07-01" }),
      ],
    });

    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    // Op 30-06 heeft A2 nog geen eigenaar.
    expect(screen.getByTestId("blockers").textContent).toContain("A2");

    act(() => {
      fireEvent.change(screen.getByLabelText(/charges\.callDate/), {
        target: { value: "2026-07-15" },
      });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("clear")).toBeTruthy();
  });

  it("BV6 — de bevestiging waarschuwt dat er vorderingen en journaalregels ontstaan", () => {
    toon();
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    const kaart = screen.getByTestId("charge-call-workflow");
    expect(kaart.textContent).toContain("charges.confirm.warning");
    expect(kaart.querySelector('[role="alert"]')).toBeTruthy();
  });
});

describe("GR — geen actieve verdeelregels", () => {
  it("GR1 — nul actieve regels geeft een melding en geen bruikbare workflow", () => {
    toon({ rules: [] });
    expect(screen.getByTestId("no-rules").textContent).toContain("charges.noActiveRule");
    // Geen lege select, geen controleknop, geen aanmaakknop.
    expect(screen.queryByTestId("run-check")).toBeNull();
    expect(screen.queryByTestId("readiness")).toBeNull();
    expect(screen.queryByTestId("final-submit")).toBeNull();
    expect(screen.queryByTestId("clear")).toBeNull();
    expect(document.querySelector('select[name="allocation_rule_id"]')).toBeNull();
  });

  it("GR2 — één actieve standaardregel staat geselecteerd", () => {
    const { container } = toon();
    const select = container.querySelector(
      'select[name="allocation_rule_id"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe(REGEL);
  });

  it("GR3 — zonder standaard wordt de enige actieve regel geselecteerd", () => {
    const gewoon = { ...REGEL_STANDAARD, id: "r-gewoon", is_default: false };
    const { container } = toon({ rules: [gewoon] });
    const select = container.querySelector(
      'select[name="allocation_rule_id"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("r-gewoon");
  });

  it("GR4 — een gekozen niet-standaardregel gaat expliciet mee naar de RPC", () => {
    const tweede = { ...REGEL_STANDAARD, id: "r-tweede", is_default: false, label: "Ascenseur" };
    const { container } = toon({ rules: [REGEL_STANDAARD, tweede] });
    const select = container.querySelector(
      'select[name="allocation_rule_id"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe(REGEL);

    act(() => {
      fireEvent.change(select, { target: { value: "r-tweede" } });
    });
    expect(select.value).toBe("r-tweede");
    expect(select.name).toBe("allocation_rule_id");
  });
});

describe("FV — vooraf kenbare formulierfouten blokkeren groen", () => {
  function vulBedrag(container: HTMLElement, waarde: string) {
    act(() => {
      fireEvent.change(container.querySelector("#cc-amount")!, { target: { value: waarde } });
    });
  }

  it("FV1 — zonder ingevuld bedrag is de controle niet groen", () => {
    toon({}, { bedrag: null });
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.queryByTestId("clear")).toBeNull();
    expect(screen.getByTestId("blockers").textContent).toContain("charges.errors.amountInvalid");
    expect(screen.queryByTestId("final-submit")).toBeNull();
  });

  it("FV2 — een geldig bedrag maakt de controle groen", () => {
    const { container } = toon();
    vulBedrag(container, "1200,00");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("clear")).toBeTruthy();
    expect(screen.getByTestId("final-submit")).toBeTruthy();
  });

  it("FV3 — 'abc' als bedrag blokkeert", () => {
    const { container } = toon();
    vulBedrag(container, "abc");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("blockers").textContent).toContain("charges.errors.amountInvalid");
  });

  it("FV4 — een vervaldatum vóór de oproepdatum blokkeert", () => {
    const { container } = toon();
    vulBedrag(container, "1200");
    act(() => {
      fireEvent.change(container.querySelector("#cc-due-date")!, {
        target: { value: "2026-06-29" },
      });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("blockers").textContent).toContain("charges.errors.dueBeforeCall");
  });

  it("FV5 — het bedrag wijzigen ná de controle maakt controle en bevestiging ongeldig", () => {
    const { container } = toon();
    vulBedrag(container, "1200");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("confirm-checkbox"));
    });
    expect(screen.getByTestId("final-submit").getAttribute("aria-disabled")).toBe("false");

    vulBedrag(container, "1500");
    expect(screen.queryByTestId("readiness")).toBeNull();
    expect(screen.queryByTestId("final-submit")).toBeNull();
  });

  it("FV6 — de vervaldatum wijzigen ná de controle invalideert eveneens", () => {
    const { container } = toon();
    vulBedrag(container, "1200");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    act(() => {
      fireEvent.change(container.querySelector("#cc-due-date")!, {
        target: { value: "2026-12-31" },
      });
    });
    expect(screen.queryByTestId("readiness")).toBeNull();
  });
});

describe("TG — toegankelijkheid en opmaak", () => {
  it("TG1 — elk invoerveld heeft een gekoppeld label", () => {
    const { container } = toon();
    const velden = container.querySelectorAll("input[name], select[name]");
    expect(velden.length).toBeGreaterThan(4);
    for (const veld of Array.from(velden)) {
      const id = veld.getAttribute("id");
      if (!id || veld.getAttribute("type") === "hidden") continue;
      expect(container.querySelector(`label[for="${id}"]`), id).toBeTruthy();
    }
  });

  it("TG2 — de bevestigingsstap is geen modaal venster maar inline en met toetsenbord bedienbaar", () => {
    const { container } = toon();
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(container.querySelector("dialog")).toBeNull();
    const checkbox = screen.getByTestId("confirm-checkbox") as HTMLInputElement;
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.tabIndex).toBeGreaterThanOrEqual(0);
    // aria-disabled houdt de knop in de tabvolgorde, anders dan `disabled`.
    expect(screen.getByTestId("final-submit").hasAttribute("disabled")).toBe(false);
  });

  it("TG3 — de opmaak is logisch en responsive, zonder vaste breedtes", () => {
    const bron = readFileSync(
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
        "ChargeCallWorkflow.tsx",
      ),
      "utf8",
    );
    // Geen links/rechts: de schil zet `dir`, de opmaak volgt logisch.
    expect(bron).not.toMatch(/\bml-\d|\bmr-\d|\btext-left\b|\btext-right\b|\bpl-\d|\bpr-\d/);
    // Geen vaste pixelbreedtes die op 360px zouden overlopen.
    expect(bron).not.toMatch(/width:\s*\d{3,}px/);
    expect(bron).not.toMatch(/minWidth/);
    // Eén kolom op klein scherm, twee vanaf sm.
    expect(bron).toContain("sm:grid-cols-2");
  });

  it("TG4 — de component werkt binnen een RTL-container", () => {
    const { container } = toon();
    container.setAttribute("dir", "rtl");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("readiness")).toBeTruthy();
    expect(container.getAttribute("dir")).toBe("rtl");
  });
});

// ── BLOKKER 2: de handmatige som in de browser ──────────────────────────────

/**
 * Wat de gebruiker intypt is precies wat de Server Action meestuurt. De
 * controle telt die bedragen op met DEZELFDE parser en weigert groen te worden
 * wanneer de som niet gelijk is aan het oproepbedrag — want dan weigert m20
 * straks met ALLOC_MANUAL_SUM.
 */
describe("HS — handmatige som in het scherm", () => {
  const HANDMATIG: AllocationRuleRow = {
    ...REGEL_STANDAARD,
    method: "manual",
    weight_source: "charge_call_lines",
  };

  function vul(container: HTMLElement, id: string, waarde: string) {
    act(() => {
      fireEvent.change(container.querySelector(`#manual_${id}`)!, {
        target: { value: waarde },
      });
    });
  }

  it("HS1 — een kloppende som is groen", () => {
    const { container } = toon({ rules: [HANDMATIG] });
    vul(container, U1, "600");
    vul(container, U2, "600");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("clear")).toBeTruthy();
    expect(screen.getByTestId("final-submit")).toBeTruthy();
  });

  it("HS2 — 600 + 400 bij een oproep van 1200 is NIET groen", () => {
    const { container } = toon({ rules: [HANDMATIG] });
    vul(container, U1, "600");
    vul(container, U2, "400");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.queryByTestId("clear")).toBeNull();
    expect(screen.getByTestId("blockers").textContent).toContain("charges.errors.manualSum");
    // En dus ook geen knop die geld vastlegt.
    expect(screen.queryByTestId("final-submit")).toBeNull();
  });

  it("HS3 — de melding zegt WAT er mis is, zonder een tweede berekening", () => {
    const { container } = toon({ rules: [HANDMATIG] });
    vul(container, U1, "600");
    vul(container, U2, "400");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    const tekst = screen.getByTestId("blockers").textContent ?? "";
    // Geen verschilbedrag, geen voorgestelde correctie per lot.
    expect(tekst).not.toMatch(/\b200\b/);
    expect(tekst).not.toMatch(/\b1000\b/);
  });

  it("HS4 — een bedrag corrigeren maakt de controle ongeldig en daarna groen", () => {
    const { container } = toon({ rules: [HANDMATIG] });
    vul(container, U1, "600");
    vul(container, U2, "400");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.queryByTestId("clear")).toBeNull();

    vul(container, U2, "600");
    // Elke wijziging trekt de vorige uitkomst in.
    expect(screen.queryByTestId("readiness")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("clear")).toBeTruthy();
  });

  it("HS5 — wat wordt verzonden is exact wat de controle heeft opgeteld", async () => {
    // Komma-notatie, en een cent die in drijvende komma zou wegvallen.
    const { container } = toon({ rules: [HANDMATIG] });
    act(() => {
      fireEvent.change(container.querySelector("#cc-amount")!, {
        target: { value: "1200,00" },
      });
    });
    vul(container, U1, "600,50");
    vul(container, U2, "599,50");

    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("clear")).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByTestId("confirm-checkbox"));
    });
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });

    expect(acties.length).toBe(1);
    const verzonden = acties[0];
    expect(verzonden.get(`manual_${U1}`)).toBe("600,50");
    expect(verzonden.get(`manual_${U2}`)).toBe("599,50");
  });

  it("HS6 — een leeg veld blijft geldig en telt als 0,00", () => {
    const { container } = toon({ rules: [HANDMATIG] });
    vul(container, U1, "1200");
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    expect(screen.getByTestId("clear")).toBeTruthy();
  });
});


// ── BJ: oproepdatum buiten het boekjaar, in het scherm ─────────────────────

describe("BD — oproepdatum buiten het boekjaar", () => {
  const PERIODE = {
    year: 2026,
    status: "open" as const,
    startDate: "2026-04-01",
    endDate: "2026-09-30",
  };

  function metDatum(datum: string) {
    const r = toon({ fiscalYear: PERIODE, today: "2026-06-15" });
    act(() => {
      fireEvent.change(r.container.querySelector("#cc-call-date")!, { target: { value: datum } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("run-check"));
    });
    return r;
  }

  it("BD1 — een datum binnen het boekjaar blijft groen", () => {
    metDatum("2026-06-15");
    expect(screen.getByTestId("clear")).toBeTruthy();
    expect(screen.getByTestId("final-submit")).toBeTruthy();
  });

  it("BD2 — een datum vóór de startdatum is rood en geeft geen aanmaakknop", () => {
    metDatum("2026-03-31");
    expect(screen.queryByTestId("clear")).toBeNull();
    expect(screen.getByTestId("blockers").textContent).toContain("charges.errors.callDateOutsideFy");
    expect(screen.queryByTestId("final-submit")).toBeNull();
  });

  it("BD3 — een datum na de einddatum is rood en geeft geen aanmaakknop", () => {
    metDatum("2026-10-01");
    expect(screen.queryByTestId("clear")).toBeNull();
    expect(screen.getByTestId("blockers").textContent).toContain("charges.errors.callDateOutsideFy");
    expect(screen.queryByTestId("final-submit")).toBeNull();
  });

  it("BD4 — de grenzen zelf zijn toegestaan", () => {
    for (const datum of ["2026-04-01", "2026-09-30"]) {
      cleanup();
      metDatum(datum);
      expect(screen.getByTestId("clear"), datum).toBeTruthy();
    }
  });

  it("BD5 — de melding toont geen technische foutcode of tabelnaam", () => {
    metDatum("1999-01-01");
    const tekst = screen.getByTestId("blockers").textContent ?? "";
    expect(tekst).not.toContain("ALLOC_CALL_DATE_OUTSIDE_FY");
    expect(tekst).not.toContain("charge_calls");
    expect(tekst).not.toContain("trig_01");
  });
});

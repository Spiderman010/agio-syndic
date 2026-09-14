// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { languageEnum } from "@/lib/validation";
import type { OwnerRow } from "@/lib/ownership";

import fr from "../messages/fr.json";
import nl from "../messages/nl.json";
import ar from "../messages/ar.json";

/**
 * Review finding (PR #10): `languageEnum` accepteert zeven talen
 * (`fr, ar, nl, en, es, ru, de`), maar `OwnerForm.tsx` rendere er maar vier
 * als `<option>`. Een eigenaar met een opgeslagen taal `es`, `ru` of `de` had
 * dan geen bijpassende optie: de browser selecteerde stilzwijgend de eerste
 * optie (`fr`), en het opslaan van een ONGERELATEERDE wijziging overschreef
 * zo de voorkeurstaal. Deze suite rendert het echte formulier en bewijst dat
 * elke geaccepteerde taal een optie heeft én dat een opgeslagen taal buiten
 * de oorspronkelijke vier zichtbaar geselecteerd blijft.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => {
    const fn = (key: string) => (namespace ? `${namespace}.${key}` : key);
    return fn;
  },
}));

const { default: OwnerForm } = await import("@/app/[locale]/(app)/owners/OwnerForm");

const BASE_OWNER: OwnerRow = {
  id: "77777777-7777-7777-7777-777777777777",
  full_name: "Test Owner",
  is_company: false,
  email: null,
  phone: null,
  language: "fr",
  is_mre: false,
};

const noop = async () => undefined;

afterEach(() => {
  cleanup();
});

describe("OwnerForm — taalopties", () => {
  it("toont alle zeven door languageEnum geaccepteerde talen als optie, in die volgorde", async () => {
    const element = await OwnerForm({ action: noop, submitLabel: "Enregistrer" });
    render(element);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual([...languageEnum.options]);
    expect(values).toEqual(["fr", "ar", "nl", "en", "es", "ru", "de"]);
  });

  it.each(["es", "ru", "de"] as const)(
    "een eigenaar met opgeslagen taal '%s' behoudt die selectie bij bewerken",
    async (lang) => {
      const owner: OwnerRow = { ...BASE_OWNER, language: lang };
      const element = await OwnerForm({ action: noop, submitLabel: "Enregistrer", owner });
      render(element);

      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe(lang);
    },
  );

  it("een eigenaar met de oorspronkelijke vier talen blijft ook correct geselecteerd", async () => {
    for (const lang of ["fr", "ar", "nl", "en"] as const) {
      const owner: OwnerRow = { ...BASE_OWNER, language: lang };
      const element = await OwnerForm({ action: noop, submitLabel: "Enregistrer", owner });
      const { unmount } = render(element);

      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe(lang);
      unmount();
    }
  });
});

describe("languageEnum — server-side validatie", () => {
  it("accepteert exact de zeven verwachte codes", () => {
    for (const code of ["fr", "ar", "nl", "en", "es", "ru", "de"]) {
      expect(languageEnum.safeParse(code).success, code).toBe(true);
    }
  });

  it("wijst een taalcode buiten het enum af", () => {
    for (const code of ["xx", "FR", "", "french", "pt"]) {
      expect(languageEnum.safeParse(code).success, code).toBe(false);
    }
  });
});

describe("buildings.langs — vertaalpariteit voor de nieuwe talen", () => {
  const locales = { fr, nl, ar } as Record<string, { buildings: { langs: Record<string, string> } }>;

  it("es, ru en de hebben een niet-lege vertaling in fr, nl en ar", () => {
    for (const [name, messages] of Object.entries(locales)) {
      for (const code of ["es", "ru", "de"]) {
        expect(messages.buildings.langs[code], `buildings.langs.${code} ontbreekt in ${name}`).toBeTruthy();
      }
    }
  });
});

import { routing } from "@/i18n/routing";

export type Direction = "ltr" | "rtl";

/**
 * Leesrichting per taal.
 *
 * Stond eerder als een inline ternary in de layout. Als eigen functie is hij
 * testbaar én is er één plek die het antwoord geeft, wat belangrijk wordt zodra
 * er een tweede RTL-taal bij komt (het datamodel kent al zeven talen op
 * `owners.language`).
 *
 * De hele schil gebruikt logische CSS-eigenschappen — `ms-`, `border-e`,
 * `start-`, `text-start` — zodat het zetten van `dir` op het html-element
 * voldoende is en geen enkel component een eigen RTL-tak nodig heeft.
 */
const RTL_LOCALES = new Set<string>(["ar"]);

export function localeDirection(locale: string): Direction {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

export function isSupportedLocale(
  locale: string,
): locale is (typeof routing.locales)[number] {
  return (routing.locales as readonly string[]).includes(locale);
}

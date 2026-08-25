import { getLocale } from "next-intl/server";
import { redirect } from "@/navigation";

/**
 * Locale-bewuste redirect voor server actions en servercomponenten.
 *
 * next-intl's createNavigation-redirect vereist een expliciete locale
 * (`redirect({ href, locale })`); een kale string is een typefout. Deze helper
 * haalt de actieve locale op en werpt daarna de redirect. De functie keert
 * nooit terug (next's redirect gooit intern).
 */
export async function localeRedirect(href: string): Promise<never> {
  const locale = await getLocale();
  redirect({ href, locale });
  // redirect() gooit altijd (NEXT_REDIRECT); deze regel is onbereikbaar maar
  // nodig omdat tsc de never-returntype van de gedestructureerde const niet
  // gebruikt voor bereikbaarheidsanalyse.
  throw new Error("unreachable");
}

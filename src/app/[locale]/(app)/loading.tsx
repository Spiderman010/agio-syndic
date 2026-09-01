"use client";

import { useTranslations } from "next-intl";

/**
 * Laadstaat voor alle schermen binnen de schil.
 *
 * Bewust op groepsniveau en niet per route gedupliceerd: de schil (sidebar,
 * topbar, broodkruimels) staat er al en blijft staan; alleen de contentkolom
 * wordt vervangen. Daardoor is dit skelet ook precies wat er nodig is — een
 * paar blokken op de plek waar de inhoud komt.
 *
 * Skelet in plaats van een spinner, omdat de hoogte dan al klopt voordat de
 * data er is en er geen sprong ontstaat wanneer de inhoud arriveert.
 *
 * Het skelet zelf blijft `aria-hidden`: losse grijze blokken voorlezen is ruis.
 * Maar dán is de wachttijd voor een schermlezer volledig stil, en dat is erger.
 * De wrapper draagt daarom `role="status"` met `aria-busy`, plus één regel
 * visueel verborgen tekst die wél wordt aangekondigd.
 *
 * Client component uitsluitend om `useTranslations` te kunnen gebruiken; een
 * async server component zou als Suspense-fallback zelf kunnen opschorten.
 */
export default function Loading() {
  const t = useTranslations("shell");

  return (
    <div role="status" aria-busy="true" data-testid="app-loading">
      <span className="sr-only">{t("loading")}</span>

      <div className="animate-pulse" aria-hidden="true">
        <div className="mb-2 h-7 w-56 max-w-full rounded-lg bg-surface-2" />
        <div className="mb-6 h-4 w-80 max-w-full rounded bg-surface-2" />
        <div className="flex flex-col gap-3">
          <div className="h-20 rounded-[14px] bg-surface-2" />
          <div className="h-20 rounded-[14px] bg-surface-2" />
          <div className="h-20 rounded-[14px] bg-surface-2" />
        </div>
      </div>
    </div>
  );
}

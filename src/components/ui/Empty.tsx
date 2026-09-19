import { cn } from "@/lib/utils";

/**
 * Lege toestand — één vorm voor drie verschillende boodschappen.
 *
 * Dit scherm kent drie situaties waarin er geen rijen staan, en die mogen
 * NOOIT op elkaar lijken:
 *
 *   leeg          alle bronnen geslaagd, er zijn werkelijk nul lots
 *   niets gevonden  alle bronnen geslaagd, het filter sluit alles uit
 *   onbeschikbaar   een bron is MISLUKT en er wordt bewust niets getoond
 *
 * Het verschil tussen de eerste twee en de derde is het hele punt. "Geen lots"
 * is een BEWERING over het gebouw; een mislukte query weet niets. Wie die twee
 * op elkaar laat lijken, nodigt een beheerder uit om een lot aan te maken dat
 * er al is.
 *
 * Deze component geeft die drie alleen een gedeelde VORM. Welke tekst er staat
 * en welke `role` hij draagt blijft een keuze van de aanroeper — een
 * component die dat zelf zou beslissen, zou het onderscheid weer inklappen.
 *
 * Server component: geen state, geen effecten, geen dependency buiten `cn`.
 * Geen fysieke richtingsklassen; `items-center`/`text-center`/`gap-*` zijn
 * richtingsneutraal en spiegelen dus vanzelf mee in het Arabisch.
 */

export type EmptyToon = "neutraal" | "fout";

export default function Empty({
  toon = "neutraal",
  role,
  testId,
  className,
  children,
}: {
  toon?: EmptyToon;
  /** `status` bij een neutrale mededeling, `alert` als er iets mis is. */
  role?: "status" | "alert";
  testId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      className={cn(
        "card flex min-w-0 flex-col items-center gap-2 p-6 text-center md:p-10",
        toon === "fout" && "border-crit-soft",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function EmptyTitle({
  toon = "neutraal",
  children,
}: {
  toon?: EmptyToon;
  children: React.ReactNode;
}) {
  return (
    <p className={cn("m-0 font-medium", toon === "fout" ? "text-crit" : "text-ink")}>
      {children}
    </p>
  );
}

export function EmptyBody({ children }: { children: React.ReactNode }) {
  // `max-w-prose` is een tekstmaat in `ch`, geen vaste pixelbreedte: hij krimpt
  // mee op 360px en houdt de regellengte leesbaar op een breed scherm.
  return <p className="m-0 max-w-prose text-[0.875rem] text-ink-soft">{children}</p>;
}

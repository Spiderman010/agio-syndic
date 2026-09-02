import { Link } from "@/navigation";
import Card from "@/components/ui/Card";
import { cn } from "@/lib/utils";

/**
 * Eén KPI.
 *
 * Bewust sober: label, waarde, een regel context. Geen icoon met een kleur die
 * niets betekent, geen trendpijl — een trend vraagt om een betrouwbare
 * historische berekening en die is er niet, dus hij wordt niet getoond.
 *
 * De waarde staat in een `<p>` en niet in een heading: het is data, geen
 * documentstructuur. Het label is via `aria-labelledby` aan de waarde gekoppeld,
 * zodat een schermlezer "Appels de fonds, 3 000,00 dirham marocain" voorleest in
 * plaats van twee losse fragmenten.
 */
export default function KpiCard({
  id,
  label,
  value,
  hint,
  href,
  tone = "neutral",
}: {
  id: string;
  label: string;
  value: string;
  hint?: string;
  /** Locale-loos pad naar een bestaand scherm, of niets. */
  href?: string | null;
  /** Alleen semantisch: `warn` bij openstaand geld, verder neutraal. */
  tone?: "neutral" | "warn";
}) {
  const labelId = `${id}-label`;

  const inhoud = (
    <>
      <p id={labelId} className="m-0 text-[0.78rem] font-medium text-ink-soft">
        {label}
      </p>
      {/*
        Het bedrag schaalt mee met het scherm. Op 360px staan er twee kaarten
        naast elkaar in ongeveer 162px; een volledig opgemaakt bedrag werd daar
        afgekapt. `break-words` vangt bovendien een uitzonderlijk lang bedrag op
        in plaats van het buiten de kaart te laten lopen.
      */}
      <p
        aria-labelledby={labelId}
        className={cn(
          "mt-1 mb-0 text-[1.15rem] leading-tight font-semibold break-words [font-variant-numeric:tabular-nums] sm:text-[1.35rem]",
          tone === "warn" ? "text-warn" : "text-ink",
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 mb-0 text-[0.72rem] text-ink-soft">{hint}</p>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Card padded={false} className="h-full">
        <Link
          href={href}
          className="block h-full p-4 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
        >
          {inhoud}
        </Link>
      </Card>
    );
  }

  return <Card className="h-full">{inhoud}</Card>;
}

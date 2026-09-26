import { getTranslations } from "next-intl/server";
import { Link } from "@/navigation";
import {
  heeftActieveFilters,
  lotsHref,
  lotsHrefLeeg,
  type LotsFilters,
  type LotsParam,
} from "@/lib/lotsFilters";

/**
 * De actieve filters, elk als één wegklikbare chip.
 *
 * ── EEN CHIP IS EEN LINK ───────────────────────────────────────────────────
 *
 * De Admin Kit-chip is een client component met een `onRemove`-callback. Die
 * vorm is hier niet over te nemen en ook niet nodig: wat een chip doet is naar
 * dezelfde lijst navigeren met één parameter minder. Dat IS een link. Daarmee
 * werkt wegklikken zonder JavaScript, is het resultaat deelbaar en kan de
 * gebruiker het met de terugknop ongedaan maken.
 *
 * Elke chip-href wordt gebouwd uit de HUIDIGE filters met precies één parameter
 * op `null`. De andere filters reizen dus mee — wie het typefilter weghaalt,
 * houdt zijn zoekterm. Het gebouw-id en de locale staan in het pad en kunnen
 * daardoor niet sneuvelen.
 *
 * ── WAT "ALLES WISSEN" WIST ────────────────────────────────────────────────
 *
 * Alleen de lotsparameters. Een onbekende parameter die iemand aan de URL heeft
 * geplakt blijft staan: hij is niet van dit scherm en dus niet van deze knop.
 *
 * ── GEEN CHIP ZONDER FILTER ────────────────────────────────────────────────
 *
 * Een afgewezen URL-waarde (`?status=bestaatniet`) filtert niet en krijgt hier
 * dus ook geen chip. Een chip die niets doet zou suggereren dat de lijst
 * ingeperkt is terwijl hij compleet is.
 */
export default function LotsFilterChips({
  buildingId,
  filters,
  overige,
  t,
}: {
  buildingId: string;
  filters: LotsFilters;
  /** Queryparameters die niet van dit scherm zijn; blijven ongemoeid. */
  overige?: Readonly<Record<string, string>>;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  if (!heeftActieveFilters(filters)) return null;

  const chips: Array<{ param: LotsParam; label: string; waarde: string }> = [];
  if (filters.zoekterm !== "") {
    chips.push({ param: "q", label: t("search.label"), waarde: filters.zoekterm });
  }
  if (filters.type !== null) {
    chips.push({
      param: "type",
      label: t("filters.type"),
      waarde: t(`unitType.${filters.type}` as never),
    });
  }
  if (filters.status !== null) {
    chips.push({
      param: "status",
      label: t("filters.status"),
      waarde: t(`status.${filters.status}` as never),
    });
  }

  return (
    <section aria-labelledby="lots-filters-kop" className="mb-4">
      <h2 id="lots-filters-kop" className="sr-only">
        {t("filters.activeTitle")}
      </h2>
      <div className="flex flex-wrap items-center gap-2" data-testid="lots-chips">
        {chips.map((chip) => (
          <Link
            key={chip.param}
            href={lotsHref(buildingId, filters, { [chip.param]: null }, overige)}
            data-testid={`lots-chip-${chip.param}`}
            className="badge flex min-w-0 max-w-full items-center gap-1.5 border-line-strong bg-surface-2 text-ink no-underline hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
          >
            <span className="text-ink-soft">{chip.label}</span>
            <span className="min-w-0 truncate font-medium">{chip.waarde}</span>
            {/* Het kruisje is decoratief; de toegankelijke naam staat in de
                verborgen tekst, want "×" voorgelezen zegt niets. */}
            <span aria-hidden="true" className="text-ink-soft">
              ×
            </span>
            <span className="sr-only">
              {t("filters.remove", { filter: `${chip.label}: ${chip.waarde}` })}
            </span>
          </Link>
        ))}

        <Link
          href={lotsHrefLeeg(buildingId, overige)}
          data-testid="lots-chips-clear"
          className="text-[0.8rem] text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
        >
          {t("filters.clearAll")}
        </Link>
      </div>
    </section>
  );
}

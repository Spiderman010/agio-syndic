import { getTranslations } from "next-intl/server";
import Card from "@/components/ui/Card";
import { buttonClasses } from "@/components/ui/Button";
import {
  LOT_SORT_DIRS,
  LOT_SORT_KEYS,
  LOT_STATUSSEN,
  type LotsFilters,
} from "@/lib/lotsFilters";

/**
 * Zoeken, filteren en sorteren binnen dit gebouw.
 *
 * ── ÉÉN FORM, GEEN CLIENT ──────────────────────────────────────────────────
 *
 * Alle velden zitten in één `method="get"`-form. Submitten zet de hele toestand
 * in de URL en de server filtert; geen `use client`, geen state, geen
 * JavaScript nodig. Een gedeelde link en de terugknop werken daardoor vanzelf.
 *
 * ── WAAROM GEEN SORTEERBARE TABELKOPPEN ────────────────────────────────────
 *
 * Sorteren via de koppen betekent per kolom een eigen link die ALLE actieve
 * filters moet meenemen. Dat is precies het soort duplicatie waar links
 * stilletjes van elkaar gaan afwijken zodra er een filter bijkomt. Twee selects
 * in dit form houden één bron van waarheid, en ze werken op 360px net zo goed.
 *
 * ── LAYOUT ─────────────────────────────────────────────────────────────────
 *
 * Eén kolom op mobiel, twee vanaf `sm`, en vanaf `lg` één rij waarin het
 * zoekveld twee keer zo breed is als de filters. Geen fysieke richtingsklassen:
 * het grid en `gap` spiegelen in het Arabisch vanzelf mee.
 */
export default function LotsToolbar({
  filters,
  types,
  t,
}: {
  filters: LotsFilters;
  /** De lottypes die in dit gebouw werkelijk voorkomen, uit de data. */
  types: readonly string[];
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  return (
    <section aria-labelledby="lots-zoek-kop" className="mb-4">
      <Card>
        <form
          method="get"
          data-testid="lots-toolbar"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end"
        >
          <div className="min-w-0">
            <label className="label" htmlFor="lots-q">
              <span id="lots-zoek-kop">{t("search.label")}</span>
            </label>
            <input
              id="lots-q"
              name="q"
              type="search"
              defaultValue={filters.zoekterm}
              placeholder={t("search.placeholder")}
              className="input w-full"
            />
          </div>

          <div className="min-w-0">
            <label className="label" htmlFor="lots-type">
              {t("filters.type")}
            </label>
            <select
              id="lots-type"
              name="type"
              defaultValue={filters.type ?? ""}
              className="input w-full"
            >
              <option value="">{t("filters.allTypes")}</option>
              {types.map((type) => (
                <option key={type} value={type}>
                  {t(`unitType.${type}` as never)}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-0">
            <label className="label" htmlFor="lots-status">
              {t("filters.status")}
            </label>
            <select
              id="lots-status"
              name="status"
              defaultValue={filters.status ?? ""}
              className="input w-full"
            >
              <option value="">{t("filters.allStatuses")}</option>
              {LOT_STATUSSEN.map((status) => (
                <option key={status} value={status}>
                  {t(`status.${status}` as never)}
                </option>
              ))}
            </select>
          </div>

          {/* Sorteersleutel en richting zijn twee parameters en dus twee velden;
              samen onder één label, zodat het één keuze blijft op het scherm. */}
          <div className="min-w-0">
            <label className="label" htmlFor="lots-sort">
              {t("filters.sort")}
            </label>
            <select
              id="lots-sort"
              name="sort"
              defaultValue={filters.sort}
              className="input w-full"
            >
              {LOT_SORT_KEYS.map((sleutel) => (
                <option key={sleutel} value={sleutel}>
                  {t(`filters.sortBy.${sleutel}` as never)}
                </option>
              ))}
            </select>
            <select
              id="lots-dir"
              name="dir"
              defaultValue={filters.dir}
              aria-label={t("filters.direction")}
              className="input mt-2 w-full"
            >
              {LOT_SORT_DIRS.map((richting) => (
                <option key={richting} value={richting}>
                  {t(`filters.dir.${richting}` as never)}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" className={buttonClasses("secondary")}>
            {t("filters.apply")}
          </button>
        </form>
      </Card>
    </section>
  );
}

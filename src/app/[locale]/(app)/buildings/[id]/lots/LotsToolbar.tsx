import { getTranslations } from "next-intl/server";
import Card from "@/components/ui/Card";
import { buttonClasses } from "@/components/ui/Button";

/**
 * Zoeken binnen dit gebouw.
 *
 * Een gewone `method="get"`-form, geen client component: de zoekterm staat in
 * de URL, het filteren gebeurt op de server en de route werkt zonder
 * JavaScript. Dat is bestaand gedrag en blijft in deze fase ongewijzigd —
 * sortering, paginatie en filterchips horen bij een latere stap.
 */
export default function LotsToolbar({
  zoekterm,
  t,
}: {
  zoekterm: string;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  return (
    <section aria-labelledby="lots-zoek-kop" className="mb-5">
      <Card>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 grow">
            <label className="label" htmlFor="lots-q">
              <span id="lots-zoek-kop">{t("search.label")}</span>
            </label>
            <input
              id="lots-q"
              name="q"
              type="search"
              defaultValue={zoekterm}
              placeholder={t("search.placeholder")}
              className="input w-full"
            />
          </div>
          <button type="submit" className={buttonClasses("secondary")}>
            {t("search.submit")}
          </button>
        </form>
      </Card>
    </section>
  );
}

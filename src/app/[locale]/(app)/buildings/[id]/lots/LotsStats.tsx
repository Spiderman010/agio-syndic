import { getTranslations } from "next-intl/server";
import Card, { CardHeader } from "@/components/ui/Card";
import type { TantiemeOverzicht } from "@/lib/ownership";

/**
 * De tantièmesamenvatting: vier cijfers en maximaal vier toelichtingen.
 *
 * ── ELKE CONDITIE KRIJGT EEN EIGEN REGEL ───────────────────────────────────
 *
 * Geen ternary. Een gebouw met zowel een eigendomsprobleem als een
 * tantièmeprobleem moet BEIDE zien; anders lost iemand er één op en loopt hij
 * tegen dezelfde weigering aan.
 *
 * ── DE ROLLEN ZIJN GEEN OPMAAK ─────────────────────────────────────────────
 *
 * `role="alert"` staat alleen waar de weigering onvoorwaardelijk is zodra het
 * lot meedoet: een ontbrekende of ambigue eigenaar (ALLOC_NO_OWNER,
 * ALLOC_AMBIGUOUS_OWNER) en een tantième van nul (ALLOC_WEIGHT_MISSING). Het
 * controletotaal krijgt `role="status"`, want de engine kent daar een
 * gedocumenteerde afwijking (`partial_denominator_until_year`).
 *
 * Geldige mede-eigendom staat hier bewust NIET tussen de waarschuwingen: die is
 * ondersteund en krijgt een neutrale toelichting zonder rol.
 */
export default function LotsStats({
  overzicht,
  aantalLots,
  t,
}: {
  /** Heet `overzicht` omdat dat de naam was toen dit nog in `page.tsx` stond;
   *  de structuurtests herkennen de condities aan die naam. */
  overzicht: TantiemeOverzicht;
  aantalLots: number;
  /** De `lots`-vertaler van de orkestrator; die heeft hem toch al. */
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  return (
    <section aria-labelledby="lots-tantiemes-kop" className="mb-5">
      <Card>
        <CardHeader title={<span id="lots-tantiemes-kop">{t("tantiemes.title")}</span>} />
        <dl className="m-0 grid grid-cols-2 gap-3 text-[0.875rem] lg:grid-cols-4">
          <Cijfer label={t("tantiemes.assigned")} waarde={overzicht.toegekend} />
          <Cijfer label={t("tantiemes.declared")} waarde={overzicht.verklaard} />
          <Cijfer
            label={t("tantiemes.difference")}
            waarde={overzicht.verschil}
            alarm={overzicht.verschil !== 0}
          />
          <Cijfer label={t("tantiemes.lots")} waarde={aantalLots} />
        </dl>

        {!overzicht.eigendomVeilig ? (
          <p className="mt-3 mb-0 text-[0.8rem] text-crit" role="alert">
            {t("tantiemes.warningOwnership")}
          </p>
        ) : null}

        {overzicht.zonderTantieme > 0 ? (
          <p className="mt-2 mb-0 text-[0.8rem] text-warn" role="alert">
            {t("tantiemes.warningZeroTantieme", { count: overzicht.zonderTantieme })}
          </p>
        ) : null}

        {!overzicht.tantiemesKloppen ? (
          <p className="mt-2 mb-0 text-[0.8rem] text-warn" role="status">
            {t("tantiemes.warningTantiemes")}
          </p>
        ) : null}

        {overzicht.medeEigendom > 0 ? (
          <p className="mt-2 mb-0 text-[0.8rem] text-ink-soft">
            {t("tantiemes.coOwnershipNote", { count: overzicht.medeEigendom })}
          </p>
        ) : null}
      </Card>
    </section>
  );
}

function Cijfer({
  label,
  waarde,
  alarm = false,
}: {
  label: string;
  waarde: number;
  alarm?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="m-0 text-[0.72rem] text-ink-soft">{label}</dt>
      <dd
        className={`m-0 text-[1.05rem] font-semibold [font-variant-numeric:tabular-nums] ${
          alarm ? "text-warn" : "text-ink"
        }`}
      >
        {waarde}
      </dd>
    </div>
  );
}

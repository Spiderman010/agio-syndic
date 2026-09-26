import { getTranslations } from "next-intl/server";
import { Link } from "@/navigation";
import Badge from "@/components/ui/Badge";
import type { LotRegel } from "@/lib/lots";
import { STATUS_TONE } from "./LotsTable";

/**
 * De MOBIELE weergave van dezelfde lots.
 *
 * ── DEZELFDE REGELS, NIET DEZELFDE VORM ────────────────────────────────────
 *
 * Deze component krijgt exact de `LotRegel[]` die de tabel krijgt en leest er
 * niets anders uit. Dat is het hele punt: een tweede lijst met eigen logica zou
 * op mobiel een ander verhaal over hetzelfde lot kunnen vertellen. Vandaar ook
 * `STATUS_TONE` uit `LotsTable` en niet een eigen tonentabel — geldige
 * mede-eigendom moet op een telefoon net zo goed `info` zijn als op een laptop.
 *
 * ── WAAROM KAARTEN EN GEEN SMALLE TABEL ────────────────────────────────────
 *
 * Zeven kolommen op 360px betekent horizontaal schuiven om één lot te lezen. De
 * kaartvorm zet dezelfde velden onder elkaar in label/waarde-paren, zodat een
 * lot in één blik te lezen is zonder te scrollen.
 *
 * ── STRUCTUUR ──────────────────────────────────────────────────────────────
 *
 * `<article>` per lot, want elk lot is een op zichzelf staand item; een
 * schermlezer kan er dan per stuk door navigeren. Binnen de kaart: label en
 * status bovenaan, daaronder een raster van twee kolommen met de cijfers, dan de
 * eigenaars en als laatste de bestaande waarschuwing.
 *
 * ── RTL ────────────────────────────────────────────────────────────────────
 *
 * Geen `ml-`, `mr-`, `pl-`, `pr-`, `text-left` of `text-right`. Alles loopt via
 * `gap`, `justify-between` en logische uitlijning, dus het Arabisch spiegelt mee
 * zonder losse regels. Getallen staan in `tabular-nums` zodat ze ook gespiegeld
 * onder elkaar blijven staan.
 */
export default function LotsCards({
  regels,
  t,
}: {
  regels: readonly LotRegel[];
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  return (
    <ul
      className="m-0 flex list-none flex-col gap-3 p-0"
      data-testid="lots-cards"
      aria-label={t("title")}
    >
      {regels.map((regel) => (
        <li key={regel.unit.id} className="min-w-0">
          <article
            data-testid={`lots-card-${regel.unit.id}`}
            className="card min-w-0 p-4"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <h3 className="m-0 min-w-0 text-[0.95rem] font-semibold break-words text-ink">
                {regel.unit.label}
              </h3>
              <Badge tone={STATUS_TONE[regel.status]}>
                {t(`status.${regel.status}` as never)}
              </Badge>
            </div>

            <dl className="m-0 mt-3 grid grid-cols-2 gap-3 text-[0.8rem]">
              <Veld label={t("table.type")}>{t(`unitType.${regel.unit.unit_type}` as never)}</Veld>
              {/* Verdieping en oppervlakte zijn nullable in de database en
                  verschijnen alleen als er werkelijk een waarde is: een rij met
                  "—" kost op een telefoon plaats zonder iets te zeggen. */}
              {regel.unit.floor !== null ? (
                <Veld label={t("table.floor")}>{regel.unit.floor}</Veld>
              ) : null}
              {regel.unit.area_m2 != null ? (
                <Veld label={t("table.area")} cijfer>
                  {String(regel.unit.area_m2)}
                </Veld>
              ) : null}
              <Veld label={t("table.tantiemes")} cijfer>
                {regel.unit.tantiemes}
              </Veld>
            </dl>

            <div className="mt-3 min-w-0 border-t border-line pt-3">
              <p className="m-0 text-[0.72rem] text-ink-soft">{t("table.owner")}</p>
              {regel.aantalActief === 0 ? (
                <p className="m-0 mt-1 text-[0.8rem] text-ink-soft">{t("noOwner")}</p>
              ) : (
                <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                  {regel.eigenaren.map((eigenaar) => (
                    <li
                      key={eigenaar.ownershipId}
                      className="flex min-w-0 flex-wrap items-center gap-1"
                    >
                      <Link
                        href={`/owners/${eigenaar.ownerId}`}
                        className="min-w-0 text-[0.85rem] break-words text-primary"
                      >
                        {eigenaar.naam ?? t("unknownOwner")}
                      </Link>
                      {/* Zelfde voorwaarde als in de tabel: bij gedeelde
                          eigendom moet zichtbaar zijn wie de vordering krijgt. */}
                      {regel.aantalActief > 1 && eigenaar.isPrimaryDebtor ? (
                        <Badge tone="info">{t("primaryDebtor")}</Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        </li>
      ))}
    </ul>
  );
}

/**
 * Eén label/waarde-paar.
 *
 * `cijfer` zet `tabular-nums`, zodat tantièmes en oppervlaktes over de kaarten
 * heen onder elkaar uitlijnen — ook in het Arabisch, want het is een
 * cijferbreedte en geen uitlijning.
 */
function Veld({
  label,
  cijfer = false,
  children,
}: {
  label: string;
  cijfer?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="m-0 text-[0.72rem] text-ink-soft">{label}</dt>
      <dd
        className={`m-0 text-[0.85rem] font-medium break-words text-ink${
          cijfer ? " [font-variant-numeric:tabular-nums]" : ""
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

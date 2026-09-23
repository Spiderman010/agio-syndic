import { getTranslations } from "next-intl/server";
import { Link } from "@/navigation";
import Badge from "@/components/ui/Badge";
import Table, { Td, Th } from "@/components/ui/Table";
import type { LotRegel } from "@/lib/lots";
import type { LotStatus } from "@/lib/ownership";

/**
 * De lotstabel: zeven kolommen, één rij per zichtbaar lot.
 *
 * Leest uitsluitend uit het viewmodel. De classificatie, de lopende eigenaars
 * en de status zijn hier al berekend; deze component beslist niets meer over
 * eigendom — hij zet neer wat er is.
 *
 * `STATUS_TONE` is ongewijzigd meeverhuisd en blijft de plek waar precies één
 * ding staat dat er financieel toe doet: geldige mede-eigendom is `info`, GEEN
 * waarschuwing. Een aangewezen debiteur maakt dat een ondersteunde toestand,
 * en de allocation engine weigert zo'n lot niet.
 */
const STATUS_TONE: Record<LotStatus, "good" | "warn" | "crit" | "info"> = {
  compleet: "good",
  zonderEigenaar: "crit",
  // Blokkeert de oproep net zo hard als een lot zonder eigenaar.
  ambigu: "crit",
  // GEEN waarschuwing: een aangewezen debiteur maakt dit een geldige toestand.
  medeEigendom: "info",
  zonderTantieme: "warn",
};

export default function LotsTable({
  regels,
  t,
}: {
  regels: readonly LotRegel[];
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  return (
    <Table caption={t("title")}>
      <thead>
        <tr>
          <Th>{t("table.label")}</Th>
          <Th>{t("table.type")}</Th>
          <Th>{t("table.floor")}</Th>
          <Th align="end">{t("table.area")}</Th>
          <Th align="end">{t("table.tantiemes")}</Th>
          <Th>{t("table.owner")}</Th>
          <Th>{t("table.status")}</Th>
        </tr>
      </thead>
      <tbody>
        {regels.map((regel) => (
          <tr key={regel.unit.id}>
            <Td>
              <span className="font-medium">{regel.unit.label}</span>
            </Td>
            <Td>{t(`unitType.${regel.unit.unit_type}` as never)}</Td>
            <Td>{regel.unit.floor ?? "—"}</Td>
            <Td align="end">
              {regel.unit.area_m2 == null ? "—" : String(regel.unit.area_m2)}
            </Td>
            <Td align="end">{regel.unit.tantiemes}</Td>
            <Td>
              {regel.aantalActief === 0 ? (
                <span className="text-[0.8rem] text-ink-soft">{t("noOwner")}</span>
              ) : (
                <span className="flex flex-col gap-0.5">
                  {regel.eigenaren.map((eigenaar) => (
                    <span
                      key={eigenaar.ownershipId}
                      className="flex flex-wrap items-center gap-1"
                    >
                      <Link
                        href={`/owners/${eigenaar.ownerId}`}
                        className="text-[0.85rem] text-primary"
                      >
                        {eigenaar.naam ?? t("unknownOwner")}
                      </Link>
                      {/*
                        Bij gedeelde eigendom moet zichtbaar zijn WIE de
                        vordering krijgt. De statuskolom toont dan niet altijd
                        "mede-eigendom" — een tantième van nul weegt zwaarder —
                        dus deze markering staat hier, waar hij onafhankelijk van
                        die precedentie blijft staan.
                      */}
                      {regel.aantalActief > 1 && eigenaar.isPrimaryDebtor ? (
                        <Badge tone="info">{t("primaryDebtor")}</Badge>
                      ) : null}
                    </span>
                  ))}
                </span>
              )}
            </Td>
            <Td>
              <Badge tone={STATUS_TONE[regel.status]}>
                {t(`status.${regel.status}` as never)}
              </Badge>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

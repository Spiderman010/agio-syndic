import { getTranslations } from "next-intl/server";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { canWrite } from "@/lib/roles";
import { Link } from "@/navigation";
import Card, { CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Table, { Td, Th } from "@/components/ui/Table";
import { buttonClasses } from "@/components/ui/Button";
import { formatDate } from "@/lib/money";
import {
  assembleOwnership,
  currentOwnerships,
  groupByUnit,
  lotStatus,
  matchesUnitSearch,
  tantiemeOverzicht,
  type LotStatus,
  type OwnerRow,
  type OwnershipRow,
  type UnitRow,
} from "@/lib/ownership";
import LotForm from "./LotForm";
import { LinkFirstOwnerForm, TransferOwnershipForm } from "./OwnershipForms";
import { createLot, updateLot } from "./actions";

/**
 * Lots van ÉÉN gebouw.
 *
 * ── GEBOUWSCOPE ────────────────────────────────────────────────────────────
 *
 * `units` draagt geen `organization_id`; de tenantgrens loopt via
 * `building_id -> buildings.organization_id`. Het gebouw uit de URL wordt
 * daarom eerst tegen de actieve organisatie gecontroleerd. Een onbekend of
 * vreemd gebouw levert een melding op en NOOIT een organisatiebrede lijst —
 * dat zou lots van een ander gebouw als die van dit gebouw presenteren.
 *
 * ── EIGENDOMSTOESTANDEN ────────────────────────────────────────────────────
 *
 * Er worden ALLE eigendomsrijen van deze lots opgehaald, niet alleen de
 * lopende. Dat onderscheid bepaalt welke actie een lot krijgt:
 *
 *   geen enkele rij      -> eerste koppeling mogelijk
 *   alleen gesloten rijen -> geen actie; heractiveren valt buiten deze sprint
 *   precies één lopende  -> overdracht mogelijk
 *   meerdere lopende     -> mede-eigendom; overdracht is niet gedefinieerd
 *
 * Zonder die extra rijen zou het scherm een koppelknop tonen op een lot met
 * gesloten historie, waarna `link_first_owner` terecht met
 * OWNERSHIP_HISTORY_EXISTS faalt — een knop waarvan we wéten dat hij faalt.
 */
export default async function LotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { locale, id: buildingId } = await params;
  const { q } = await searchParams;
  const { org, role } = await requireOrg();
  const t = await getTranslations("lots");
  const supabase = await createClient();
  const mayWrite = canWrite(role);
  const zoekterm = (q ?? "").trim();
  const vandaag = new Date().toISOString().slice(0, 10);

  const buildingRes = await supabase
    .from("buildings")
    .select("id, name, total_tantiemes")
    .eq("id", buildingId)
    .eq("organization_id", org.id)
    .maybeSingle();

  if (buildingRes.error) return <Fout t={t} />;
  if (!buildingRes.data) {
    return (
      <Card>
        <p className="m-0 font-medium" role="status">
          {t("notFound")}
        </p>
        <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">
          <Link href="/buildings" className="text-primary">
            {t("backToBuildings")}
          </Link>
        </p>
      </Card>
    );
  }
  const building = buildingRes.data as {
    id: string;
    name: string;
    total_tantiemes: number;
  };

  const unitRes = await supabase
    .from("units")
    .select("id, building_id, label, unit_type, tantiemes, floor, area_m2")
    .eq("building_id", buildingId)
    .order("label", { ascending: true });
  const units = unitRes.error ? null : ((unitRes.data ?? []) as UnitRow[]);

  const unitIds = (units ?? []).map((u) => u.id);
  const ownershipRes =
    unitIds.length > 0
      ? await supabase
          .from("ownership")
          .select("id, unit_id, owner_id, share, start_date, end_date, is_primary_debtor")
          .in("unit_id", unitIds)
      : { data: [] as OwnershipRow[], error: null };
  const ownership = ownershipRes.error ? null : ((ownershipRes.data ?? []) as OwnershipRow[]);

  const ownerRes = await supabase
    .from("owners")
    .select("id, full_name, is_company, email, phone, language, is_mre")
    .eq("organization_id", org.id)
    .order("full_name", { ascending: true });
  const owners = ownerRes.error ? null : ((ownerRes.data ?? []) as OwnerRow[]);

  const bronnen = assembleOwnership({ units, ownership, owners });
  if (bronnen.status === "error") return <Fout t={t} />;

  const perUnit = groupByUnit(bronnen.ownership);
  const ownerNaam = new Map(bronnen.owners.map((o) => [o.id, o.full_name]));
  const overzicht = tantiemeOverzicht(bronnen.units, perUnit, building.total_tantiemes);
  const zichtbaar = bronnen.units.filter((u) => matchesUnitSearch(u, zoekterm));

  return (
    <>
      <header className="mb-5">
        <h1 className="m-0 text-[1.35rem] font-semibold break-words">{t("title")}</h1>
        <p className="mt-1 mb-0 text-[0.85rem] text-ink-soft">
          {t("subtitle", { building: building.name })}
        </p>
      </header>

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
            <Cijfer label={t("tantiemes.lots")} waarde={bronnen.units.length} />
          </dl>

          {/*
            De aantallen staan al in de definitielijst hierboven; deze regel legt
            uit wat ze BETEKENEN. Bewust zonder interpolatie: een zin die drie
            getallen tegelijk vervoegt leest in geen van de drie talen goed, en
            de cijfers staan er letterlijk naast.
          */}
          {!overzicht.oproepVeilig ? (
            <p className="mt-3 mb-0 text-[0.8rem] text-warn" role="status">
              {t("tantiemes.warning")}
            </p>
          ) : null}
        </Card>
      </section>

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

      {bronnen.units.length === 0 ? (
        <Card>
          <p className="m-0 font-medium">{t("empty.title")}</p>
          <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("empty.body")}</p>
        </Card>
      ) : zichtbaar.length === 0 ? (
        <Card>
          <p className="m-0 text-[0.875rem] text-ink-soft" role="status">
            {t("search.none", { term: zoekterm })}
          </p>
        </Card>
      ) : (
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
            {zichtbaar.map((unit) => {
              const rijen = perUnit.get(unit.id) ?? [];
              const lopend = currentOwnerships(rijen);
              const status = lotStatus(unit, rijen);
              return (
                <tr key={unit.id}>
                  <Td>
                    <span className="font-medium">{unit.label}</span>
                  </Td>
                  <Td>{t(`unitType.${unit.unit_type}` as never)}</Td>
                  <Td>{unit.floor ?? "—"}</Td>
                  <Td align="end">{unit.area_m2 == null ? "—" : String(unit.area_m2)}</Td>
                  <Td align="end">{unit.tantiemes}</Td>
                  <Td>
                    {lopend.length === 0 ? (
                      <span className="text-[0.8rem] text-ink-soft">{t("noOwner")}</span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        {lopend.map((rij) => (
                          <Link
                            key={rij.id}
                            href={`/owners/${rij.owner_id}`}
                            className="text-[0.85rem] text-primary"
                          >
                            {ownerNaam.get(rij.owner_id) ?? t("unknownOwner")}
                          </Link>
                        ))}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <StatusBadge status={status} label={t(`status.${status}` as never)} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {mayWrite && zichtbaar.length > 0 ? (
        <section aria-labelledby="lots-acties-kop" className="mt-6">
          <h2 id="lots-acties-kop" className="mb-2 text-[1rem] font-semibold">
            {t("actions.title")}
          </h2>
          <div className="flex flex-col gap-3">
            {zichtbaar.map((unit) => {
              const rijen = perUnit.get(unit.id) ?? [];
              const lopend = currentOwnerships(rijen);
              const heeftHistorie = rijen.length > 0;
              const huidige = lopend.length === 1 ? lopend[0] : null;

              return (
                <Card key={unit.id}>
                  <details>
                    <summary className="cursor-pointer text-[0.9rem] font-medium">
                      {unit.label}
                    </summary>

                    <div className="mt-3 flex flex-col gap-4">
                      <div>
                        <h3 className="mt-0 mb-2 text-[0.85rem] font-semibold text-ink-soft">
                          {t("form.editTitle")}
                        </h3>
                        <LotForm
                          action={updateLot}
                          buildingId={buildingId}
                          submitLabel={t("form.save")}
                          lot={unit}
                        />
                      </div>

                      <div>
                        <h3 className="mt-0 mb-2 text-[0.85rem] font-semibold text-ink-soft">
                          {t("ownership.title")}
                        </h3>
                        {!heeftHistorie ? (
                          <LinkFirstOwnerForm
                            buildingId={buildingId}
                            unitId={unit.id}
                            owners={bronnen.owners}
                            today={vandaag}
                          />
                        ) : huidige ? (
                          <TransferOwnershipForm
                            buildingId={buildingId}
                            unitId={unit.id}
                            current={huidige}
                            currentOwnerName={
                              ownerNaam.get(huidige.owner_id) ?? t("unknownOwner")
                            }
                            owners={bronnen.owners}
                            today={vandaag}
                            periodLabel={t("ownership.since", {
                              date: formatDate(huidige.start_date, locale),
                            })}
                          />
                        ) : lopend.length > 1 ? (
                          <p className="m-0 text-[0.8rem] text-ink-soft" role="status">
                            {t("ownership.coOwned")}
                          </p>
                        ) : (
                          <p className="m-0 text-[0.8rem] text-ink-soft" role="status">
                            {t("ownership.historyOnly")}
                          </p>
                        )}
                      </div>
                    </div>
                  </details>
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}

      {mayWrite ? (
        <section aria-labelledby="lots-nieuw-kop" className="mt-6">
          <Card>
            <CardHeader title={<span id="lots-nieuw-kop">{t("form.createTitle")}</span>} />
            <LotForm
              action={createLot}
              buildingId={buildingId}
              submitLabel={t("form.create")}
            />
          </Card>
        </section>
      ) : null}
    </>
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

const STATUS_TONE: Record<LotStatus, "good" | "warn" | "crit" | "info"> = {
  compleet: "good",
  zonderEigenaar: "crit",
  medeEigendom: "warn",
  zonderTantieme: "warn",
};

function StatusBadge({ status, label }: { status: LotStatus; label: string }) {
  return <Badge tone={STATUS_TONE[status]}>{label}</Badge>;
}

function Fout({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <Card>
      <p className="m-0 font-medium text-crit" role="alert">
        {t("loadError.title")}
      </p>
      <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("loadError.body")}</p>
    </Card>
  );
}

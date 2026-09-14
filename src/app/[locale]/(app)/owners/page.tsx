import { getTranslations } from "next-intl/server";
import { Users } from "lucide-react";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { canWrite } from "@/lib/roles";
import { Link } from "@/navigation";
import Card, { CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Table, { Td, Th } from "@/components/ui/Table";
import { buttonClasses } from "@/components/ui/Button";
import {
  assembleOwnership,
  matchesSearch,
  ownerScopes,
  type OwnerRow,
  type OwnershipRow,
} from "@/lib/ownership";
import OwnerForm from "./OwnerForm";
import { createOwner } from "./actions";

/**
 * Organisatiebrede lijst van copropriétaires.
 *
 * ── WAAROM ORGANISATIEBREED ────────────────────────────────────────────────
 *
 * `owners.organization_id` is NOT NULL en er is geen `building_id`: een
 * eigenaar hoort bij de organisatie, niet bij een gebouw. Hij kan lots in
 * meerdere gebouwen bezitten en verschijnt hier daarom precies ÉÉN keer, met de
 * gebouwen waarin hij op dit moment lots heeft.
 *
 * Omgekeerd geldt NIET dat elke organisatie-eigenaar bij elk gebouw hoort. De
 * kolom "gebouwen" toont uitsluitend de gebouwen waar deze eigenaar werkelijk
 * een actueel lot heeft; is die leeg, dan staat er expliciet dat er geen actueel
 * lot is in plaats van een leeg vakje.
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────
 *
 * Vier queries, geen enkele in een lus. Faalt er één, dan wordt er GEEN lijst
 * getoond maar een foutmelding. Een mislukte eigendomsquery zou anders als
 * "deze eigenaar heeft geen lots" op het scherm komen — precies het signaal
 * waarop een beheerder zou handelen door een koppeling te maken die er al is.
 */
export default async function OwnersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const { org, role } = await requireOrg();
  const t = await getTranslations("owners");
  const supabase = await createClient();
  const mayWrite = canWrite(role);
  const zoekterm = (q ?? "").trim();

  const ownerRes = await supabase
    .from("owners")
    .select("id, full_name, is_company, email, phone, language, is_mre")
    .eq("organization_id", org.id)
    .order("full_name", { ascending: true });

  const buildingRes = await supabase
    .from("buildings")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name", { ascending: true });

  const buildings = buildingRes.error
    ? null
    : ((buildingRes.data ?? []) as { id: string; name: string }[]);

  // De lots van de organisatie, via de gebouwen: `units` draagt zelf geen
  // organization_id, dus de tenantgrens loopt hier over building_id.
  const buildingIds = (buildings ?? []).map((b) => b.id);
  const unitRes =
    buildingIds.length > 0
      ? await supabase.from("units").select("id, building_id").in("building_id", buildingIds)
      : { data: [] as { id: string; building_id: string }[], error: null };
  const units = unitRes.error
    ? null
    : ((unitRes.data ?? []) as { id: string; building_id: string }[]);

  const unitIds = (units ?? []).map((u) => u.id);
  const ownershipRes =
    unitIds.length > 0
      ? await supabase
          .from("ownership")
          .select("id, unit_id, owner_id, share, start_date, end_date, is_primary_debtor")
          .in("unit_id", unitIds)
          .is("end_date", null)
      : { data: [] as OwnershipRow[], error: null };
  const ownership = ownershipRes.error ? null : ((ownershipRes.data ?? []) as OwnershipRow[]);

  const bronnen = assembleOwnership({
    units,
    ownership,
    owners: ownerRes.error ? null : ((ownerRes.data ?? []) as OwnerRow[]),
  });

  if (bronnen.status === "error" || buildings === null) {
    return (
      <>
        <Kop t={t} />
        <Card>
          <p className="m-0 font-medium text-crit" role="alert">
            {t("loadError.title")}
          </p>
          <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("loadError.body")}</p>
        </Card>
      </>
    );
  }

  const buildingNaam = new Map(buildings.map((b) => [b.id, b.name]));
  const unitBuilding = new Map(bronnen.units.map((u) => [u.id, u.building_id]));
  const scopes = ownerScopes(bronnen.ownership, unitBuilding, buildingNaam);

  const zichtbaar = bronnen.owners.filter((o) => matchesSearch(o, zoekterm));

  return (
    <>
      <Kop t={t} />

      <section aria-labelledby="owners-zoek-kop" className="mb-5">
        <Card>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 grow">
              <label className="label" htmlFor="owners-q">
                <span id="owners-zoek-kop">{t("search.label")}</span>
              </label>
              <input
                id="owners-q"
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

      {bronnen.owners.length === 0 ? (
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
        <section aria-labelledby="owners-lijst-kop">
          <h2 id="owners-lijst-kop" className="sr-only">
            {t("title")}
          </h2>
          <Table caption={t("title")}>
            <thead>
              <tr>
                <Th>{t("table.name")}</Th>
                <Th>{t("table.contact")}</Th>
                <Th>{t("table.language")}</Th>
                <Th align="end">{t("table.lots")}</Th>
                <Th>{t("table.buildings")}</Th>
              </tr>
            </thead>
            <tbody>
              {zichtbaar.map((owner) => {
                const scope = scopes.get(owner.id);
                return (
                  <tr key={owner.id}>
                    <Td>
                      <Link href={`/owners/${owner.id}`} className="font-medium text-primary">
                        {owner.full_name}
                      </Link>
                      <span className="mt-1 flex flex-wrap gap-1">
                        <Badge tone="info">
                          {owner.is_company ? t("type.company") : t("type.person")}
                        </Badge>
                        {owner.is_mre ? <Badge tone="warn">{t("mre")}</Badge> : null}
                      </span>
                    </Td>
                    <Td>
                      <span className="block text-[0.8rem] break-words">
                        {owner.email ?? t("noContact")}
                      </span>
                      {owner.phone ? (
                        <span className="block text-[0.8rem] text-ink-soft">{owner.phone}</span>
                      ) : null}
                    </Td>
                    <Td>{owner.language.toUpperCase()}</Td>
                    <Td align="end">{scope?.lotCount ?? 0}</Td>
                    <Td>
                      {scope && scope.buildingIds.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {scope.buildingIds.map((id) => (
                            <Link
                              key={id}
                              href={`/buildings/${id}/lots`}
                              className="text-[0.8rem] text-primary"
                            >
                              {buildingNaam.get(id) ?? t("unknownBuilding")}
                            </Link>
                          ))}
                        </span>
                      ) : (
                        <span className="text-[0.8rem] text-ink-soft">{t("noLots")}</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </section>
      )}

      {mayWrite ? (
        <section aria-labelledby="owners-nieuw-kop" className="mt-6">
          <Card>
            <CardHeader title={<span id="owners-nieuw-kop">{t("create.title")}</span>} />
            <OwnerForm action={createOwner} submitLabel={t("create.submit")} />
          </Card>
        </section>
      ) : null}
    </>
  );
}

function Kop({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <header className="mb-5 flex flex-wrap items-center gap-2">
      <Users size={20} aria-hidden="true" className="text-ink-soft" />
      <h1 className="m-0 text-[1.35rem] font-semibold">{t("title")}</h1>
      <p className="m-0 w-full text-[0.85rem] text-ink-soft">{t("subtitle")}</p>
    </header>
  );
}

import { getTranslations } from "next-intl/server";
import { requireOrg } from "@/lib/org";
import { canWrite } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { Link } from "@/navigation";
import Card, { CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Empty, { EmptyBody, EmptyTitle } from "@/components/ui/Empty";
import { assembleOwnership, type OwnerRow, type OwnershipRow } from "@/lib/ownership";
import { BlokAanmaken, BlokBewerken } from "./BlokBeheer";
import BulkLots from "./BulkLots";
import LotBewerken from "./LotBewerken";
import {
  bouwIndeling,
  heeftTantieme,
  type BlokGroep,
  type LayoutUnitRow,
  type LotStaat,
  type LotTegel,
  type BlockRow,
} from "@/lib/layout";

/**
 * De INDELING van één gebouw: welke blokken bestaan er en wat hangt eraan.
 *
 * Lezen is de kern: dit scherm beantwoordt één vraag — wat bevat dit gebouw
 * werkelijk — en mag dat antwoord nooit verzinnen. Daar bovenop staat sinds
 * deze wijziging blok- en lotbeheer voor schrijfrollen. Eigendom koppelen,
 * overdragen en verwijderen horen er uitdrukkelijk NIET bij; dat zijn andere
 * schermen met een andere risicoklasse.
 *
 * ── BEWERKEN LOOPT VIA DE URL ──────────────────────────────────────────────
 *
 * `?blok=<id>` en `?edit=<unit_id>` openen één paneel. Een formulier per rij
 * zou bij 48 lots 48 formulieren renderen; nu is het er hooguit één. Het werkt
 * bovendien zonder JavaScript en is deelbaar.
 *
 * ── WAAROM DIT EEN EIGEN ROUTE IS ──────────────────────────────────────────
 *
 * Het bestaande overzichtsscherm (`buildings/[id]/page.tsx`) leest zijn
 * bronnen fail-open: `(unitsData ?? [])` maakt van een mislukte query een lege
 * lijst en toont dan "Aucun lot." Een fail-closed sectie daarnaast zetten zou
 * twee tegenstrijdige antwoorden op één pagina opleveren. Dat scherm heeft een
 * eigen opruiming nodig; tot die tijd staat deze indeling apart.
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────
 *
 * Vier bronnen, en één mislukking onderdrukt alles. `units`, `ownership` en
 * `owners` lopen door dezelfde `assembleOwnership()` als het lotsscherm — geen
 * tweede datapad. `blocks` krijgt daarnaast een eigen nullcontrole, want zonder
 * blokken is er geen indeling te tonen, alleen een vermoeden.
 *
 * De reden is niet theoretisch. Een mislukte `ownership`-query die als lege
 * lijst doorgaat, zet elk lot op "vrij" — en nodigt een beheerder uit een
 * eigenaar te koppelen die er allang is.
 */

const STAAT_TOON: Record<LotStaat, "good" | "warn" | "info"> = {
  gekoppeld: "good",
  vrij: "info",
  onvolledig: "warn",
};

export default async function IndelingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ blok?: string; edit?: string }>;
}) {
  const { id: buildingId } = await params;
  const { blok: gekozenBlokId, edit: gekozenLotId } = await searchParams;
  const { org, role } = await requireOrg();
  const mayWrite = canWrite(role);
  const t = await getTranslations("indeling");
  const supabase = await createClient();

  const buildingRes = await supabase
    .from("buildings")
    .select("id, name, total_tantiemes")
    .eq("id", buildingId)
    .eq("organization_id", org.id)
    .maybeSingle();

  if (buildingRes.error) {
    logIndelingFout("building", [`buildings:${buildingRes.error.code}`]);
    return <Fout t={t} />;
  }
  if (!buildingRes.data) {
    return (
      <Empty role="status" testId="indeling-notfound">
        <EmptyTitle>{t("notFound")}</EmptyTitle>
        <EmptyBody>
          <Link href="/buildings" className="text-primary">
            {t("backToBuildings")}
          </Link>
        </EmptyBody>
      </Empty>
    );
  }
  const building = buildingRes.data as {
    id: string;
    name: string;
    total_tantiemes: number;
  };

  const blockRes = await supabase
    .from("blocks")
    .select("id, building_id, code, name, sort_order, archived_at")
    .eq("building_id", buildingId)
    .eq("organization_id", org.id)
    .order("sort_order", { ascending: true });
  const blocks = blockRes.error ? null : ((blockRes.data ?? []) as BlockRow[]);

  const unitRes = await supabase
    .from("units")
    .select("id, building_id, block_id, label, unit_type, tantiemes")
    .eq("building_id", buildingId)
    .order("label", { ascending: true });
  const units = unitRes.error ? null : ((unitRes.data ?? []) as LayoutUnitRow[]);

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
    .select("id, full_name")
    .eq("organization_id", org.id)
    .order("full_name", { ascending: true });
  const owners = ownerRes.error ? null : ((ownerRes.data ?? []) as OwnerRow[]);

  const bronnen = assembleOwnership({ units, ownership, owners });
  if (blocks === null || bronnen.status === "error") {
    const codes: string[] = [];
    if (blockRes.error) codes.push(`blocks:${blockRes.error.code}`);
    if (unitRes.error) codes.push(`units:${unitRes.error.code}`);
    if (ownershipRes.error) codes.push(`ownership:${ownershipRes.error.code}`);
    if (ownerRes.error) codes.push(`owners:${ownerRes.error.code}`);
    logIndelingFout("sources", codes);
    return <Fout t={t} />;
  }

  const indeling = bouwIndeling({
    buildingId,
    blocks,
    units: bronnen.units,
    ownership: bronnen.ownership,
    owners: bronnen.owners,
    totalTantiemes: building.total_tantiemes,
  });
  const { samenvatting } = indeling;

  // Alleen de NIET-gearchiveerde blokken van dit gebouw mogen als doel worden
  // aangeboden; een gearchiveerd blok kiezen zou het meteen weer in gebruik
  // nemen zonder dat iemand daarom vroeg.
  const keuzeBlokken = blocks
    .filter((b) => b.building_id === buildingId && b.archived_at === null)
    .sort((a, b) => a.sort_order - b.sort_order);

  // Gearchiveerde blokken staan niet in de indeling — dat is het punt van
  // archiveren. Maar ze moeten wél bereikbaar blijven, anders is archiveren
  // eenrichtingsverkeer en is de heractiveerknop in het paneel onbereikbaar.
  const gearchiveerdeBlokken = blocks
    .filter((b) => b.building_id === buildingId && b.archived_at !== null)
    .sort((a, b) => a.sort_order - b.sort_order);

  // FAIL-CLOSED op de paneelkeuze: alleen een blok of lot dat aantoonbaar bij
  // DIT gebouw hoort. Een id uit de URL is invoer van de gebruiker, en een
  // vreemd id mag geen paneel openen — ook niet leeg.
  const paneelBlok =
    mayWrite && gekozenBlokId
      ? (blocks.find((b) => b.id === gekozenBlokId && b.building_id === buildingId) ?? null)
      : null;
  const paneelLot =
    mayWrite && gekozenLotId
      ? (bronnen.units.find(
          (u) => u.id === gekozenLotId && u.building_id === buildingId,
        ) ?? null)
      : null;

  return (
    <>
      <header className="mb-5">
        <h1 className="m-0 text-[1.35rem] font-semibold break-words">{t("title")}</h1>
        <p className="mt-1 mb-0 text-[0.85rem] text-ink-soft">
          {t("subtitle", { building: building.name })}
        </p>
      </header>

      {paneelBlok || paneelLot ? (
        <section id="indeling-paneel" className="mb-5">
          {paneelBlok ? <BlokBewerken buildingId={buildingId} blok={paneelBlok} /> : null}
          {paneelLot ? (
            <LotBewerken buildingId={buildingId} lot={paneelLot} blokken={keuzeBlokken} />
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="indeling-samenvatting-kop" className="mb-5">
        <Card>
          <CardHeader
            title={<span id="indeling-samenvatting-kop">{t("summary.title")}</span>}
          />
          <dl className="m-0 grid grid-cols-2 gap-3 text-[0.875rem] lg:grid-cols-5">
            <Cijfer label={t("summary.blocks")} waarde={samenvatting.blokken} />
            <Cijfer label={t("summary.lots")} waarde={samenvatting.lots} />
            <Cijfer label={t("summary.owners")} waarde={samenvatting.eigenaren} />
            <Cijfer label={t("summary.free")} waarde={samenvatting.vrij} />
            <Cijfer
              label={t("summary.tantiemes")}
              waarde={samenvatting.tantiemesToegekend}
              alarm={!samenvatting.tantiemesSluiten}
            />
          </dl>

          {/*
            De markering staat ONDER de cijfers en niet in plaats ervan: het
            toegekende totaal blijft zichtbaar, ook als het niet sluit. Wie het
            verschil moet oplossen heeft beide getallen nodig.
          */}
          {!samenvatting.tantiemesSluiten ? (
            <p className="mt-3 mb-0 text-[0.8rem] text-warn" role="status">
              {t("summary.tantiemesMismatch", {
                toegekend: samenvatting.tantiemesToegekend,
                verklaard: samenvatting.tantiemesVerklaard,
              })}
            </p>
          ) : null}

          {samenvatting.onvolledig > 0 ? (
            <p className="mt-2 mb-0 text-[0.8rem] text-warn" role="status">
              {t("summary.incomplete", { count: samenvatting.onvolledig })}
            </p>
          ) : null}
        </Card>
      </section>

      {indeling.groepen.length === 0 ? (
        <Empty testId="indeling-empty">
          <EmptyTitle>{t("empty.title")}</EmptyTitle>
          <EmptyBody>{t("empty.body")}</EmptyBody>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {indeling.groepen.map((groep) => (
            <Blok
              key={groep.sleutel}
              groep={groep}
              t={t}
              buildingId={buildingId}
              mayWrite={mayWrite}
            />
          ))}
        </div>
      )}

      {mayWrite && gearchiveerdeBlokken.length > 0 ? (
        <section className="mt-6">
          <Card data-testid="indeling-gearchiveerd">
            <CardHeader title={<span>{t("manage.archivedBlocks")}</span>} />
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {gearchiveerdeBlokken.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/buildings/${buildingId}/indeling?blok=${b.id}#indeling-paneel`}
                    className="text-[0.8rem] text-primary break-words"
                    data-testid={`blok-gearchiveerd-${b.id}`}
                  >
                    {b.name ? `${b.code} — ${b.name}` : b.code}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {mayWrite ? (
        <section aria-labelledby="blok-nieuw-kop" className="mt-6 flex flex-col gap-4">
          <BlokAanmaken buildingId={buildingId} />
          <BulkLots
            buildingId={buildingId}
            blokken={keuzeBlokken.map((b) => ({ id: b.id, code: b.code, name: b.name }))}
            totalTantiemes={building.total_tantiemes}
            reedsToegekend={samenvatting.tantiemesToegekend}
          />
        </section>
      ) : (
        <AlleenLezen t={t} />
      )}
    </>
  );
}

/**
 * Wat een LEZER ziet waar een schrijver het beheer krijgt.
 *
 * `role="status"`, niet `alert`: lezen is een geldige rol. Zonder deze regel
 * zou het scherm voor een lezer stilzwijgend onvolledig zijn — dezelfde fout
 * die op het lotsscherm al is rechtgezet.
 */
function AlleenLezen({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <section className="mt-6">
      <Card role="status" data-testid="indeling-readonly">
        <p className="m-0 font-medium">{t("readOnly.title")}</p>
        <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("readOnly.body")}</p>
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

function Blok({
  groep,
  t,
  buildingId,
  mayWrite,
}: {
  groep: BlokGroep;
  t: Awaited<ReturnType<typeof getTranslations>>;
  buildingId: string;
  mayWrite: boolean;
}) {
  const kop =
    groep.soort === "blok"
      ? groep.naam
        ? `${groep.code} — ${groep.naam}`
        : groep.code
      : groep.soort === "zonderBlok"
        ? t("block.noBlock")
        : t("block.unavailable");

  const totaal = groep.lots.length;
  const bezet = groep.telling.gekoppeld;
  const percentage = totaal === 0 ? 0 : Math.round((bezet / totaal) * 100);

  return (
    <Card data-testid={`indeling-blok-${groep.sleutel}`}>
      <CardHeader
        title={<span className="break-words">{kop}</span>}
        actions={
          <span className="flex flex-wrap items-center gap-2 text-[0.78rem]">
            <Badge tone="good">{t("block.linked", { count: groep.telling.gekoppeld })}</Badge>
            <Badge tone="info">{t("block.free", { count: groep.telling.vrij })}</Badge>
            <Badge tone="warn">
              {t("block.incomplete", { count: groep.telling.onvolledig })}
            </Badge>
            {/* Alleen een ECHT blok is bewerkbaar. "Zonder blok" en
                "onbereikbaar" zijn afgeleide groepen, geen rij in `blocks`. */}
            {mayWrite && groep.soort === "blok" ? (
              <Link
                href={`/buildings/${buildingId}/indeling?blok=${groep.sleutel}#indeling-paneel`}
                className="text-primary"
                data-testid={`blok-bewerk-${groep.sleutel}`}
              >
                {t("manage.editBlockLink")}
              </Link>
            ) : null}
          </span>
        }
      />

      {/*
        Een uitzonderingstoestand verdient een zin, geen kleurtje. Deze lots
        wijzen naar een blok dat is gearchiveerd of niet meer bestaat; ze horen
        NIET stilzwijgend bij "zonder blok" te belanden, want ze hebben wel
        degelijk een blok gehad.
      */}
      {groep.soort === "onbereikbaar" ? (
        <p className="mt-0 mb-3 text-[0.8rem] text-warn" role="status">
          {t("block.unavailableHint")}
        </p>
      ) : null}

      {totaal > 0 ? (
        <div
          className="mb-3 h-2 w-full overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("block.occupancy")}
        >
          {/* `inlineSize` in plaats van `width`: logisch, dus in het Arabisch
              groeit de balk vanzelf vanaf de andere kant. */}
          <div className="h-full bg-primary" style={{ inlineSize: `${percentage}%` }} />
        </div>
      ) : null}

      <p className="mt-0 mb-3 text-[0.8rem] text-ink-soft">
        {t("block.subtotal", { tantiemes: groep.tantiemeSubtotaal })}
        {groep.subtotaalOnvolledig ? ` — ${t("block.subtotalIncomplete")}` : ""}
      </p>

      {totaal === 0 ? (
        <p className="m-0 text-[0.8rem] text-ink-soft" role="status">
          {t("block.empty")}
        </p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {groep.lots.map((lot) => (
            <Tegel
              key={lot.id}
              lot={lot}
              t={t}
              buildingId={buildingId}
              mayWrite={mayWrite}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Tegel({
  lot,
  t,
  buildingId,
  mayWrite,
}: {
  lot: LotTegel;
  t: Awaited<ReturnType<typeof getTranslations>>;
  buildingId: string;
  mayWrite: boolean;
}) {
  return (
    <li
      className="card flex min-w-0 flex-col gap-1 p-3"
      data-testid={`indeling-lot-${lot.id}`}
      data-staat={lot.staat}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <strong className="min-w-0 break-words text-[0.9rem]">{lot.label}</strong>
        <Badge tone={STAAT_TOON[lot.staat]}>{t(`status.${lot.staat}` as never)}</Badge>
      </span>

      <span className="text-[0.78rem] text-ink-soft">
        {lot.eigenaarId === null
          ? t("lot.noOwner")
          : (lot.eigenaarNaam ?? t("lot.unknownOwner"))}
      </span>

      <span className="text-[0.78rem] [font-variant-numeric:tabular-nums]">
        {heeftTantieme(lot.tantiemes)
          ? t("lot.tantiemes", { tantiemes: lot.tantiemes as number })
          : t("lot.noTantiemes")}
      </span>

      {mayWrite ? (
        <Link
          href={`/buildings/${buildingId}/indeling?edit=${lot.id}#indeling-paneel`}
          className="text-[0.78rem] text-primary"
          data-testid={`lot-bewerk-${lot.id}`}
        >
          {t("manage.editLotLink")}
        </Link>
      ) : null}
    </li>
  );
}

function Fout({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <Empty toon="fout" role="alert" testId="indeling-unavailable">
      <EmptyTitle toon="fout">{t("loadError.title")}</EmptyTitle>
      <EmptyBody>{t("loadError.body")}</EmptyBody>
    </Empty>
  );
}

/**
 * Wat er in het SERVERLOG terechtkomt als de indeling niet geladen kan worden.
 *
 * Volgt dezelfde conventie als het lotsscherm en `reversalErrorFingerprint`:
 * alleen bron en SQLSTATE. Geen Postgres-tekst, geen id's, geen gebouwnaam,
 * geen eigenaarsnamen. De gebruiker krijgt hoe dan ook één en dezelfde
 * melding — welke tabel faalde is interne structuur.
 */
function logIndelingFout(scope: "building" | "sources", codes: readonly string[]) {
  console.error(`[indeling] load-failed scope=${scope} ${codes.join(" ") || "sqlstate=?"}`);
}

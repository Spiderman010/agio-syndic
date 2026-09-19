import { getTranslations } from "next-intl/server";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { Link } from "@/navigation";
import Card, { CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Empty, { EmptyBody, EmptyTitle } from "@/components/ui/Empty";
import { assembleOwnership, type OwnerRow, type OwnershipRow } from "@/lib/ownership";
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
 * Strikt read-only. Blokken aanmaken, lots toevoegen en eigendom koppelen zijn
 * andere schermen; dit scherm beantwoordt één vraag — wat bevat dit gebouw
 * werkelijk — en mag dat antwoord nooit verzinnen.
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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: buildingId } = await params;
  const { org } = await requireOrg();
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

  return (
    <>
      <header className="mb-5">
        <h1 className="m-0 text-[1.35rem] font-semibold break-words">{t("title")}</h1>
        <p className="mt-1 mb-0 text-[0.85rem] text-ink-soft">
          {t("subtitle", { building: building.name })}
        </p>
      </header>

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
            <Blok key={groep.sleutel} groep={groep} t={t} />
          ))}
        </div>
      )}
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

function Blok({
  groep,
  t,
}: {
  groep: BlokGroep;
  t: Awaited<ReturnType<typeof getTranslations>>;
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
            <Tegel key={lot.id} lot={lot} t={t} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Tegel({
  lot,
  t,
}: {
  lot: LotTegel;
  t: Awaited<ReturnType<typeof getTranslations>>;
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

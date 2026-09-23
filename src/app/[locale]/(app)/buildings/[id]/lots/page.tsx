import { getTranslations } from "next-intl/server";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { canWrite } from "@/lib/roles";
import { Link } from "@/navigation";
import Card, { CardHeader } from "@/components/ui/Card";
import Empty, { EmptyBody, EmptyTitle } from "@/components/ui/Empty";
import { assembleOwnership, type OwnerRow, type OwnershipRow, type UnitRow } from "@/lib/ownership";
import { bouwLotsOverzicht } from "@/lib/lots";
import LotForm from "./LotForm";
import LotActions from "./LotActions";
import LotsStats from "./LotsStats";
import LotsTable from "./LotsTable";
import LotsToolbar from "./LotsToolbar";
import { createLot } from "./actions";

/**
 * Lots van ÉÉN gebouw. Deze module is de ORKESTRATOR: guards, queries,
 * foutafhandeling en het samenstellen van één viewmodel. Alles wat daarna
 * gerenderd wordt, staat in een eigen servercomponent.
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
 *   geen enkele rij       -> eerste koppeling mogelijk
 *   alleen gesloten rijen -> geen actie; heractiveren valt buiten deze sprint
 *   precies één lopende   -> overdracht mogelijk
 *   meerdere lopende      -> overdracht valt buiten DEZE flow
 *
 * Zonder die extra rijen zou het scherm een koppelknop tonen op een lot met
 * gesloten historie, waarna `link_first_owner` terecht met
 * OWNERSHIP_HISTORY_EXISTS faalt — een knop waarvan we wéten dat hij faalt.
 *
 * ── OVERDRACHT VERSUS TOEREKENING ──────────────────────────────────────────
 *
 * Twee onafhankelijke vragen die niet door elkaar mogen lopen:
 *
 *   "kan ik hier overdragen?"   -> nee bij meerdere lopende eigenaars; dat is
 *                                  een grens van deze eenvoudige flow;
 *   "kan de last worden
 *    toegerekend?"              -> ja, zolang er precies één aangewezen
 *                                  debiteur is. Zie `classifyOwnership`.
 *
 * Een lot waar niet kan worden overgedragen is dus NIET automatisch financieel
 * onveilig.
 *
 * ── ÉÉN BEREKENING PER LOT ─────────────────────────────────────────────────
 *
 * Tabel en actielijst liepen hiervoor elk hun eigen lus over de zichtbare lots
 * en riepen beide `classifyOwnership` aan. Dat waren twee onafhankelijke
 * antwoorden op dezelfde vraag. `bouwLotsOverzicht` berekent het één keer; alle
 * secties lezen dezelfde rij.
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

  if (buildingRes.error) {
    logLotsFout("building", [`buildings:${buildingRes.error.code}`]);
    return <Fout t={t} />;
  }
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
  if (bronnen.status === "error") {
    const codes: string[] = [];
    if (unitRes.error) codes.push(`units:${unitRes.error.code}`);
    if (ownershipRes.error) codes.push(`ownership:${ownershipRes.error.code}`);
    if (ownerRes.error) codes.push(`owners:${ownerRes.error.code}`);
    logLotsFout("sources", codes);
    return <Fout t={t} />;
  }

  const overzicht = bouwLotsOverzicht({
    units: bronnen.units,
    ownership: bronnen.ownership,
    owners: bronnen.owners,
    verklaard: building.total_tantiemes,
    zoekterm,
    vandaag,
  });

  return (
    <>
      <header className="mb-5">
        <h1 className="m-0 text-[1.35rem] font-semibold break-words">{t("title")}</h1>
        <p className="mt-1 mb-0 text-[0.85rem] text-ink-soft">
          {t("subtitle", { building: building.name })}
        </p>
      </header>

      <LotsStats
        overzicht={overzicht.samenvatting}
        aantalLots={overzicht.alle.length}
        t={t}
      />

      <LotsToolbar zoekterm={zoekterm} t={t} />

      {/*
        Drie toestanden, één vorm, DRIE BOODSCHAPPEN. Ze delen `Empty` zodat ze
        als één systeem ogen, maar ze houden elk hun eigen sleutel en hun eigen
        `role`. Inklappen tot één generieke "leeg" zou de enige vraag wegpoetsen
        die ertoe doet: weten we dat er niets is, of weten we het niet? De
        mislukte variant komt hier trouwens nooit langs — die keert al eerder
        terug via `Fout`.
      */}
      {overzicht.alle.length === 0 ? (
        <Empty testId="lots-empty">
          <EmptyTitle>{t("empty.title")}</EmptyTitle>
          <EmptyBody>{t("empty.body")}</EmptyBody>
        </Empty>
      ) : overzicht.zichtbaar.length === 0 ? (
        <Empty role="status" testId="lots-no-results">
          <EmptyBody>{t("search.none", { term: zoekterm })}</EmptyBody>
        </Empty>
      ) : (
        <LotsTable regels={overzicht.zichtbaar} t={t} />
      )}

      {mayWrite && overzicht.zichtbaar.length > 0 ? (
        <LotActions
          buildingId={buildingId}
          locale={locale}
          regels={overzicht.zichtbaar}
          owners={bronnen.owners}
          vandaag={vandaag}
          t={t}
        />
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
      ) : (
        <AlleenLezen t={t} />
      )}
    </>
  );
}

function Fout({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <Empty toon="fout" role="alert" testId="lots-unavailable">
      <EmptyTitle toon="fout">{t("loadError.title")}</EmptyTitle>
      <EmptyBody>{t("loadError.body")}</EmptyBody>
    </Empty>
  );
}

/**
 * Wat een LEZER ziet waar een schrijver het aanmaakformulier krijgt.
 *
 * `role="status"`, nadrukkelijk niet `alert`: er is niets mis. Lezen is een
 * geldige rol en geen storing waar iemand achteraan moet.
 *
 * De conditie is `!mayWrite`, nooit "heeft geen leesrecht": elke rol die deze
 * pagina bereikt heeft leesrecht, dus die tak zou onbereikbaar zijn.
 */
function AlleenLezen({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <section className="mt-6">
      <Card role="status" data-testid="lots-readonly">
        <p className="m-0 font-medium">{t("readOnly.title")}</p>
        <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("readOnly.body")}</p>
      </Card>
    </section>
  );
}

/**
 * Wat er in het SERVERLOG terechtkomt als de lijst niet geladen kan worden.
 *
 * De gebruiker krijgt bewust één en dezelfde melding, welke query er ook
 * faalt: welke tabel het was, is interne structuur en hoort niet op het
 * scherm. Maar wie de storing moet oplossen heeft dat onderscheid wél nodig,
 * en dat hoort thuis in het log.
 *
 * Volgt `reversalErrorFingerprint`: alleen bron en SQLSTATE. GEEN
 * Postgres-tekst, geen id's, geen gebouwnaam, geen organisatie — dat zijn
 * klantgegevens en die horen niet in een logregel.
 */
function logLotsFout(scope: "building" | "sources", codes: readonly string[]) {
  console.error(`[lots] load-failed scope=${scope} ${codes.join(" ") || "sqlstate=?"}`);
}

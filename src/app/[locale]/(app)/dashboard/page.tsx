import { getTranslations } from "next-intl/server";
import { ArrowRight, Building2, Receipt, CalendarRange, Wallet } from "lucide-react";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { Link } from "@/navigation";
import { canWrite } from "@/lib/roles";
import Card, { CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Table, { Td, Th } from "@/components/ui/Table";
import { buttonClasses } from "@/components/ui/Button";
import KpiCard from "@/components/dashboard/KpiCard";
import { buildReversalIndex, type ReversalViewRow } from "@/lib/reversal";
import { formatDate, formatMoney, formatMoneyRounded, formatPercent } from "@/lib/money";
import {
  assembleFinancials,
  buildAttentionItems,
  filterToSelectedFiscalYear,
  quickActions,
  recentActivity,
  selectFiscalYears,
  topDebtors,
  type FiscalYearRow,
  type ScopeSelection,
  type SettlementRow,
} from "@/lib/dashboard";

/**
 * Financieel dashboard.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 * Zonder `?building=` organisatiebreed, met de parameter één gebouw.
 *
 * Elke query filtert EXPLICIET op `organization_id` bovenop RLS. RLS scoopt op
 * lidmaatschap en laat dus alle organisaties van de gebruiker door;
 * `requireOrg()` kiest er één.
 *
 * ── BOEKJAAR ───────────────────────────────────────────────────────────────
 * PER GEBOUW één boekjaar; zie `selectFiscalYears`. Een boekjaar hoort bij een
 * gebouw, niet bij een organisatie, dus organisatiebreed rekenen is: per gebouw
 * het eigen boekjaar kiezen en die uitkomsten optellen.
 *
 * ── FOUTEN ─────────────────────────────────────────────────────────────────
 * Fail-closed. Een mislukte query op de financiële scope levert GEEN nullen op
 * maar onderdrukt de bedragen en toont een melding. Een nul die eigenlijk een
 * fout is, is op een financieel dashboard erger dan geen getal.
 *
 * Twee bewuste uitzonderingen:
 *   - eigenaarsnamen: bij een fout tonen we "onbekend" en laten we de BEDRAGEN
 *     ongemoeid, want de namen zijn presentatie en de bedragen komen elders
 *     vandaan;
 *   - integriteitscontroles: een mislukte controle wordt een aandachtspunt
 *     ("kon niet worden gecontroleerd"), nooit een impliciete nul die het
 *     dashboard gezond laat lijken.
 *
 * ── STORNO-INDEX ───────────────────────────────────────────────────────────
 * De storno-index wordt ORGANISATIEBREED opgehaald, nooit per boekjaar. Bewezen
 * met een rollback-probe: een correctie met een valutadatum in het volgende
 * boekjaar boekt de storno in dát jaar, terwijl het origineel in het vorige
 * staat. Een per-boekjaar gescoopte index zou die storno missen en het
 * origineel ten onrechte volledig meetellen.
 */
export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ building?: string }>;
}) {
  const { locale } = await params;
  const { building: buildingParam } = await searchParams;
  const { org, role } = await requireOrg();
  const t = await getTranslations("dashboard");
  const supabase = await createClient();
  const mayWrite = canWrite(role);
  const money = (n: number) => formatMoney(n, locale);
  const moneyKort = (n: number) => formatMoneyRounded(n, locale);

  /** Financieel dragende bronnen die faalden. Niet leeg = geen bedragen tonen. */
  const gefaald = new Set<string>();

  // ── 1. Gebouwen ──────────────────────────────────────────────────────────
  const buildingRes = await supabase
    .from("buildings")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name", { ascending: true });
  if (buildingRes.error) gefaald.add("buildings");
  const buildings = (buildingRes.data ?? []) as { id: string; name: string }[];

  if (gefaald.size > 0) return <Fout t={t} />;
  if (buildings.length === 0) return <LegeOrganisatie t={t} />;

  const gevraagdGebouw = buildingParam ?? null;
  const scopedBuilding = buildings.find((b) => b.id === gevraagdGebouw) ?? null;
  // Een onbekend of niet-toegankelijk id mag niet stil organisatiebrede cijfers
  // opleveren alsof er niets aan de hand is.
  const onbekendGebouwGevraagd = Boolean(gevraagdGebouw) && scopedBuilding === null;
  const scopeBuildings = scopedBuilding ? [scopedBuilding] : buildings;
  const scopeLabel = scopedBuilding ? scopedBuilding.name : org.name;
  const buildingHref = scopedBuilding ? `/buildings/${scopedBuilding.id}` : null;

  // ── 2. Boekjaar per gebouw ───────────────────────────────────────────────
  let fyQuery = supabase
    .from("fiscal_years")
    .select("id, building_id, year, start_date, end_date, status")
    .eq("organization_id", org.id);
  if (scopedBuilding) fyQuery = fyQuery.eq("building_id", scopedBuilding.id);
  const fyRes = await fyQuery;
  if (fyRes.error) gefaald.add("fiscalYears");
  const fiscalYears = (fyRes.data ?? []) as FiscalYearRow[];

  if (gefaald.size > 0) {
    return (
      <>
        <Kop t={t} scope={scopeLabel} selection={null} />
        <Fout t={t} />
      </>
    );
  }

  const vandaag = new Date().toISOString().slice(0, 10);
  const selection = selectFiscalYears(
    scopeBuildings.map((b) => b.id),
    fiscalYears,
    vandaag,
  );
  const scopedFyIds = selection.selected.map((s) => s.fiscalYear.id);
  const scopedBuildingIds = selection.selected.map((s) => s.buildingId);

  if (scopedFyIds.length === 0) {
    return (
      <>
        <Kop t={t} scope={scopeLabel} selection={selection} />
        {onbekendGebouwGevraagd ? <OnbekendGebouw t={t} /> : null}
        <GeenBoekjaar t={t} building={scopedBuilding} mayWrite={mayWrite} />
      </>
    );
  }

  // Begrensd venster voor de betalingsquery. Het echte filter — per gebouw het
  // eigen boekjaar — gebeurt daarna in `filterToSelectedFiscalYear`.
  const vensterVan = selection.selected.reduce(
    (min, s) => (s.fiscalYear.start_date < min ? s.fiscalYear.start_date : min),
    selection.selected[0].fiscalYear.start_date,
  );
  const vensterTot = selection.selected.reduce(
    (max, s) => (s.fiscalYear.end_date > max ? s.fiscalYear.end_date : max),
    selection.selected[0].fiscalYear.end_date,
  );

  // ── 3. Lastenoproepen van de geselecteerde boekjaren ─────────────────────
  const callRes = await supabase
    .from("charge_calls")
    .select("id")
    .eq("organization_id", org.id)
    .in("fiscal_year_id", scopedFyIds);
  const callIds = (callRes.data ?? []).map((c) => c.id as string);

  // ── 4. Vorderingen ───────────────────────────────────────────────────────
  // Een mislukte oproepenquery telt hier mee: zonder oproep-id's zou de
  // vorderingenlijst leeg zijn en appelé ten onrechte nul worden.
  let settlements: SettlementRow[] | null = callRes.error ? null : [];
  if (settlements !== null && callIds.length > 0) {
    const settleRes = await supabase
      .from("v_settlement_integrity")
      .select("charge_allocation_id, building_id, owner_id, amount, settled_amount, ok")
      .eq("organization_id", org.id)
      .in("charge_call_id", callIds);
    settlements = settleRes.error ? null : ((settleRes.data ?? []) as SettlementRow[]);
  }

  // ── 5. Betalingen ────────────────────────────────────────────────────────
  const payRes = await supabase
    .from("payments")
    .select("id, amount, building_id, owner_id, value_date")
    .eq("organization_id", org.id)
    .in("building_id", scopedBuildingIds)
    .gte("value_date", vensterVan)
    .lte("value_date", vensterTot)
    .order("value_date", { ascending: false });
  const paymentsRuw = (payRes.data ?? []) as {
    id: string;
    amount: number;
    building_id: string | null;
    owner_id: string | null;
    value_date: string;
  }[];
  // Het venster in de query is een begrensde SUPERSET; dit filter houdt per
  // betaling alleen over wat binnen het boekjaar van zijn EIGEN gebouw valt.
  const payments = payRes.error
    ? null
    : filterToSelectedFiscalYear(paymentsRuw, selection);

  // ── 6. Uitgaven ──────────────────────────────────────────────────────────
  const expRes = await supabase
    .from("expenses")
    .select("id, amount, building_id, supplier, description, expense_date")
    .eq("organization_id", org.id)
    .in("fiscal_year_id", scopedFyIds)
    .order("expense_date", { ascending: false });
  const expenses = expRes.error
    ? null
    : ((expRes.data ?? []) as {
        id: string;
        amount: number;
        building_id: string | null;
        supplier: string | null;
        description: string | null;
        expense_date: string;
      }[]);

  // ── 7. Storno's — ORGANISATIEBREED, zie de kop van dit bestand ───────────
  const revRes = await supabase
    .from("v_financial_reversals")
    .select(
      "reversal_id, source_type, source_id, correction_source_id, reason, effective_date, is_correctie, is_correctie_vorig_boekjaar",
    )
    .eq("organization_id", org.id);
  const reversals = revRes.error
    ? null
    : buildReversalIndex((revRes.data ?? []) as ReversalViewRow[]);

  // Alle financieel dragende bronnen zijn nu bekend. `assembleFinancials`
  // beslist — en die beslissing is apart getest.
  const financials = assembleFinancials({
    selection,
    settlements,
    payments,
    expenses,
    reversals,
  });

  if (financials.status === "error") {
    return (
      <>
        <Kop t={t} scope={scopeLabel} selection={selection} />
        {onbekendGebouwGevraagd ? <OnbekendGebouw t={t} /> : null}
        <Fout t={t} />
      </>
    );
  }

  // Vanaf hier komen de rijen UIT het resultaat, niet uit de losse variabelen:
  // dat maakt de fail-closed controle de enige poort waar ze doorheen kunnen.
  const { kpis, settlementNok } = financials;
  const veiligeSettlements = financials.settlements;
  const veiligeBetalingen = financials.payments;
  const veiligeUitgaven = financials.expenses;
  const veiligeReversals = financials.reversals;

  // ── 8. Integriteit — mag falen, maar nooit als "gezond" lezen ────────────
  const allocRes = await supabase
    .from("v_allocation_integrity")
    .select("charge_call_id", { count: "exact", head: true })
    .eq("organization_id", org.id)
    .in("fiscal_year_id", scopedFyIds)
    .eq("ok", false);
  const allocationNok = allocRes.error ? null : (allocRes.count ?? 0);

  const reconRes = await supabase
    .from("v_reconciliation_4111")
    .select("verschil")
    .eq("organization_id", org.id)
    .in("fiscal_year_id", scopedFyIds);
  const reconVerschil = reconRes.error
    ? null
    : (reconRes.data ?? []).reduce((sum, r) => sum + Math.abs(Number(r.verschil ?? 0)), 0);

  // ── 9. Rekenen ───────────────────────────────────────────────────────────
  const debiteuren = topDebtors(veiligeSettlements, new Map(), 5);
  const ownerRes = debiteuren.debtors.length
    ? await supabase
        .from("owners")
        .select("id, full_name")
        .eq("organization_id", org.id)
        .in("id", debiteuren.debtors.map((d) => d.ownerId))
    : { data: [], error: null };
  // Bewuste uitzondering: een fout hier raakt alleen de NAMEN, niet de bedragen.
  const ownerNames = new Map(
    (ownerRes.error ? [] : (ownerRes.data ?? [])).map((o) => [
      o.id as string,
      o.full_name as string,
    ]),
  );
  const debtors = debiteuren.debtors.map((d) => ({
    ...d,
    name: ownerNames.get(d.ownerId) ?? t("debtors.unknownOwner"),
  }));

  const attention = buildAttentionItems({
    restant: kpis.restant,
    aantalDebiteuren: debiteuren.totaalDebiteuren,
    zonderEigenaar: debiteuren.zonderEigenaar,
    settlementNok,
    allocationNok,
    reconciliatieVerschil: reconVerschil,
    buildingsWithMultipleOpen: selection.buildingsWithMultipleOpen.length,
    buildingsWithoutFiscalYear: selection.buildingsWithoutFiscalYear.length,
    buildingHref,
  });

  const naamVanGebouw = new Map(buildings.map((b) => [b.id, b.name]));
  const activiteit = recentActivity(
    veiligeBetalingen.map((p) => ({
      id: p.id,
      amount: p.amount,
      building_id: p.building_id,
      date: p.value_date,
      context: naamVanGebouw.get(p.building_id ?? "") ?? "",
    })),
    veiligeUitgaven.map((e) => ({
      id: e.id,
      amount: e.amount,
      building_id: e.building_id,
      date: e.expense_date,
      context: e.supplier ?? e.description ?? "",
    })),
    veiligeReversals,
    8,
  );

  const geenActiviteit =
    kpis.appele === 0 && veiligeBetalingen.length === 0 && veiligeUitgaven.length === 0;

  return (
    <>
      <Kop t={t} scope={scopeLabel} selection={selection} />
      {onbekendGebouwGevraagd ? <OnbekendGebouw t={t} /> : null}

      {geenActiviteit ? (
        <GeenActiviteit t={t} building={scopedBuilding} mayWrite={mayWrite} />
      ) : (
        <section aria-labelledby="kpi-kop" className="mb-6">
          <h2 id="kpi-kop" className="sr-only">
            {t("kpi.sectionTitle")}
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard id="kpi-appele" label={t("kpi.called")} value={moneyKort(kpis.appele)} hint={t("kpi.calledHint")} />
            <KpiCard id="kpi-encaisse" label={t("kpi.collected")} value={moneyKort(kpis.encaisse)} hint={t("kpi.collectedHint")} />
            <KpiCard
              id="kpi-restant"
              label={t("kpi.outstanding")}
              value={moneyKort(kpis.restant)}
              hint={t("kpi.outstandingHint")}
              tone={kpis.restant > 0 ? "warn" : "neutral"}
            />
            <KpiCard
              id="kpi-depenses"
              label={t("kpi.expenses")}
              value={moneyKort(kpis.depenses)}
              hint={t("kpi.expensesHint")}
              href={buildingHref ? `${buildingHref}/expenses` : null}
            />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              id="kpi-taux"
              label={t("kpi.recovery")}
              value={formatPercent(kpis.taux, locale)}
              hint={kpis.taux === null ? t("kpi.recoveryNone") : t("kpi.recoveryHint")}
            />
          </div>
        </section>
      )}

      {attention.length > 0 ? (
        <section aria-labelledby="attention-kop" className="mb-6">
          <Card>
            <CardHeader title={<span id="attention-kop">{t("attention.title")}</span>} />
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {attention.map((item) => (
                <li key={item.key} className="flex flex-wrap items-center gap-2 text-[0.875rem]">
                  <Badge tone={item.tone}>{t(`attention.tone.${item.tone}`)}</Badge>
                  <span className="min-w-0 text-ink-soft">
                    {t(`attention.${item.labelKey}`, item.values ?? {})}
                  </span>
                  {item.href ? (
                    <Link href={item.href} className="text-[0.82rem] text-primary hover:underline">
                      {t("attention.open")}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <section aria-labelledby="debtors-kop">
          <Card padded={false}>
            <div className="p-4 pb-0">
              <CardHeader title={<span id="debtors-kop">{t("debtors.title")}</span>} />
            </div>
            {debtors.length === 0 ? (
              <p className="m-0 p-4 pt-0 text-[0.875rem] text-ink-soft">{t("debtors.empty")}</p>
            ) : (
              <Table caption={t("debtors.title")} className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>{t("debtors.owner")}</Th>
                    <Th align="end">{t("debtors.called")}</Th>
                    <Th align="end">{t("debtors.outstanding")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {debtors.map((d) => (
                    <tr key={d.ownerId}>
                      <Td>
                        <span className="block">{d.name}</span>
                        <span className="text-[0.72rem] text-ink-soft">
                          {t("debtors.openItems", { count: d.openPosten })}
                        </span>
                      </Td>
                      <Td align="end">{money(d.appele)}</Td>
                      <Td align="end" className="font-semibold text-warn">
                        {money(d.restant)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </section>

        <section aria-labelledby="activity-kop">
          <Card>
            <CardHeader title={<span id="activity-kop">{t("activity.title")}</span>} />
            {activiteit.length === 0 ? (
              <p className="m-0 text-[0.875rem] text-ink-soft">{t("activity.empty")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                {activiteit.map((a) => (
                  <li
                    key={`${a.kind}-${a.id}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line pb-2 last:border-b-0 last:pb-0"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge tone={a.kind === "payment" ? "good" : "neutral"}>
                        {t(`activity.kind.${a.kind}`)}
                      </Badge>
                      <span className="min-w-0 truncate text-[0.85rem] text-ink">
                        {a.context || t("activity.noContext")}
                      </span>
                      {a.reversed ? <Badge tone="crit">{t("activity.reversed")}</Badge> : null}
                      {a.isCorrection ? <Badge tone="info">{t("activity.correction")}</Badge> : null}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-3">
                      <span className="text-[0.75rem] text-ink-soft">{formatDate(a.date, locale)}</span>
                      <span
                        className={
                          a.reversed
                            ? "amount-reversed text-[0.875rem]"
                            : "text-[0.875rem] font-semibold [font-variant-numeric:tabular-nums]"
                        }
                      >
                        {money(a.amount)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>

      <SnelleActies
        t={t}
        building={scopedBuilding}
        fyId={scopedBuilding ? (selection.selected[0]?.fiscalYear.id ?? null) : null}
        mayWrite={mayWrite}
      />
    </>
  );
}

// ── Deelcomponenten ─────────────────────────────────────────────────────────

type T = Awaited<ReturnType<typeof getTranslations<"dashboard">>>;

/**
 * Kop met scope en boekjaarlabel.
 *
 * Dekt de selectie meerdere jaartallen — mogelijk wanneer gebouwen verschillende
 * boekjaren voeren — dan verschijnt er BEWUST geen "Exercice 2026", want dat zou
 * suggereren dat alles precies één boekjaar beslaat. Er komt dan een label dat
 * het bereik benoemt, plus het aantal meegetelde gebouwen.
 */
function Kop({
  t,
  scope,
  selection,
}: {
  t: T;
  scope: string;
  selection: ScopeSelection | null;
}) {
  const jaren = selection?.years ?? [];
  const enkelBoekjaar =
    selection && jaren.length === 1 && selection.selected.length === 1
      ? selection.selected[0].fiscalYear
      : null;

  return (
    <header className="mb-5">
      <h1 className="mt-0 mb-1 text-2xl font-semibold text-ink">{t("title")}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="m-0 text-[0.9rem] text-ink-soft">{scope}</p>
        {jaren.length > 0 ? (
          <>
            <span aria-hidden="true" className="text-ink-faint">
              ·
            </span>
            <p className="m-0 text-[0.9rem] text-ink-soft">
              {jaren.length === 1
                ? t("fiscalYear", { year: jaren[0] })
                : t("fiscalYearRange", { from: jaren[0], to: jaren[jaren.length - 1] })}
            </p>
            {enkelBoekjaar ? (
              <Badge tone={enkelBoekjaar.status === "open" ? "good" : "neutral"}>
                {t(`status.${enkelBoekjaar.status}`)}
              </Badge>
            ) : null}
            {selection && selection.selected.length > 1 ? (
              <span className="text-[0.78rem] text-ink-faint">
                {t("buildingsCounted", { count: selection.selected.length })}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </header>
  );
}

/** Fail-closed melding: liever geen cijfer dan een verkeerd cijfer. */
function Fout({ t }: { t: T }) {
  return (
    <Card className="border-crit">
      <p role="alert" className="m-0 text-[0.9rem] font-medium text-crit">
        {t("loadError.title")}
      </p>
      <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("loadError.body")}</p>
    </Card>
  );
}

function OnbekendGebouw({ t }: { t: T }) {
  return (
    <Card className="mb-4 border-warn">
      <p role="status" className="m-0 text-[0.875rem] text-ink-soft">
        {t("unknownBuilding")}
      </p>
    </Card>
  );
}

function LegeOrganisatie({ t }: { t: T }) {
  return (
    <>
      <h1 className="mt-0 mb-1 text-2xl font-semibold text-ink">{t("title")}</h1>
      <Card className="mt-4 text-center">
        <h2 className="mt-0 mb-1.5 text-base font-semibold text-ink">{t("empty.title")}</h2>
        <p className="mx-auto mb-4 max-w-prose text-[0.9rem] text-ink-soft">{t("empty.body")}</p>
        <Link href="/buildings" className={buttonClasses("primary", "md")}>
          {t("empty.cta")}
        </Link>
      </Card>
    </>
  );
}

function GeenBoekjaar({
  t,
  building,
  mayWrite,
}: {
  t: T;
  building: { id: string; name: string } | null;
  mayWrite: boolean;
}) {
  return (
    <Card className="text-center">
      <h2 className="mt-0 mb-1.5 text-base font-semibold text-ink">{t("noFiscalYear.title")}</h2>
      <p className="mx-auto mb-4 max-w-prose text-[0.9rem] text-ink-soft">{t("noFiscalYear.body")}</p>
      {building && mayWrite ? (
        <Link href={`/buildings/${building.id}/boekjaren`} className={buttonClasses("primary", "md")}>
          {t("noFiscalYear.cta")}
        </Link>
      ) : null}
    </Card>
  );
}

function GeenActiviteit({
  t,
  building,
  mayWrite,
}: {
  t: T;
  building: { id: string; name: string } | null;
  mayWrite: boolean;
}) {
  return (
    <Card className="mb-6 text-center">
      <h2 className="mt-0 mb-1.5 text-base font-semibold text-ink">{t("noActivity.title")}</h2>
      <p className="mx-auto mb-4 max-w-prose text-[0.9rem] text-ink-soft">{t("noActivity.body")}</p>
      {building && mayWrite ? (
        <Link href={`/buildings/${building.id}/boekjaren`} className={buttonClasses("primary", "md")}>
          {t("noActivity.cta")}
        </Link>
      ) : null}
    </Card>
  );
}

const ACTIE_ICONEN: Record<string, typeof Wallet> = {
  payment: Wallet,
  expense: Receipt,
  "fiscal-years": CalendarRange,
  building: Building2,
  buildings: Building2,
};

function SnelleActies({
  t,
  building,
  fyId,
  mayWrite,
}: {
  t: T;
  building: { id: string; name: string } | null;
  fyId: string | null;
  mayWrite: boolean;
}) {
  const acties = quickActions({
    buildingId: building?.id ?? null,
    fiscalYearId: fyId,
    mayWrite,
  });
  if (acties.length === 0) return null;

  return (
    <section aria-labelledby="actions-kop" className="mt-6">
      <h2 id="actions-kop" className="mb-2 text-base font-semibold text-ink">
        {t("actions.title")}
      </h2>
      <div className="flex flex-wrap gap-2">
        {acties.map((actie) => {
          const Icon = ACTIE_ICONEN[actie.key] ?? Building2;
          return (
            <Link key={actie.key} href={actie.href} className={buttonClasses("secondary", "sm")}>
              <Icon className="size-4" aria-hidden="true" />
              {t(`actions.${actie.labelKey}`)}
              <ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden="true" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

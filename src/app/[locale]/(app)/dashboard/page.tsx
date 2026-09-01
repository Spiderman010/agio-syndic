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
import { buildReversalIndex, emptyReversalIndex, type ReversalViewRow } from "@/lib/reversal";
import { formatDate, formatMoney, formatMoneyRounded, formatPercent } from "@/lib/money";
import {
  buildAttentionItems,
  computeKpis,
  pickFiscalYear,
  quickActions,
  recentActivity,
  topDebtors,
  type FiscalYearRow,
  type SettlementRow,
} from "@/lib/dashboard";

/**
 * Financieel dashboard.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 * Zonder `?building=` is het beeld organisatiebreed; met de parameter is het
 * één gebouw. Dat vraagt geen nieuwe route en geen wijziging aan de schil.
 *
 * Alle queries filteren EXPLICIET op `organization_id` van de actieve
 * organisatie, bovenop RLS. RLS scoopt op lidmaatschap en laat dus alle
 * organisaties van de gebruiker door; `requireOrg()` kiest er één. Zonder dat
 * expliciete filter zou een gebruiker met twee organisaties de cijfers van
 * beide opgeteld zien onder de naam van één — de contextmismatch uit sprint 1.
 *
 * ── BOEKJAAR ───────────────────────────────────────────────────────────────
 * Alles op dit scherm gaat over ÉÉN boekjaar; het jaartal staat in de kop. Dat
 * is een bewuste beperking: openstaande posten uit eerdere jaren tellen hier
 * niet mee. Een meerjarige ouderdomsanalyse is eigen functionaliteit.
 *
 * ── AANTAL QUERIES ─────────────────────────────────────────────────────────
 * Vast, ongeacht het aantal gebouwen of eigenaren: er is geen enkele query in
 * een lus. Eigenaarsnamen worden pas opgehaald nadat de top is bepaald, met één
 * `in`-query over hoogstens vijf id's.
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
  // Kaartkoppen zonder centen: op 360px staan er twee naast elkaar en past een
  // volledig opgemaakt bedrag niet. De exacte bedragen staan in de
  // debiteurenlijst en op de detailschermen, waar de ruimte er wel is.
  const money = (n: number) => formatMoney(n, locale);
  const moneyKort = (n: number) => formatMoneyRounded(n, locale);

  // ── 1. Gebouwen van deze organisatie ─────────────────────────────────────
  const { data: buildingData } = await supabase
    .from("buildings")
    .select("id, name")
    .eq("organization_id", org.id)
    .order("name", { ascending: true });
  const buildings = (buildingData ?? []) as { id: string; name: string }[];

  // Een onbekend of niet-toegankelijk id valt terug op organisatiebreed in
  // plaats van een leeg scherm te tonen.
  const scopedBuilding =
    buildings.find((b) => b.id === buildingParam) ?? null;
  const scopeLabel = scopedBuilding ? scopedBuilding.name : org.name;

  if (buildings.length === 0) {
    return <LegeOrganisatie t={t} />;
  }

  // ── 2. Boekjaarcontext ───────────────────────────────────────────────────
  let fyQuery = supabase
    .from("fiscal_years")
    .select("id, building_id, year, start_date, end_date, status")
    .eq("organization_id", org.id);
  if (scopedBuilding) fyQuery = fyQuery.eq("building_id", scopedBuilding.id);
  const { data: fyData } = await fyQuery;
  const fiscalYears = (fyData ?? []) as FiscalYearRow[];

  const vandaag = new Date().toISOString().slice(0, 10);
  const fyContext = pickFiscalYear(fiscalYears, vandaag);
  const huidigJaar = fyContext.huidig?.year ?? null;

  // Organisatiebreed telt "boekjaar 2026" van elk gebouw mee.
  const scopedFy = fiscalYears.filter((f) => f.year === huidigJaar);
  const scopedFyIds = scopedFy.map((f) => f.id);
  const periodeStart = scopedFy.reduce<string | null>(
    (min, f) => (min === null || f.start_date < min ? f.start_date : min),
    null,
  );
  const periodeEind = scopedFy.reduce<string | null>(
    (max, f) => (max === null || f.end_date > max ? f.end_date : max),
    null,
  );

  if (scopedFyIds.length === 0) {
    return (
      <>
        <Kop t={t} scope={scopeLabel} fy={null} context={fyContext} />
        <GeenBoekjaar t={t} building={scopedBuilding} mayWrite={mayWrite} />
      </>
    );
  }

  // ── 3. Lastenoproepen van dit boekjaar ───────────────────────────────────
  const { data: callData } = await supabase
    .from("charge_calls")
    .select("id")
    .eq("organization_id", org.id)
    .in("fiscal_year_id", scopedFyIds);
  const callIds = (callData ?? []).map((c) => c.id as string);

  // ── 4. Vorderingen: appelé, restant dû, debiteuren én integriteit in één ─
  const settlements: SettlementRow[] = callIds.length
    ? (((
        await supabase
          .from("v_settlement_integrity")
          .select("charge_allocation_id, building_id, owner_id, amount, settled_amount, ok")
          .eq("organization_id", org.id)
          .in("charge_call_id", callIds)
      ).data ?? []) as SettlementRow[])
    : [];

  // ── 5. Betalingen binnen de periode van het boekjaar ─────────────────────
  // `payments` draagt geen fiscal_year_id; de valutadatum is de enige
  // koppeling aan een periode die het datamodel biedt.
  let payQuery = supabase
    .from("payments")
    .select("id, amount, building_id, owner_id, value_date")
    .eq("organization_id", org.id);
  if (scopedBuilding) payQuery = payQuery.eq("building_id", scopedBuilding.id);
  if (periodeStart) payQuery = payQuery.gte("value_date", periodeStart);
  if (periodeEind) payQuery = payQuery.lte("value_date", periodeEind);
  const { data: payData } = await payQuery.order("value_date", { ascending: false });
  const payments = (payData ?? []) as {
    id: string;
    amount: number;
    building_id: string | null;
    owner_id: string | null;
    value_date: string;
  }[];

  // ── 6. Uitgaven van dit boekjaar ─────────────────────────────────────────
  const { data: expData } = await supabase
    .from("expenses")
    .select("id, amount, building_id, supplier, description, expense_date")
    .eq("organization_id", org.id)
    .in("fiscal_year_id", scopedFyIds)
    .order("expense_date", { ascending: false });
  const expenses = (expData ?? []) as {
    id: string;
    amount: number;
    building_id: string | null;
    supplier: string | null;
    description: string | null;
    expense_date: string;
  }[];

  // ── 7. Storno's en correcties ────────────────────────────────────────────
  const { data: revData, error: revError } = await supabase
    .from("v_financial_reversals")
    .select(
      "reversal_id, source_type, source_id, correction_source_id, reason, effective_date, is_correctie, is_correctie_vorig_boekjaar",
    )
    .eq("organization_id", org.id);
  // Faalt deze query, dan zou netto stilzwijgend bruto worden — en dat is een
  // te groot verschil om weg te moffelen. De totalen worden dan onderdrukt.
  const reversalsBeschikbaar = !revError;
  const reversals = reversalsBeschikbaar
    ? buildReversalIndex((revData ?? []) as ReversalViewRow[])
    : emptyReversalIndex();

  // ── 8. Integriteitssignalen ──────────────────────────────────────────────
  const { count: allocNok } = await supabase
    .from("v_allocation_integrity")
    .select("charge_call_id", { count: "exact", head: true })
    .eq("organization_id", org.id)
    .in("fiscal_year_id", scopedFyIds)
    .eq("ok", false);

  const { data: reconData } = await supabase
    .from("v_reconciliation_4111")
    .select("verschil")
    .eq("organization_id", org.id)
    .in("fiscal_year_id", scopedFyIds);
  const reconVerschil = (reconData ?? []).reduce(
    (sum, r) => sum + Math.abs(Number(r.verschil ?? 0)),
    0,
  );

  // ── 9. Rekenen ───────────────────────────────────────────────────────────
  const kpis = computeKpis({ settlements, payments, expenses, reversals });
  const settlementNok = settlements.filter((s) => !s.ok).length;

  const debiteuren = topDebtors(settlements, new Map(), 5);
  const { data: ownerData } = debiteuren.debtors.length
    ? await supabase
        .from("owners")
        .select("id, full_name")
        .eq("organization_id", org.id)
        .in("id", debiteuren.debtors.map((d) => d.ownerId))
    : { data: [] };
  const ownerNames = new Map(
    (ownerData ?? []).map((o) => [o.id as string, o.full_name as string]),
  );
  const debtors = debiteuren.debtors.map((d) => ({
    ...d,
    name: ownerNames.get(d.ownerId) ?? t("debtors.unknownOwner"),
  }));

  const buildingHref = scopedBuilding ? `/buildings/${scopedBuilding.id}` : null;
  const attention = buildAttentionItems({
    restant: kpis.restant,
    aantalDebiteuren: debiteuren.totaalDebiteuren,
    zonderEigenaar: debiteuren.zonderEigenaar,
    settlementNok,
    allocationNok: allocNok ?? 0,
    reconciliatieVerschil: reconVerschil,
    meerdereOpenBoekjaren: fyContext.aantalOpen,
    buildingHref,
  });

  const naamVanGebouw = new Map(buildings.map((b) => [b.id, b.name]));
  const activiteit = recentActivity(
    payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      building_id: p.building_id,
      date: p.value_date,
      context: naamVanGebouw.get(p.building_id ?? "") ?? "",
    })),
    expenses.map((e) => ({
      id: e.id,
      amount: e.amount,
      building_id: e.building_id,
      date: e.expense_date,
      context: e.supplier ?? e.description ?? "",
    })),
    reversals,
    8,
  );

  const geenActiviteit = kpis.appele === 0 && payments.length === 0 && expenses.length === 0;

  return (
    <>
      <Kop t={t} scope={scopeLabel} fy={fyContext.huidig} context={fyContext} />

      {!reversalsBeschikbaar ? (
        <Card className="mb-4 border-crit">
          <p className="m-0 text-[0.88rem] text-crit" role="alert">
            {t("netUnavailable")}
          </p>
        </Card>
      ) : null}

      {geenActiviteit ? (
        <GeenActiviteit t={t} building={scopedBuilding} mayWrite={mayWrite} />
      ) : (
        <section aria-labelledby="kpi-kop" className="mb-6">
          <h2 id="kpi-kop" className="sr-only">
            {t("kpi.sectionTitle")}
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              id="kpi-appele"
              label={t("kpi.called")}
              value={moneyKort(kpis.appele)}
              hint={t("kpi.calledHint")}
            />
            <KpiCard
              id="kpi-encaisse"
              label={t("kpi.collected")}
              value={moneyKort(kpis.encaisse)}
              hint={t("kpi.collectedHint")}
            />
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
                <li
                  key={item.key}
                  className="flex flex-wrap items-center gap-2 text-[0.875rem]"
                >
                  <Badge tone={item.tone}>{t(`attention.tone.${item.tone}`)}</Badge>
                  <span className="min-w-0 text-ink-soft">
                    {t(`attention.${item.labelKey}`, item.values ?? {})}
                  </span>
                  {item.href ? (
                    <Link
                      href={item.href}
                      className="text-[0.82rem] text-primary hover:underline"
                    >
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
              <p className="m-0 p-4 pt-0 text-[0.875rem] text-ink-soft">
                {t("debtors.empty")}
              </p>
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
                      {a.reversed ? (
                        <Badge tone="crit">{t("activity.reversed")}</Badge>
                      ) : null}
                      {a.isCorrection ? (
                        <Badge tone="info">{t("activity.correction")}</Badge>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-3">
                      <span className="text-[0.75rem] text-ink-soft">
                        {formatDate(a.date, locale)}
                      </span>
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
        fyId={scopedBuilding ? (fyContext.huidig?.id ?? null) : null}
        mayWrite={mayWrite}
      />
    </>
  );
}

// ── Deelcomponenten ─────────────────────────────────────────────────────────

type T = Awaited<ReturnType<typeof getTranslations<"dashboard">>>;

function Kop({
  t,
  scope,
  fy,
  context,
}: {
  t: T;
  scope: string;
  fy: FiscalYearRow | null;
  context: { meerdereOpen: boolean; aantalOpen: number };
}) {
  return (
    <header className="mb-5">
      <h1 className="mt-0 mb-1 text-2xl font-semibold text-ink">{t("title")}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="m-0 text-[0.9rem] text-ink-soft">{scope}</p>
        {fy ? (
          <>
            <span aria-hidden="true" className="text-ink-faint">
              ·
            </span>
            <p className="m-0 text-[0.9rem] text-ink-soft">
              {t("fiscalYear", { year: fy.year })}
            </p>
            <Badge tone={fy.status === "open" ? "good" : "neutral"}>
              {t(`status.${fy.status}`)}
            </Badge>
          </>
        ) : null}
        {context.meerdereOpen ? (
          <Badge tone="warn">
            {t("multipleOpenBadge", { count: context.aantalOpen })}
          </Badge>
        ) : null}
      </div>
    </header>
  );
}

function LegeOrganisatie({ t }: { t: T }) {
  return (
    <>
      <h1 className="mt-0 mb-1 text-2xl font-semibold text-ink">{t("title")}</h1>
      <Card className="mt-4 text-center">
        <h2 className="mt-0 mb-1.5 text-base font-semibold text-ink">
          {t("empty.title")}
        </h2>
        <p className="mx-auto mb-4 max-w-prose text-[0.9rem] text-ink-soft">
          {t("empty.body")}
        </p>
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
      <h2 className="mt-0 mb-1.5 text-base font-semibold text-ink">
        {t("noFiscalYear.title")}
      </h2>
      <p className="mx-auto mb-4 max-w-prose text-[0.9rem] text-ink-soft">
        {t("noFiscalYear.body")}
      </p>
      {building && mayWrite ? (
        <Link
          href={`/buildings/${building.id}/boekjaren`}
          className={buttonClasses("primary", "md")}
        >
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
      <h2 className="mt-0 mb-1.5 text-base font-semibold text-ink">
        {t("noActivity.title")}
      </h2>
      <p className="mx-auto mb-4 max-w-prose text-[0.9rem] text-ink-soft">
        {t("noActivity.body")}
      </p>
      {building && mayWrite ? (
        <Link
          href={`/buildings/${building.id}/boekjaren`}
          className={buttonClasses("primary", "md")}
        >
          {t("noActivity.cta")}
        </Link>
      ) : null}
    </Card>
  );
}

/**
 * Snelkoppelingen.
 *
 * Alleen naar schermen die bestaan, en muterende acties alleen voor wie mag
 * schrijven — een `reader` krijgt de leeslinks, niet de invoerlinks. De
 * database weigert het sowieso; dit voorkomt dat we een knop aanbieden waarvan
 * we weten dat hij faalt.
 */
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
            <Link
              key={actie.key}
              href={actie.href}
              className={buttonClasses("secondary", "sm")}
            >
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

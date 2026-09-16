import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";
import { createPayment } from "../actions";
import ActionForm from "@/components/ActionForm";
import PaymentReversalActions from "@/components/PaymentReversalActions";
import ChargeCallWorkflow from "./ChargeCallWorkflow";
import { canReverse, canWrite } from "@/lib/roles";
import { correctionOf, fetchReversalIndexResult, reversalOf } from "@/lib/reversal";
import { formatMoney } from "@/lib/money";
import { BUILDING_TIMEZONE, todayInTimezone } from "@/lib/today";
import type { AllocationRuleRow, RuleUnitRow, RuleWeightRow } from "@/lib/charges";
import type { OwnershipRow } from "@/lib/ownership";
import type { Building, FiscalYear } from "@/lib/types";

/*
 * De methode- en reikwijdtelabels stonden hier als hardgecodeerde Franse
 * constanten. Ze zijn vervangen door `charges.methods.*` en `charges.scopes.*`,
 * die in FR, NL en AR bestaan: een Marokkaanse syndic die de app in het
 * Arabisch gebruikt, hoort geen Franse termen in een keuzelijst te lezen.
 */

type AllocRow = {
  id: string;
  amount: number;
  /**
   * De definitieve uitkomst van de centverdeling, zoals `fn_alloc_distribute`
   * hem heeft vastgelegd. NOT NULL in m13, en de database bewaakt zelf dat
   * `amount = amount_cents / 100` (`ca_money_ck`).
   */
  amount_cents: number | string;
  settled_amount: number;
  owner_id: string | null;
  units: { label: string } | null;
  owners: { full_name: string } | null;
};

type CallRow = {
  id: string;
  type: string;
  period: string | null;
  label: string | null;
  total_amount: number;
  call_date: string;
  due_date: string | null;
  /** Snapshotkop: wat de engine bij het aanmaken werkelijk heeft toegepast. */
  alloc_method: string;
  alloc_scope: string;
  alloc_rule_label: string;
  alloc_unit_count: number;
  alloc_partial_denominator: boolean;
  charge_allocations: AllocRow[];
};

type PayRow = {
  id: string;
  amount: number;
  method: string;
  value_date: string;
  reference: string | null;
  owners: { full_name: string } | null;
  payment_allocations: {
    amount: number;
    charge_allocations: {
      amount: number;
      settled_amount: number;
      charge_calls: { period: string | null; label: string | null; due_date: string | null } | null;
      units: { label: string } | null;
    } | null;
  }[];
};

function fmt(n: number) {
  return n.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function allocBadge(settled: number, amount: number, dueDate: string | null) {
  if (settled >= amount - 0.005) return <span className="badge badge-betaald">payé</span>;
  if (dueDate && new Date(dueDate) < new Date()) return <span className="badge badge-telaat">en retard</span>;
  if (settled > 0) return <span className="badge badge-deels">partiel</span>;
  return <span className="badge badge-openstaand">en attente</span>;
}

export default async function FiscalYearDetail({
  params,
}: {
  params: Promise<{ locale: string; id: string; fy_id: string }>;
}) {
  const { locale, id: buildingId, fy_id: fyId } = await params;
  const { role } = await requireOrg();
  const supabase = await createClient();
  const tr = await getTranslations("reversal");
  const tc = await getTranslations("charges");
  const mayWrite = canWrite(role);
  // De voorgevulde oproepdatum, in de tijdzone van het gebouw. `toISOString()`
  // zou hier de UTC-dag geven en tussen 00:00 en 01:00 lokale tijd dus de dag
  // ERVOOR - precies de datum waarop de eigendom wordt beoordeeld.
  const vandaag = todayInTimezone(BUILDING_TIMEZONE);

  const [{ data: bData }, { data: fyData }] = await Promise.all([
    supabase.from("buildings").select("*").eq("id", buildingId).maybeSingle(),
    supabase.from("fiscal_years").select("*").eq("id", fyId).maybeSingle(),
  ]);
  if (!bData || !fyData) notFound();

  // Het boekjaar moet bij HET GEBOUW UIT DE URL horen. RLS scoopt op
  // lidmaatschap, niet op gebouw: binnen dezelfde organisatie levert
  // /buildings/A/boekjaren/<boekjaar van B> anders een pagina op die de naam
  // en de lots van gebouw A draagt boven de oproepen en betalingen van gebouw
  // B. Deze controle staat bewust vóór elke financiële query, zodat er bij een
  // mismatch niets wordt opgehaald en niets wordt gerenderd.
  if ((fyData as { building_id: string }).building_id !== buildingId) notFound();

  const b = bData as Building;
  const fy = fyData as FiscalYear;

  /*
   * ELKE EMBED DRAAGT ZIJN FOREIGN KEY BIJ NAAM.
   *
   * Dit schema heeft tussen meerdere tabelparen MEER DAN EEN foreign key, en
   * PostgREST weigert dan te raden: het antwoordt met PGRST201 ("more than one
   * relationship was found") en de hele query faalt. Dat is geen randgeval maar
   * de regel hier, want m8 zette overal een samengestelde tenantsleutel NAAST
   * de bestaande enkelvoudige FK - m30 zegt dat met zoveel woorden over
   * `ownership`: "Het ON DELETE-gedrag blijft bij de bestaande enkelvoudige FK
   * op `owner_id`, precies zoals m8 sectie 7 het doet."
   *
   * Tussen `charge_allocations` en `charge_calls` staan er zelfs drie:
   * `ca_call_building_fk` en `ca_call_params_fk` (m13) en
   * `charge_allocations_cc_org_fk` (m8, opnieuw gezet in m18).
   *
   * De `!<constraint>`-hint maakt de keuze expliciet. Gekozen wordt steeds de
   * tenantbewakende sleutel: dezelfde ouderrij, maar met de organisatie- of
   * gebouwkolom erin, zodat de join niet buiten de scope kan wijzen.
   */
  const { data: callsData, error: callsError } = await supabase
    .from("charge_calls")
    .select(`
      id, type, period, label, total_amount, call_date, due_date,
      alloc_method, alloc_scope, alloc_rule_label, alloc_unit_count,
      alloc_partial_denominator,
      charge_allocations!ca_call_building_fk(
        id, amount, amount_cents, settled_amount, owner_id,
        units!ca_unit_building_fk(label),
        owners!ca_owner_org_fk(full_name)
      )
    `)
    .eq("fiscal_year_id", fyId)
    .order("call_date", { ascending: false });
  const calls = (callsData ?? []) as unknown as CallRow[];

  // ── Bronnen voor de controle vóór aanmaken ───────────────────────────────
  //
  // FAIL-CLOSED. Een mislukte query mag hier NOOIT als lege of gezonde data
  // doorgaan: nul lots zonder eigenaar ziet er precies zo uit als "de query
  // faalde", en op dat verschil hangt een financiële handeling. Faalt één van
  // deze bronnen, dan verschijnt het aanmaakformulier helemaal niet.
  //
  // `units` gaat vooruit, omdat `ownership` GEEN `building_id` draagt: de keten
  // loopt daar via `unit_id`. Dat is geen omissie maar het model — m30 gaf
  // `ownership` wel een `organization_id`, nooit een gebouwkolom.
  const unitsRes = await supabase
    .from("units")
    .select("id, building_id, label, tantiemes, block_id")
    .eq("building_id", buildingId)
    .order("label");

  const unitIds = (unitsRes.data ?? []).map((u) => u.id as string);

  const [rulesRes, ruleUnitsRes, ruleWeightsRes, ownershipRes] =
    await Promise.all([
      supabase
        .from("allocation_rules")
        .select(
          "id, building_id, code, label, method, scope, weight_source, scope_block_id, uncovered_unit_policy, status, is_default, partial_denominator_until_year",
        )
        .eq("building_id", buildingId)
        .eq("status", "active")
        .order("is_default", { ascending: false })
        .order("label"),
      supabase
        .from("allocation_rule_units")
        .select("rule_id, unit_id")
        .eq("building_id", buildingId),
      supabase
        .from("allocation_rule_weights")
        .select("rule_id, unit_id, weight")
        .eq("building_id", buildingId),
      supabase
        .from("ownership")
        .select(
          "id, unit_id, owner_id, share, start_date, end_date, is_primary_debtor, owners!ownership_owner_org_fk(id, full_name)",
        )
        .in("unit_id", unitIds),
    ]);

  /*
   * DRIE GESCHEIDEN POORTEN.
   *
   * Eerder hing alles aan één vlag, en die vlag stond bovendien binnen
   * `mayWrite && open`. Daardoor kon een viewer — of iedereen op een gesloten
   * boekjaar — bij een mislukte `charge_calls`-query "0 MAD appelés" en "geen
   * oproepen" te zien krijgen zonder enige foutmelding. Een lege lijst en een
   * mislukte query zien er identiek uit, en juist op dat verschil hangt hier
   * geld.
   *
   * De poorten zijn nu gescheiden naar wat ze werkelijk beschermen:
   *
   *   callsOk      de oproepen zelf: totaal, aantal, lijst, lege toestand EN
   *                de definitieve verdeling per oproep, want die komt uit
   *                `charge_allocations` en dus uit diezelfde query;
   *   saldoOk      het saldo per eigenaar;
   *   paymentsOk   de betalingenlijst;
   *   workflowOk   de bronnen waarop de controle vóór aanmaken steunt.
   *
   * Verderop komen daar de twee poorten van de reversal-engine bij:
   *
   *   reversalsOk     de stornostatus per betaling (`v_financial_reversals`);
   *   actionStatusOk  het boekjaar van de journaalpost achter die betaling.
   *
   * Een fout in een workflowbron verbergt dus geen betrouwbare oproepen meer,
   * en een fout in de oproepen blokkeert niet stilzwijgend alleen het
   * aanmaakformulier.
   */
  const callsOk = !callsError;
  const workflowOk =
    !unitsRes.error &&
    !rulesRes.error &&
    !ruleUnitsRes.error &&
    !ruleWeightsRes.error &&
    !ownershipRes.error;

  const lots = (unitsRes.data ?? []) as {
    id: string;
    building_id: string;
    label: string;
    tantiemes: number | string | null;
    block_id: string | null;
  }[];

  const rules = (rulesRes.data ?? []) as unknown as AllocationRuleRow[];
  const ruleUnits = (ruleUnitsRes.data ?? []) as RuleUnitRow[];
  const ruleWeights = (ruleWeightsRes.data ?? []) as RuleWeightRow[];

  const ownershipRows = (ownershipRes.data ?? []) as unknown as (OwnershipRow & {
    owners: { id: string; full_name: string } | { id: string; full_name: string }[] | null;
  })[];

  /**
   * De definitieve verdeling van EEN oproep, uit `charge_allocations`.
   *
   * Dit is de door `fn_alloc_distribute` vastgelegde uitkomst, inclusief de
   * restcenten; hier wordt niets herberekend. Bewust NIET uit
   * `charge_call_lines`: m20 vult die tabel alleen bij `method = 'manual'`
   * (regel 307, "handmatige brondocumentregels"), zodat een verdeling over
   * tantiemes, gelijke delen of percentages daar per definitie nul rijen
   * heeft. Die tabel als bron gebruiken meldde dus "geen vastgelegde regels"
   * voor precies de methoden die het meest worden gebruikt.
   *
   * `alloc_unit_count` is de snapshotkop van de engine: het aantal lots dat
   * bij het aanmaken werkelijk is bediend. Komt het aantal opgehaalde rijen
   * daar niet mee overeen, dan is de lijst aantoonbaar onvolledig en tonen we
   * hem niet als definitief resultaat.
   */
  function verdelingVan(cc: CallRow) {
    const regels = (cc.charge_allocations ?? [])
      .map((ca) => ({
        label: ca.units?.label ?? "—",
        amountCents: Number(ca.amount_cents),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { regels, volledig: regels.length === cc.alloc_unit_count };
  }


  // De eigenaarskeuze van het BETALINGSformulier. Die lijst toont bewust alleen
  // ACTUELE eigenaars (`end_date IS NULL`), net als voorheen: de bovenstaande
  // query haalt sinds deze sprint de volledige historie op voor de controle vóór
  // aanmaken, en zonder dit filter zouden oud-eigenaars in dat formulier komen.
  const eigenaarMap = new Map<string, string>();
  for (const row of ownershipRows) {
    if (row.end_date !== null) continue;
    const rawOwner = row.owners as { id: string; full_name: string }[] | { id: string; full_name: string } | null;
    const o = Array.isArray(rawOwner) ? (rawOwner[0] ?? null) : rawOwner;
    if (o) eigenaarMap.set(o.id, o.full_name);
  }
  const eigenaars = Array.from(eigenaarMap.entries()).map(([id, full_name]) => ({ id, full_name }));

  const { data: paysData, error: paysError } = await supabase
    .from("payments")
    .select(`
      id, amount, method, value_date, reference,
      owners!payments_owner_org_fk(full_name),
      payment_allocations!payment_allocations_payment_org_fk(
        amount,
        charge_allocations!payment_allocations_ca_org_fk(
          amount, settled_amount,
          charge_calls!ca_call_building_fk(period, label, due_date),
          units!ca_unit_building_fk(label)
        )
      )
    `)
    .eq("building_id", buildingId)
    .order("value_date", { ascending: false })
    .limit(20);
  // Zelfde regel als bij de oproepen: een mislukte betalingenquery mag niet als
  // "geen betalingen" verschijnen. Dat is geen cosmetisch verschil - wie op die
  // lege lijst afgaat, boekt een betaling een tweede keer.
  const paymentsOk = !paysError;
  const pays = (paysData ?? []) as unknown as PayRow[];

  // ---- Financial Reversal Engine -------------------------------------------
  // De storno's bij deze betalingen. De lijst is KLASSE A (bruto activiteit):
  // elke betaling blijft staan, gestorneerde exemplaren worden gemarkeerd. Het
  // saldo per eigenaar verderop is klasse B en corrigeert zichzelf al, omdat het
  // uit `amount - settled_amount` volgt en de storno settled_amount herstelt.
  const payIds = pays.map((p) => p.id);

  // FAIL-CLOSED op de stornostatus. Een mislukte leesquery mag hier nooit als
  // "niets gestorneerd" doorgaan: dan verschijnt een gestorneerde betaling als
  // actief, verliest een correctie haar relatie met het origineel, en komt er
  // een stornoknop bij een rij die de database zeker weigert. Nul betalingen is
  // GEEN fout: dan valt er niets op te halen en is de lege index juist.
  const { index: reversals, error: reversalError } = await fetchReversalIndexResult(
    supabase,
    "payment",
    payIds,
  );
  const reversalsOk = !reversalError;

  // In welk boekjaar staat de ORIGINELE journaalpost van elke betaling? Dat
  // bepaalt of storneren een owner/admin-ingreep is. fn_reversal_authorize
  // beslist definitief; dit voorkomt alleen een knop die zeker faalt.
  //
  // Ook hier telt de foutstatus: een stil lege `closedPayments` laat een
  // betaling uit een GESLOTEN boekjaar eruitzien alsof de gewone
  // reversalrechten gelden, en toont dus een actie die zeker wordt geweigerd.
  const closedPayments = new Set<string>();
  let journalError: unknown = null;
  if (payIds.length > 0) {
    const { data: entryData, error: entryError } = await supabase
      .from("journal_entries")
      .select("source_id, fiscal_years!journal_entries_fy_org_fk(status)")
      .eq("source", "payment")
      .in("source_id", payIds);
    journalError = entryError;

    for (const row of entryData ?? []) {
      const rawFy = row.fiscal_years as { status: string } | { status: string }[] | null;
      const entryFy = Array.isArray(rawFy) ? (rawFy[0] ?? null) : rawFy;
      if (entryFy?.status === "closed") closedPayments.add(row.source_id as string);
    }
  }
  /** Is de boekjaarstatus achter de storno-/correctieknoppen betrouwbaar? */
  const actionStatusOk = !journalError;

  /**
   * Een betalingsregel mag alleen zichtbaar zijn wanneer BEIDE dingen kloppen:
   * haar bedrag (payments) en haar stornostatus (v_financial_reversals). Een
   * rij zonder stornomarkering is een bewering dat er niet gestorneerd is, en
   * die bewering kunnen we bij een leesfout niet waarmaken.
   */
  const paymentRowsOk = paymentsOk && reversalsOk;

  const callIds = calls.map((c) => c.id);
  let saldoRows: {
    ownerId: string;
    naam: string;
    opgeroepen: number;
    voldaan: number;
    teLaat: number;
  }[] = [];

  // Ook deze query is financieel dragend: zonder foutafvangst zou een mislukte
  // allocatiequery als "geen enkele eigenaar heeft een saldo" verschijnen.
  let allocError: unknown = null;

  if (callIds.length > 0) {
    const { data: allocData, error: allocErr } = await supabase
      .from("charge_allocations")
      .select(
        "amount, settled_amount, owner_id, owners!ca_owner_org_fk(id, full_name), charge_calls!ca_call_building_fk(due_date)",
      )
      .in("charge_call_id", callIds)
      .not("owner_id", "is", null);
    allocError = allocErr;

    const saldoMap = new Map<string, { naam: string; opgeroepen: number; voldaan: number; teLaat: number }>();
    for (const row of allocData ?? []) {
      const rawOwner = row.owners as { id: string; full_name: string }[] | { id: string; full_name: string } | null;
      const owner = Array.isArray(rawOwner) ? (rawOwner[0] ?? null) : rawOwner;
      if (!owner) continue;
      const rawCc = row.charge_calls as { due_date: string | null }[] | { due_date: string | null } | null;
      const cc = Array.isArray(rawCc) ? (rawCc[0] ?? null) : rawCc;
      const open = Number(row.amount) - Number(row.settled_amount);
      const teLaat = cc?.due_date && new Date(cc.due_date) < new Date() && open > 0 ? open : 0;
      const existing = saldoMap.get(owner.id) ?? { naam: owner.full_name, opgeroepen: 0, voldaan: 0, teLaat: 0 };
      existing.opgeroepen += Number(row.amount);
      existing.voldaan += Number(row.settled_amount);
      existing.teLaat += teLaat;
      saldoMap.set(owner.id, existing);
    }
    saldoRows = Array.from(saldoMap.entries())
      .map(([ownerId, v]) => ({ ownerId, ...v }))
      .sort((a, b) => (b.opgeroepen - b.voldaan) - (a.opgeroepen - a.voldaan));
  }

  const saldoOk = callsOk && !allocError;

  /**
   * Het formulier voor een NIEUWE betaling.
   *
   * Boeken zonder betrouwbare lijst betekent dubbel boeken; boeken zonder
   * betrouwbare openstaande positie betekent boeken in het duister. Beide
   * gevolgen zijn onomkeerbaar genoeg om het formulier dan gewoon niet te
   * tonen. De reeds zichtbare foutmelding van de stukke bron blijft staan en
   * zegt waarom.
   */
  const ownersOk = !ownershipRes.error;
  const paymentFormOk =
    fy.status === "open" && ownersOk && paymentsOk && callsOk && saldoOk;
  const totalOpgeroepen = calls.reduce((s, c) => s + Number(c.total_amount), 0);

  return (
    <>

        <div className="card" style={{ padding: "1.1rem 1.4rem", margin: "0.7rem 0 1.4rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ margin: "0 0 0.15rem", fontSize: "1.4rem" }}>Exercice {fy.year}</h1>
            <div className="muted" style={{ fontSize: "0.83rem" }}>
              {b.name} · {fy.start_date} → {fy.end_date}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {/* Geen bedrag zolang de oproepen niet betrouwbaar zijn geladen. */}
            {callsOk && totalOpgeroepen > 0 && (
              <span style={{ fontWeight: 600, fontSize: "1.05rem" }}>{fmt(totalOpgeroepen)} MAD appelés</span>
            )}
            <span className={`badge ${fy.status === "open" ? "badge-klein" : "badge-midden"}`}>
              {fy.status === "open" ? "Ouvert" : "Clôturé"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <section>
              <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>
                {/* Zonder betrouwbare gegevens ook geen aantal: "(0)" zou een
                    bewering zijn die we niet kunnen waarmaken. */}
                {tc("title")}
                {callsOk ? ` (${calls.length})` : null}
              </h2>

              {/*
                FAIL-CLOSED. Deze melding staat bewust BUITEN elke rol- en
                boekjaarvoorwaarde: een viewer en een gesloten boekjaar hebben
                net zo goed recht op de waarschuwing dat de cijfers ontbreken.
                Geen totaal, geen aantal, geen "geen oproepen" — en nooit de
                databasetekst zelf.
              */}
              {!callsOk && (
                <div
                  className="card"
                  style={{ padding: "1rem", fontSize: "0.88rem" }}
                  role="alert"
                  data-testid="calls-error"
                >
                  {tc("errors.callsUnavailable")}
                </div>
              )}

              {callsOk && calls.length === 0 && (
                <div className="card muted" style={{ padding: "1rem", fontSize: "0.88rem" }}>
                  {tc("noCharges")}
                </div>
              )}

              <div style={{ display: "grid", gap: "0.7rem" }}>
                {(callsOk ? calls : []).map((cc) => {
                  const telaat = cc.due_date && new Date(cc.due_date) < new Date();
                  const verdeling = verdelingVan(cc);
                  return (
                    <div key={cc.id} className="card" style={{ padding: "0.9rem 1rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.97rem" }}>
                            {cc.label ?? (cc.period ? `Appel ${cc.period}` : `Appel ${cc.call_date}`)}
                          </div>
                          <div className="muted" style={{ fontSize: "0.78rem", marginTop: 2 }}>
                            {cc.type === "exceptionnel" ? "Exceptionnel" : "Régulier"}
                            {cc.period && ` · ${cc.period}`}
                            {" · "}Date : {cc.call_date}
                            {cc.due_date && ` · Échéance : `}
                            {cc.due_date && (
                              <span style={{ color: telaat ? "var(--crit)" : undefined }}>
                                {cc.due_date}{telaat ? " ⚠ en retard" : ""}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: "1rem" }}>{fmt(Number(cc.total_amount))} MAD</div>
                        </div>
                      </div>

                      {cc.charge_allocations.length > 0 && (
                        <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--line)", paddingTop: "0.6rem" }}>
                          <div className="label" style={{ marginBottom: "0.35rem" }}>Répartition par lot</div>
                          <div style={{ display: "grid", gap: "0.3rem" }}>
                            {cc.charge_allocations.map((ca) => {
                              return (
                                <div key={ca.id} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", alignItems: "center" }}>
                                  <span>
                                    <strong>{ca.units?.label ?? "—"}</strong>
                                    {ca.owners && <span className="muted"> · {ca.owners.full_name}</span>}
                                  </span>
                                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                    <span style={{ fontWeight: 600 }}>{fmt(Number(ca.amount))} MAD</span>
                                    {allocBadge(Number(ca.settled_amount), Number(ca.amount), cc.due_date)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/*
                        De DEFINITIEVE verdeling, letterlijk uit
                        `charge_allocations`. Dat is de door de database
                        vastgelegde uitkomst van de centverdeling, inclusief de
                        restcenten; hier wordt niets herberekend. De snapshotkop
                        erboven vertelt welke regel er werkelijk is toegepast.
                      */}
                      <details style={{ marginTop: "0.75rem" }}>
                        <summary className="cursor-pointer text-[0.8rem] font-medium">
                          {tc("result.title")}
                        </summary>
                        <div className="mt-2 flex flex-col gap-2">
                          <dl className="text-ink-soft m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.75rem]">
                            <dt>{tc("result.rule")}</dt>
                            <dd className="m-0">{cc.alloc_rule_label}</dd>
                            <dt>{tc("result.method")}</dt>
                            <dd className="m-0">
                              {tc(`methods.${cc.alloc_method}` as never)} /{" "}
                              {tc(`scopes.${cc.alloc_scope}` as never)}
                            </dd>
                            <dt>{tc("result.participants")}</dt>
                            <dd className="m-0 [font-variant-numeric:tabular-nums]">
                              {cc.alloc_unit_count}
                            </dd>
                            {cc.alloc_partial_denominator && (
                              <>
                                <dt>{tc("result.partial")}</dt>
                                <dd className="text-warn m-0">✓</dd>
                              </>
                            )}
                          </dl>

                          {!verdeling.volledig ? (
                            /*
                              Niet "geen regels": de engine bediende
                              `alloc_unit_count` lots, en zoveel rijen hebben we
                              niet. Dan is dit geen definitief resultaat maar
                              een onvolledige lijst, en die tonen we niet.
                            */
                            <p
                              className="text-crit m-0 text-[0.78rem]"
                              role="alert"
                              data-testid="lines-error"
                            >
                              {tc("result.unavailable")}
                            </p>
                          ) : verdeling.regels.length === 0 ? (
                            <p className="text-ink-soft m-0 text-[0.78rem]">
                              {tc("result.noLines")}
                            </p>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full text-[0.78rem] [font-variant-numeric:tabular-nums]">
                                <caption className="text-ink-soft text-start text-[0.72rem]">
                                  {tc("result.source")}
                                </caption>
                                <thead>
                                  <tr>
                                    <th className="text-ink-soft text-start font-medium">
                                      {tc("result.unit")}
                                    </th>
                                    <th className="text-ink-soft text-end font-medium">
                                      {tc("result.amount")}
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {verdeling.regels.map((regel) => (
                                    <tr key={`${cc.id}-${regel.label}`}>
                                      <td className="text-start">{regel.label}</td>
                                      <td className="text-end">
                                        {formatMoney(regel.amountCents / 100, locale)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            </section>

            {/*
              De workflow vervangt het losse formulier: invoeren, controleren en
              pas daarna definitief aanmaken. Drie poorten staan ervoor.

              1. SCHRIJFRECHT. Een leesrol krijgt het formulier niet te zien.
                 Dat is geen beveiliging - de RPC toetst `can_write` zelf - maar
                 het voorkomt een knop waarvan we weten dat hij faalt.
              2. OPEN BOEKJAAR. Een gesloten boekjaar weigert de database.
              3. VOLLEDIGE BRONNEN. Faalde een van de queries waarop de controle
                 steunt, dan verschijnt er GEEN aanmaakknop en geen groene
                 gereedmelding, maar een foutmelding. Een mislukte query mag
                 nooit als gezonde data doorgaan.
            */}
            {mayWrite && fy.status === "open" && (
              workflowOk ? (
                <ChargeCallWorkflow
                  buildingId={buildingId}
                  fiscalYearId={fyId}
                  fiscalYear={{ year: fy.year, status: fy.status }}
                  declaredTantiemes={b.total_tantiemes}
                  rules={rules}
                  units={lots}
                  ruleUnits={ruleUnits}
                  ruleWeights={ruleWeights}
                  ownership={ownershipRows}
                  today={vandaag}
                />
              ) : (
                <div className="card mt-4 p-4" role="alert" data-testid="workflow-error">
                  <p className="m-0 text-[0.85rem] font-medium">{tc("errors.generic")}</p>
                </div>
              )
            )}
          </div>

          <div style={{ display: "grid", gap: "1.4rem" }}>
            <section id="betalingen">
              <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>Paiements</h2>

              {!paymentsOk && (
                <div
                  className="card"
                  style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}
                  role="alert"
                  data-testid="payments-error"
                >
                  {tc("errors.paymentsUnavailable")}
                </div>
              )}

              {/*
                FAIL-CLOSED op de STORNOSTATUS. Een rij zonder stornomarkering
                beweert dat er niet gestorneerd is. Kon de reversal-view niet
                worden gelezen, dan is dat een bewering die we niet kunnen
                waarmaken - dus geen rijen, geen lege toestand, en nooit de
                naam van de view of de databasetekst in beeld.
              */}
              {paymentsOk && !reversalsOk && (
                <div
                  className="card"
                  style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}
                  role="alert"
                  data-testid="reversals-error"
                >
                  {tr("errors.statusUnavailable")}
                </div>
              )}

              {paymentRowsOk && pays.length === 0 && (
                <div className="card muted" style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}>
                  Aucun paiement.
                </div>
              )}

              {/*
                De boekjaarstatus achter de storno-/correctieknoppen. De rijen
                zelf blijven staan - hun bedrag en stornostatus zijn betrouwbaar
                - maar er verschijnt geen actie waarvan we niet weten of de
                database hem toestaat.
              */}
              {paymentRowsOk && !actionStatusOk && pays.length > 0 && (
                <div
                  className="card"
                  style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}
                  role="alert"
                  data-testid="action-status-error"
                >
                  {tr("errors.actionStatusUnavailable")}
                </div>
              )}

              <div style={{ display: "grid", gap: "0.55rem" }}>
                {(paymentRowsOk ? pays : []).map((p) => {
                  // `reversal` = deze betaling is gestorneerd.
                  // `correction` = deze betaling IS de vervangende rij.
                  const reversal = reversalOf(reversals, p.id);
                  const correction = correctionOf(reversals, p.id);
                  const isClosed = closedPayments.has(p.id);
                  // Zonder betrouwbare boekjaarstatus geen actieknop: `isClosed`
                  // zou dan stil `false` zijn en de knop zou owner/admin-recht
                  // suggereren waar de database het weigert.
                  const mayReverse =
                    reversal === null && actionStatusOk && canReverse(role, isClosed);

                  return (
                  <div key={p.id} className="card" style={{ padding: "0.75rem 0.9rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "0.9rem", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          {p.owners?.full_name ?? "—"}
                          {reversal && (
                            <span className="badge badge-storno">
                              {reversal.isCorrection ? tr("corrected") : tr("reversed")}
                            </span>
                          )}
                          {correction && <span className="badge badge-correctie">{tr("isCorrection")}</span>}
                        </div>
                        <div className="muted" style={{ fontSize: "0.76rem" }}>
                          {p.value_date} · {p.method}{p.reference ? ` · ${p.reference}` : ""}
                        </div>
                      </div>
                      <div
                        className={reversal ? "amount-reversed" : undefined}
                        style={reversal ? { fontSize: "0.95rem" } : { fontWeight: 700, color: "var(--good)", fontSize: "0.95rem" }}
                      >
                        +{fmt(Number(p.amount))} MAD
                      </div>
                    </div>

                    {reversal && (
                      <div className="muted" style={{ fontSize: "0.74rem", marginTop: 4, lineHeight: 1.45 }}>
                        {reversal.isCorrection ? tr("replacedBy") : tr("typeReversal")}
                        {" · "}
                        {tr("reasonLabel")}: {reversal.reason}
                        {reversal.effectiveDate && <> · {reversal.effectiveDate}</>}
                        {reversal.isPriorYearCorrection && <> · {tr("priorYear")}</>}
                      </div>
                    )}
                    {correction && (
                      <div className="muted" style={{ fontSize: "0.74rem", marginTop: 4 }}>
                        {tr("correctionOf")}
                      </div>
                    )}

                    {p.payment_allocations.length > 0 && (
                      <div style={{ marginTop: "0.5rem", borderTop: "1px solid var(--line)", paddingTop: "0.4rem" }}>
                        {p.payment_allocations.map((pa, i) => {
                          const ca = pa.charge_allocations;
                          if (!ca) return null;
                          const periode = ca.charge_calls?.period ?? ca.charge_calls?.label ?? "—";
                          return (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.76rem", color: "var(--ink-soft)" }}>
                              <span>{ca.units?.label ?? "?"} · {periode}</span>
                              <span>{fmt(Number(pa.amount))} MAD</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {mayReverse && (
                      <div style={{ marginTop: "0.55rem", borderTop: "1px solid var(--line)", paddingTop: "0.5rem" }}>
                        <PaymentReversalActions
                          paymentId={p.id}
                          fiscalYearId={fyId}
                          ownerName={p.owners?.full_name ?? "—"}
                          amount={Number(p.amount)}
                          valueDate={p.value_date}
                          method={p.method}
                          reference={p.reference}
                          closedFiscalYear={isClosed}
                        />
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>

              {paymentFormOk && eigenaars.length > 0 && (
                <ActionForm action={createPayment} className="card" style={{ padding: "1rem 1.1rem", marginTop: "0.7rem" }}>
                  <input type="hidden" name="building_id" value={buildingId} />
                  <input type="hidden" name="fiscal_year_id" value={fyId} />
                  <h3 style={{ fontSize: "0.88rem", margin: "0 0 0.75rem" }}>Enregistrer un paiement</h3>

                  <div style={{ marginBottom: "0.6rem" }}>
                    <label className="label" htmlFor="owner_id">Propriétaire</label>
                    <select className="input" id="owner_id" name="owner_id" required>
                      {eigenaars.map((o) => (
                        <option key={o.id} value={o.id}>{o.full_name}</option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.6rem", marginBottom: "0.6rem" }}>
                    <div>
                      <label className="label" htmlFor="pay_amount">Montant (MAD)</label>
                      <input className="input" id="pay_amount" name="amount" type="text" placeholder="300.00" required />
                    </div>
                    <div>
                      <label className="label" htmlFor="value_date">Date</label>
                      <input className="input" id="value_date" name="value_date" type="date" required />
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.6rem", marginBottom: "0.75rem" }}>
                    <div>
                      <label className="label" htmlFor="method">Mode</label>
                      <select className="input" id="method" name="method" defaultValue="virement">
                        <option value="virement">Virement</option>
                        <option value="especes">Espèces</option>
                        <option value="cheque">Chèque</option>
                        <option value="carte">Carte</option>
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="reference">Référence</label>
                      <input className="input" id="reference" name="reference" placeholder="VIR-2026-001" />
                    </div>
                  </div>

                  <button className="btn btn-primary" style={{ width: "100%" }}>Enregistrer</button>
                </ActionForm>
              )}
            </section>

            <section>
              <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>Solde par propriétaire</h2>

              {!saldoOk && (
                <div
                  className="card"
                  style={{ padding: "0.8rem 1rem", fontSize: "0.85rem" }}
                  role="alert"
                  data-testid="balance-error"
                >
                  {tc("errors.balanceUnavailable")}
                </div>
              )}

              {saldoOk && saldoRows.length === 0 && (
                <div className="card muted" style={{ padding: "0.8rem 1rem", fontSize: "0.85rem" }}>
                  Aucun appel ou propriétaire lié.
                </div>
              )}

              {saldoOk && saldoRows.length > 0 && (
                <div className="card" style={{ overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.83rem" }}>
                    <thead>
                      <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--line)" }}>
                        <th style={{ textAlign: "left", padding: "0.55rem 0.8rem", fontWeight: 600, color: "var(--ink-faint)", fontSize: "0.72rem", textTransform: "uppercase" }}>Propriétaire</th>
                        <th style={{ textAlign: "right", padding: "0.55rem 0.6rem", fontWeight: 600, color: "var(--ink-faint)", fontSize: "0.72rem", textTransform: "uppercase" }}>Appelé</th>
                        <th style={{ textAlign: "right", padding: "0.55rem 0.6rem", fontWeight: 600, color: "var(--ink-faint)", fontSize: "0.72rem", textTransform: "uppercase" }}>Payé</th>
                        <th style={{ textAlign: "right", padding: "0.55rem 0.8rem", fontWeight: 600, color: "var(--ink-faint)", fontSize: "0.72rem", textTransform: "uppercase" }}>Solde</th>
                      </tr>
                    </thead>
                    <tbody>
                      {saldoRows.map((row, i) => {
                        const open = row.opgeroepen - row.voldaan;
                        const volledigBetaald = open <= 0.001;
                        return (
                          <tr key={row.ownerId} style={{ borderBottom: i < saldoRows.length - 1 ? "1px solid var(--line)" : "none" }}>
                            <td style={{ padding: "0.55rem 0.8rem" }}>
                              <div style={{ fontWeight: 500 }}>{row.naam}</div>
                              {row.teLaat > 0 && (
                                <div style={{ color: "var(--crit)", fontSize: "0.72rem", fontWeight: 600 }}>
                                  {fmt(row.teLaat)} MAD en retard
                                </div>
                              )}
                            </td>
                            <td style={{ textAlign: "right", padding: "0.55rem 0.6rem" }}>{fmt(row.opgeroepen)}</td>
                            <td style={{ textAlign: "right", padding: "0.55rem 0.6rem", color: "var(--good)" }}>{fmt(row.voldaan)}</td>
                            <td style={{ textAlign: "right", padding: "0.55rem 0.8rem", fontWeight: 600 }}>
                              <span style={{ color: volledigBetaald ? "var(--good)" : row.teLaat > 0 ? "var(--crit)" : "var(--warn)" }}>
                                {volledigBetaald ? "✓" : fmt(open)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: "2px solid var(--line)", background: "var(--surface-2)" }}>
                        <td style={{ padding: "0.6rem 0.8rem", fontWeight: 700, fontSize: "0.85rem" }}>Total</td>
                        <td style={{ textAlign: "right", padding: "0.6rem 0.6rem", fontWeight: 700 }}>{fmt(saldoRows.reduce((s, r) => s + r.opgeroepen, 0))}</td>
                        <td style={{ textAlign: "right", padding: "0.6rem 0.6rem", fontWeight: 700, color: "var(--good)" }}>{fmt(saldoRows.reduce((s, r) => s + r.voldaan, 0))}</td>
                        <td style={{ textAlign: "right", padding: "0.6rem 0.8rem", fontWeight: 700 }}>{fmt(saldoRows.reduce((s, r) => s + (r.opgeroepen - r.voldaan), 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
    </>
  );
}

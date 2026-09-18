import { getTranslations } from "next-intl/server";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { canWrite } from "@/lib/roles";
import { Link } from "@/navigation";
import Card, { CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Table, { Td, Th } from "@/components/ui/Table";
import Empty, { EmptyBody, EmptyTitle } from "@/components/ui/Empty";
import { buttonClasses } from "@/components/ui/Button";
import { formatDate } from "@/lib/money";
import {
  assembleOwnership,
  classifyOwnership,
  currentOwnerships,
  groupByUnit,
  lotStatus,
  matchesUnitSearch,
  tantiemeOverzicht,
  transferability,
  type LotStatus,
  type OwnerRow,
  type OwnershipRow,
  type TransferBlockReason,
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
 * onveilig. De vorige versie behandelde die twee als één, waardoor elke geldige
 * mede-eigendom een waarschuwing opleverde over lastenoproepen die in
 * werkelijkheid gewoon slagen.
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
            Elke conditie krijgt een EIGEN regel. Een ternary toonde er hooguit
            één, waardoor een gebouw met zowel een eigendomsprobleem als een
            tantièmeprobleem de tweede oorzaak verzweeg — de gebruiker loste er
            dan één op en liep tegen dezelfde weigering aan.

            Alle drie zijn geformuleerd als HUIDIGE stand van de basisgegevens.
            De engine oordeelt over de lots binnen de scope van de gekozen
            verdeelregel en op de opgegeven oproepdatum; dat weet dit scherm
            niet, dus het belooft geen geslaagde oproep.

            `role="alert"` alleen waar de weigering onvoorwaardelijk is zodra het
            lot meedoet: een ontbrekende of ambigue eigenaar (ALLOC_NO_OWNER,
            ALLOC_AMBIGUOUS_OWNER) en een tantième van nul
            (ALLOC_WEIGHT_MISSING). Het controletotaal krijgt `role="status"`:
            de engine kent daar een gedocumenteerde afwijking
            (`partial_denominator_until_year`), dus die is niet absoluut.

            Geldige mede-eigendom staat hier bewust NIET tussen; die krijgt
            onderaan een neutrale toelichting.
          */}
          {!overzicht.eigendomVeilig ? (
            <p className="mt-3 mb-0 text-[0.8rem] text-crit" role="alert">
              {t("tantiemes.warningOwnership")}
            </p>
          ) : null}

          {overzicht.zonderTantieme > 0 ? (
            <p className="mt-2 mb-0 text-[0.8rem] text-warn" role="alert">
              {t("tantiemes.warningZeroTantieme", { count: overzicht.zonderTantieme })}
            </p>
          ) : null}

          {!overzicht.tantiemesKloppen ? (
            <p className="mt-2 mb-0 text-[0.8rem] text-warn" role="status">
              {t("tantiemes.warningTantiemes")}
            </p>
          ) : null}

          {overzicht.medeEigendom > 0 ? (
            <p className="mt-2 mb-0 text-[0.8rem] text-ink-soft">
              {t("tantiemes.coOwnershipNote", { count: overzicht.medeEigendom })}
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

      {/*
        Drie toestanden, één vorm, DRIE BOODSCHAPPEN. Ze delen nu `Empty` zodat
        ze als één systeem ogen, maar ze houden elk hun eigen sleutel en hun
        eigen `role`. Inklappen tot één generieke "leeg" zou de enige vraag
        wegpoetsen die ertoe doet: weten we dat er niets is, of weten we het
        niet? De mislukte variant komt hier trouwens nooit langs — die keert
        al eerder terug via `Fout`.
      */}
      {bronnen.units.length === 0 ? (
        <Empty testId="lots-empty">
          <EmptyTitle>{t("empty.title")}</EmptyTitle>
          <EmptyBody>{t("empty.body")}</EmptyBody>
        </Empty>
      ) : zichtbaar.length === 0 ? (
        <Empty role="status" testId="lots-no-results">
          <EmptyBody>{t("search.none", { term: zoekterm })}</EmptyBody>
        </Empty>
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
              const klassering = classifyOwnership(rijen);
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
                    {klassering.nActive === 0 ? (
                      <span className="text-[0.8rem] text-ink-soft">{t("noOwner")}</span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        {lopend.map((rij) => (
                          <span key={rij.id} className="flex flex-wrap items-center gap-1">
                            <Link
                              href={`/owners/${rij.owner_id}`}
                              className="text-[0.85rem] text-primary"
                            >
                              {ownerNaam.get(rij.owner_id) ?? t("unknownOwner")}
                            </Link>
                            {/*
                              Bij gedeelde eigendom moet zichtbaar zijn WIE de
                              vordering krijgt. De statuskolom toont dan niet
                              altijd "mede-eigendom" — een tantième van nul weegt
                              zwaarder — dus deze markering staat hier, waar hij
                              onafhankelijk van die precedentie blijft staan.
                            */}
                            {klassering.nActive > 1 && rij.is_primary_debtor ? (
                              <Badge tone="info">{t("primaryDebtor")}</Badge>
                            ) : null}
                          </span>
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
              const klassering = classifyOwnership(rijen);
              const heeftHistorie = rijen.length > 0;
              // Alle vooraf kenbare precondities van transfer_ownership in één
              // geteste beslissing, inclusief het datumvenster. Eerder stond
              // hier alleen `nActive === 1`, waardoor een formulier verscheen
              // dat gegarandeerd faalde bij een niet-primaire eigenaar, een
              // gedeeltelijk aandeel, of een eigendom die vandaag begon.
              const overdracht = transferability(rijen, vandaag);

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
                        ) : overdracht.allowed ? (
                          <TransferOwnershipForm
                            buildingId={buildingId}
                            unitId={unit.id}
                            current={overdracht.current}
                            currentOwnerName={
                              ownerNaam.get(overdracht.current.owner_id) ?? t("unknownOwner")
                            }
                            owners={bronnen.owners}
                            minDate={overdracht.minDate}
                            maxDate={overdracht.maxDate}
                            defaultDate={overdracht.defaultDate}
                            periodLabel={t("ownership.since", {
                              date: formatDate(overdracht.current.start_date, locale),
                            })}
                          />
                        ) : (
                          <Blokkade
                            reason={overdracht.reason}
                            t={t}
                            debiteur={
                              klassering.debiteur
                                ? (ownerNaam.get(klassering.debiteur.owner_id) ??
                                  t("unknownOwner"))
                                : t("unknownOwner")
                            }
                          />
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
      ) : (
        <AlleenLezen t={t} />
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

/**
 * Waarom de eenvoudige overdrachtsflow hier niet beschikbaar is.
 *
 * Alleen `ambigu` is een echte blokkade voor lastenoproepen en krijgt daarom
 * `role="alert"`. De overige redenen zijn grenzen van DEZE flow: het lot is
 * financieel gewoon in orde, er kan hier alleen niet worden overgedragen. Die
 * krijgen een neutrale statusmelding, zodat een beheerder niet gaat zoeken naar
 * een probleem dat er niet is.
 *
 * Geen RPC-, tabel- of foutcodenamen in de teksten; de sleutels verwijzen naar
 * de vertaling.
 */
const BLOKKADE_TEKST: Record<TransferBlockReason, string> = {
  geenEigenaar: "ownership.historyOnly",
  medeEigendom: "ownership.coOwned",
  ambigu: "ownership.ambiguous",
  nietPrimair: "ownership.notPrimary",
  gedeeltelijkAandeel: "ownership.partialShare",
  vandaagBegonnen: "ownership.tooRecent",
};

function Blokkade({
  reason,
  t,
  debiteur,
}: {
  reason: TransferBlockReason;
  t: Awaited<ReturnType<typeof getTranslations>>;
  debiteur: string;
}) {
  const blokkerend = reason === "ambigu";
  const sleutel = BLOKKADE_TEKST[reason];
  return (
    <p
      className={`m-0 text-[0.8rem] ${blokkerend ? "text-crit" : "text-ink-soft"}`}
      role={blokkerend ? "alert" : "status"}
    >
      {reason === "medeEigendom" ? t(sleutel as never, { debiteur }) : t(sleutel as never)}
    </p>
  );
}

const STATUS_TONE: Record<LotStatus, "good" | "warn" | "crit" | "info"> = {
  compleet: "good",
  zonderEigenaar: "crit",
  // Blokkeert de oproep net zo hard als een lot zonder eigenaar.
  ambigu: "crit",
  // GEEN waarschuwing: een aangewezen debiteur maakt dit een geldige toestand.
  medeEigendom: "info",
  zonderTantieme: "warn",
};

function StatusBadge({ status, label }: { status: LotStatus; label: string }) {
  return <Badge tone={STATUS_TONE[status]}>{label}</Badge>;
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
 * geldige rol en geen storing waar iemand achteraan moet. Hiervoor stond hier
 * niets — het scherm was voor een lezer stilzwijgend onvolledig, zonder enige
 * aanwijzing waarom de knoppen ontbraken.
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

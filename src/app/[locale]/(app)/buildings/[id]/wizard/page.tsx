import { getTranslations } from "next-intl/server";
import { requireOrg } from "@/lib/org";
import { canWrite } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { Link } from "@/navigation";
import Card, { CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Empty, { EmptyBody, EmptyTitle } from "@/components/ui/Empty";
import { assembleOwnership, type OwnershipRow } from "@/lib/ownership";
import { bouwChecklist, type Stap, type StapStand } from "@/lib/wizard";
import type { BlockRow, LayoutUnitRow } from "@/lib/layout";

/**
 * INSTELLEN: de begeleide checklist van één gebouw.
 *
 * ── WAT DIT SCHERM IS ──────────────────────────────────────────────────────
 *
 * Een leeswijzer, geen zesde manier om dingen aan te maken. Het leest de stand
 * van het gebouw en wijst per stap naar het BESTAANDE scherm waar die stap
 * gedaan wordt. Er staat geen enkel formulier op en er wordt geen server action
 * aangeroepen; de guards en meldingen blijven staan waar ze al stonden.
 *
 * Dat is een bewuste keuze en geen tussenoplossing: de bestaande acties
 * redirecten allemaal naar hun eigen scherm (`localeRedirect` gooit en keert
 * nooit terug). Een wizard die hun formulieren inbedt, verliest de gebruiker bij
 * de eerste submit. Sequencen via links werkt daarentegen zonder één regel van
 * die acties aan te raken.
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────
 *
 * Vier bronnen, en één mislukking onderdrukt de HELE checklist. Dat is hier
 * scherper dan elders: een checklist is een reeks BEWERINGEN ("3 lots",
 * "0 gekoppeld"). Een mislukte query die als lege lijst doorgaat, zou zeggen
 * "nog geen lots — voeg toe" tegen iemand die er achtentwintig heeft, en die
 * gaat ze dan opnieuw invoeren. Een onbekende stand mag daarom niet als
 * nulstand verschijnen.
 *
 * `units`, `ownership` en `owners` lopen door dezelfde `assembleOwnership()` als
 * het lots- en indelingsscherm. `blocks` krijgt een eigen nullcontrole.
 */

const STAND_TOON: Record<StapStand, "good" | "warn" | "info"> = {
  klaar: "good",
  bezig: "warn",
  tedoen: "warn",
  // Leeg-en-geldig is informatie, geen waarschuwing. Zou hier `warn` staan, dan
  // zou een gebouw zonder blokken er voor altijd onaf uitzien.
  optioneel: "info",
  wacht: "info",
};

export default async function WizardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: buildingId } = await params;
  const { org, role } = await requireOrg();
  const mayWrite = canWrite(role);
  const t = await getTranslations("wizard");
  const supabase = await createClient();

  const buildingRes = await supabase
    .from("buildings")
    .select("id, name")
    .eq("id", buildingId)
    .eq("organization_id", org.id)
    .maybeSingle();

  if (buildingRes.error) {
    logWizardFout("building", [`buildings:${buildingRes.error.code}`]);
    return <Fout t={t} />;
  }
  if (!buildingRes.data) {
    return (
      <Empty role="status" testId="wizard-notfound">
        <EmptyTitle>{t("notFound")}</EmptyTitle>
        <EmptyBody>
          <Link href="/buildings" className="text-primary">
            {t("backToBuildings")}
          </Link>
        </EmptyBody>
      </Empty>
    );
  }
  const building = buildingRes.data as { id: string; name: string };

  const blockRes = await supabase
    .from("blocks")
    .select("id, building_id, code, name, sort_order, archived_at")
    .eq("building_id", buildingId)
    .eq("organization_id", org.id);
  const blocks = blockRes.error ? null : ((blockRes.data ?? []) as BlockRow[]);

  const unitRes = await supabase
    .from("units")
    .select("id, building_id, block_id, label, unit_type, tantiemes")
    .eq("building_id", buildingId);
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

  // Eigenaren zijn organisatiebreed; de scope is hier de ORGANISATIE, niet het
  // gebouw. Stap 4 vraagt immers "is er iemand om te koppelen".
  //
  // ALLEEN `id`. Dit scherm rendert geen enkele eigenaarsnaam — het toont een
  // AANTAL. Ook `full_name` ophalen zou van elke eigenaar in de organisatie een
  // persoonsgegeven naar de server halen waar niets mee gebeurt, en die payload
  // groeit mee met het klantenbestand. Wat je niet nodig hebt, haal je niet op.
  const ownerRes = await supabase
    .from("owners")
    .select("id")
    .eq("organization_id", org.id);
  const owners = ownerRes.error ? null : ((ownerRes.data ?? []) as { id: string }[]);

  const bronnen = assembleOwnership({ units, ownership, owners });
  if (blocks === null || bronnen.status === "error") {
    const codes: string[] = [];
    if (blockRes.error) codes.push(`blocks:${blockRes.error.code}`);
    if (unitRes.error) codes.push(`units:${unitRes.error.code}`);
    if (ownershipRes.error) codes.push(`ownership:${ownershipRes.error.code}`);
    if (ownerRes.error) codes.push(`owners:${ownerRes.error.code}`);
    logWizardFout("sources", codes);
    return <Fout t={t} />;
  }

  const checklist = bouwChecklist({
    buildingId,
    blocks,
    units: bronnen.units,
    ownership: bronnen.ownership,
    aantalEigenaren: bronnen.owners.length,
  });
  const percentage = Math.round((checklist.gedaan / checklist.totaal) * 100);

  return (
    <>
      <header className="mb-5">
        <h1 className="m-0 text-[1.35rem] font-semibold break-words">{t("title")}</h1>
        <p className="mt-1 mb-0 text-[0.85rem] text-ink-soft">
          {t("subtitle", { building: building.name })}
        </p>
      </header>

      <section aria-labelledby="wizard-voortgang-kop" className="mb-5">
        <Card>
          <CardHeader
            title={<span id="wizard-voortgang-kop">{t("progress.title")}</span>}
            actions={
              <span className="text-[0.8rem] text-ink-soft [font-variant-numeric:tabular-nums]">
                {t("progress.count", { gedaan: checklist.gedaan, totaal: checklist.totaal })}
              </span>
            }
          />
          {/* `inlineSize` in plaats van `width`: logisch, dus in het Arabisch
              groeit de balk vanzelf vanaf de andere kant. */}
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={percentage}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("progress.title")}
            data-testid="wizard-voortgang"
          >
            <div className="h-full bg-primary" style={{ inlineSize: `${percentage}%` }} />
          </div>

          {checklist.compleet ? (
            <p className="mt-3 mb-0 text-[0.85rem]" role="status" data-testid="wizard-compleet">
              {t("progress.done")}{" "}
              <Link
                href={`/buildings/${buildingId}/indeling`}
                className="text-primary"
                data-testid="wizard-naar-indeling"
              >
                {t("progress.toLayout")}
              </Link>
            </p>
          ) : null}
        </Card>
      </section>

      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {checklist.stappen.map((stap) => (
          <StapKaart key={stap.sleutel} stap={stap} t={t} mayWrite={mayWrite} />
        ))}
      </ol>

      {/*
        Wat een LEZER hier ziet. De checklist zelf is voor iedereen leesbaar —
        weten hoe een gebouw ervoor staat is geen schrijfrecht. Alleen de
        linkteksten verschillen: iemand naar "blok toevoegen" sturen terwijl hij
        dat niet mag, is een val.
      */}
      {!mayWrite ? (
        <section className="mt-5">
          <Card role="status" data-testid="wizard-readonly">
            <p className="m-0 font-medium">{t("readOnly.title")}</p>
            <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("readOnly.body")}</p>
          </Card>
        </section>
      ) : null}
    </>
  );
}

function StapKaart({
  stap,
  t,
  mayWrite,
}: {
  stap: Stap;
  t: Awaited<ReturnType<typeof getTranslations>>;
  mayWrite: boolean;
}) {
  // Eén sleutel per stap én stand. Zo staat de hele zin in het vertaalbestand
  // en niet half in deze component.
  const samenvatting = t(`steps.${stap.sleutel}.${stap.stand}` as never, stap.waarden);
  const actie = mayWrite
    ? t(`steps.${stap.sleutel}.action` as never)
    : t(`steps.${stap.sleutel}.view` as never);

  return (
    <li data-testid={`wizard-stap-${stap.sleutel}`} data-stand={stap.stand}>
      <Card>
        <CardHeader
          title={
            <span className="break-words">
              {t("stepLabel", { nummer: stap.nummer })} · {t(`steps.${stap.sleutel}.title` as never)}
            </span>
          }
          actions={
            <Badge tone={STAND_TOON[stap.stand]}>{t(`stand.${stap.stand}` as never)}</Badge>
          }
        />
        <p className="mt-0 mb-3 text-[0.85rem] text-ink-soft">{samenvatting}</p>
        <Link
          href={stap.href}
          className="text-[0.85rem] text-primary"
          data-testid={`wizard-link-${stap.sleutel}`}
        >
          {actie}
        </Link>
      </Card>
    </li>
  );
}

function Fout({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <Empty toon="fout" role="alert" testId="wizard-unavailable">
      <EmptyTitle toon="fout">{t("loadError.title")}</EmptyTitle>
      <EmptyBody>{t("loadError.body")}</EmptyBody>
    </Empty>
  );
}

/**
 * Wat er in het SERVERLOG terechtkomt. Alleen bron en SQLSTATE — dezelfde
 * conventie als `logIndelingFout` en `blockErrorFingerprint`. Geen
 * Postgres-tekst, geen gebouwnaam, geen id's.
 */
function logWizardFout(scope: "building" | "sources", codes: readonly string[]) {
  console.error(`[wizard] load-failed scope=${scope} ${codes.join(" ") || "sqlstate=?"}`);
}

import { getTranslations } from "next-intl/server";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { canWrite } from "@/lib/roles";
import { Link } from "@/navigation";
import Card, { CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Table, { Td, Th } from "@/components/ui/Table";
import { formatDate } from "@/lib/money";
import {
  isCurrent,
  sortHistory,
  type OwnerRow,
  type OwnershipRow,
} from "@/lib/ownership";
import OwnerForm from "../OwnerForm";
import { updateOwner } from "../actions";

/**
 * Detailpagina van één copropriétaire.
 *
 * ── GEEN GLOBALE TERUGVAL ──────────────────────────────────────────────────
 *
 * `owner_id` komt uit de URL en wordt server-side tegen de actieve organisatie
 * gecontroleerd. Een onbekend of vreemd id levert een expliciete melding op, en
 * NOOIT de gegevens van een andere eigenaar of een organisatiebreed overzicht.
 *
 * ── GEEN TWEEDE FINANCIËLE WAARHEID ────────────────────────────────────────
 *
 * Deze pagina toont bewust GEEN openstaand saldo per eigenaar. Zo'n bedrag zou
 * uit `charge_allocations` moeten komen en zou dan naast het dashboard een
 * tweede definitie van "openstaand" introduceren, met een eigen boekjaar- en
 * stornoscope. Zolang die definitie niet uit één bestaande, bewezen bron volgt,
 * verwijst deze pagina naar het gebouw en het boekjaar waar de cijfers al
 * kloppen in plaats van ze hier opnieuw uit te rekenen.
 */
export default async function OwnerDetailPage({
  params,
}: {
  params: Promise<{ locale: string; owner_id: string }>;
}) {
  const { locale, owner_id } = await params;
  const { org, role } = await requireOrg();
  const t = await getTranslations("owners");
  const supabase = await createClient();
  const mayWrite = canWrite(role);

  const ownerRes = await supabase
    .from("owners")
    .select("id, full_name, is_company, email, phone, language, is_mre")
    .eq("id", owner_id)
    .eq("organization_id", org.id)
    .maybeSingle();

  if (ownerRes.error) return <Fout t={t} />;
  if (!ownerRes.data) {
    return (
      <>
        <Terug t={t} />
        <Card>
          <p className="m-0 font-medium" role="status">
            {t("detail.notFound")}
          </p>
          <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("detail.notFoundBody")}</p>
        </Card>
      </>
    );
  }
  const owner = ownerRes.data as OwnerRow;

  // Volledige eigendomshistorie van deze eigenaar. Een fout hier mag NOOIT als
  // "deze eigenaar bezit niets" worden getoond.
  const ownershipRes = await supabase
    .from("ownership")
    .select("id, unit_id, owner_id, share, start_date, end_date, is_primary_debtor")
    .eq("owner_id", owner_id);
  if (ownershipRes.error) return <Fout t={t} />;
  const ownership = (ownershipRes.data ?? []) as OwnershipRow[];

  const unitIds = [...new Set(ownership.map((o) => o.unit_id))];
  const unitRes =
    unitIds.length > 0
      ? await supabase
          .from("units")
          .select("id, building_id, label, unit_type, tantiemes")
          .in("id", unitIds)
      : { data: [] as UnitLite[], error: null };
  if (unitRes.error) return <Fout t={t} />;
  const units = (unitRes.data ?? []) as UnitLite[];

  const buildingIds = [...new Set(units.map((u) => u.building_id))];
  const buildingRes =
    buildingIds.length > 0
      ? await supabase
          .from("buildings")
          .select("id, name")
          .eq("organization_id", org.id)
          .in("id", buildingIds)
      : { data: [] as { id: string; name: string }[], error: null };
  if (buildingRes.error) return <Fout t={t} />;
  const buildingNaam = new Map(
    ((buildingRes.data ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]),
  );

  const unitById = new Map(units.map((u) => [u.id, u]));
  const historie = sortHistory(ownership);
  const actueel = historie.filter(isCurrent);

  // Actuele lots gegroepeerd per gebouw. Een lot waarvan het gebouw buiten de
  // organisatie valt kan hier niet voorkomen — de gebouwquery is org-gescoopt —
  // maar wordt voor de zekerheid ook niet als "onbekend gebouw" opgevoerd.
  const perGebouw = new Map<string, UnitLite[]>();
  for (const rij of actueel) {
    const unit = unitById.get(rij.unit_id);
    if (!unit) continue;
    const lijst = perGebouw.get(unit.building_id);
    if (lijst) lijst.push(unit);
    else perGebouw.set(unit.building_id, [unit]);
  }

  return (
    <>
      <Terug t={t} />

      <header className="mb-5">
        <h1 className="m-0 text-[1.35rem] font-semibold break-words">{owner.full_name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge tone="info">{owner.is_company ? t("type.company") : t("type.person")}</Badge>
          {owner.is_mre ? <Badge tone="warn">{t("mre")}</Badge> : null}
          <span className="text-[0.8rem] text-ink-soft">{owner.language.toUpperCase()}</span>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="owner-contact-kop">
          <Card>
            <CardHeader title={<span id="owner-contact-kop">{t("detail.contact")}</span>} />
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[0.875rem]">
              <li className="flex flex-wrap items-center gap-2">
                <Mail size={15} aria-hidden="true" className="text-ink-soft" />
                <span className="min-w-0 break-words">{owner.email ?? t("noContact")}</span>
              </li>
              <li className="flex flex-wrap items-center gap-2">
                <Phone size={15} aria-hidden="true" className="text-ink-soft" />
                <span className="min-w-0 break-words">{owner.phone ?? t("noContact")}</span>
              </li>
            </ul>
          </Card>
        </section>

        <section aria-labelledby="owner-lots-kop">
          <Card>
            <CardHeader title={<span id="owner-lots-kop">{t("detail.currentLots")}</span>} />
            {perGebouw.size === 0 ? (
              <p className="m-0 text-[0.875rem] text-ink-soft" role="status">
                {t("detail.noCurrentLots")}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {[...perGebouw.entries()].map(([buildingId, lots]) => (
                  <li key={buildingId}>
                    <Link
                      href={`/buildings/${buildingId}/lots`}
                      className="text-[0.875rem] font-medium text-primary"
                    >
                      {buildingNaam.get(buildingId) ?? t("unknownBuilding")}
                    </Link>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {lots.map((lot) => (
                        <Badge key={lot.id} tone="info">
                          {lot.label}
                        </Badge>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>

      <section aria-labelledby="owner-historie-kop" className="mt-5">
        <h2 id="owner-historie-kop" className="mb-2 text-[1rem] font-semibold">
          {t("detail.history")}
        </h2>
        {historie.length === 0 ? (
          <Card>
            <p className="m-0 text-[0.875rem] text-ink-soft">{t("detail.historyEmpty")}</p>
          </Card>
        ) : (
          <Table caption={t("detail.history")}>
            <thead>
              <tr>
                <Th>{t("history.building")}</Th>
                <Th>{t("history.lot")}</Th>
                <Th>{t("history.from")}</Th>
                <Th>{t("history.to")}</Th>
                <Th>{t("history.role")}</Th>
              </tr>
            </thead>
            <tbody>
              {historie.map((rij) => {
                const unit = unitById.get(rij.unit_id);
                return (
                  <tr key={rij.id}>
                    <Td>
                      {unit ? (
                        <Link
                          href={`/buildings/${unit.building_id}/lots`}
                          className="text-primary"
                        >
                          {buildingNaam.get(unit.building_id) ?? t("unknownBuilding")}
                        </Link>
                      ) : (
                        <span className="text-ink-soft">{t("unknownBuilding")}</span>
                      )}
                    </Td>
                    <Td>{unit?.label ?? "—"}</Td>
                    <Td>{formatDate(rij.start_date, locale)}</Td>
                    <Td>
                      {rij.end_date ? (
                        formatDate(rij.end_date, locale)
                      ) : (
                        <Badge tone="good">{t("history.ongoing")}</Badge>
                      )}
                    </Td>
                    <Td>
                      {rij.is_primary_debtor ? (
                        <Badge tone="info">{t("history.primary")}</Badge>
                      ) : (
                        <span className="text-[0.8rem] text-ink-soft">
                          {t("history.coOwner")}
                        </span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>

      {mayWrite ? (
        <section aria-labelledby="owner-edit-kop" className="mt-6">
          <Card>
            <CardHeader title={<span id="owner-edit-kop">{t("detail.edit")}</span>} />
            <OwnerForm action={updateOwner} submitLabel={t("detail.save")} owner={owner} />
          </Card>
        </section>
      ) : null}
    </>
  );
}

type UnitLite = {
  id: string;
  building_id: string;
  label: string;
  unit_type: string;
  tantiemes: number;
};

function Terug({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <p className="mb-3">
      <Link href="/owners" className="inline-flex items-center gap-1 text-[0.85rem] text-primary">
        <ArrowLeft size={14} aria-hidden="true" />
        {t("detail.backToList")}
      </Link>
    </p>
  );
}

function Fout({ t }: { t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <>
      <Terug t={t} />
      <Card>
        <p className="m-0 font-medium text-crit" role="alert">
          {t("loadError.title")}
        </p>
        <p className="mt-1 mb-0 text-[0.875rem] text-ink-soft">{t("loadError.body")}</p>
      </Card>
    </>
  );
}

import { getTranslations } from "next-intl/server";
import Card from "@/components/ui/Card";
import { formatDate } from "@/lib/money";
import type { LotRegel } from "@/lib/lots";
import type { OwnerRow, TransferBlockReason } from "@/lib/ownership";
import LotForm from "./LotForm";
import { LinkFirstOwnerForm, TransferOwnershipForm } from "./OwnershipForms";
import { updateLot } from "./actions";

/**
 * De per-lot acties: bewerken, eerste koppeling of overdracht.
 *
 * ── BEKENDE UITGANGSSITUATIE, BEWUST NIET HIER OPGELOST ────────────────────
 *
 * Deze sectie rendert nog steeds ÉÉN `<details>` per zichtbaar lot, elk met een
 * volledig `LotForm` plus een eigendomsformulier waarvan de eigenaarskeuze
 * iedere eigenaar van de organisatie bevat. Bij n lots en m eigenaren staan er
 * dus n formulieren en circa n×m `<option>`-elementen in één document, terwijl
 * de gebruiker er één gebruikt.
 *
 * Dat is een bestaand probleem en het wordt in DEZE fase niet aangeraakt: deze
 * stap mag geen waarneembare gedragswijziging opleveren. Het is hier vastgelegd
 * als meetbare uitgangssituatie; de oplossing is één paneel per keer via de URL,
 * zoals het indelingsscherm dat al doet.
 *
 * ── WELK FORMULIER VERSCHIJNT ──────────────────────────────────────────────
 *
 * Geen historie      -> eerste koppeling
 * Overdraagbaar      -> overdracht, met het venster uit `transferability`
 * Anders             -> een uitleg waarom deze flow hier niet kan
 *
 * De beslissing komt volledig uit het viewmodel; hier wordt niets opnieuw over
 * eigendom bepaald.
 */
export default function LotActions({
  buildingId,
  locale,
  regels,
  owners,
  vandaag,
  t,
}: {
  buildingId: string;
  locale: string;
  regels: readonly LotRegel[];
  owners: readonly OwnerRow[];
  vandaag: string;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  return (
    <section aria-labelledby="lots-acties-kop" className="mt-6">
      <h2 id="lots-acties-kop" className="mb-2 text-[1rem] font-semibold">
        {t("actions.title")}
      </h2>
      <div className="flex flex-col gap-3">
        {regels.map((regel) => (
          <Card key={regel.unit.id}>
            <details>
              <summary className="cursor-pointer text-[0.9rem] font-medium">
                {regel.unit.label}
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
                    lot={regel.unit}
                  />
                </div>

                <div>
                  <h3 className="mt-0 mb-2 text-[0.85rem] font-semibold text-ink-soft">
                    {t("ownership.title")}
                  </h3>
                  {!regel.heeftHistorie ? (
                    <LinkFirstOwnerForm
                      buildingId={buildingId}
                      unitId={regel.unit.id}
                      owners={owners}
                      today={vandaag}
                    />
                  ) : regel.overdracht.allowed ? (
                    <TransferOwnershipForm
                      buildingId={buildingId}
                      unitId={regel.unit.id}
                      current={regel.overdracht.current}
                      currentOwnerName={regel.overdrachtEigenaarNaam ?? t("unknownOwner")}
                      owners={owners}
                      minDate={regel.overdracht.minDate}
                      maxDate={regel.overdracht.maxDate}
                      defaultDate={regel.overdracht.defaultDate}
                      periodLabel={t("ownership.since", {
                        date: formatDate(regel.overdracht.current.start_date, locale),
                      })}
                    />
                  ) : (
                    <Blokkade
                      reason={regel.overdracht.reason}
                      t={t}
                      debiteur={regel.debiteurNaam ?? t("unknownOwner")}
                    />
                  )}
                </div>
              </div>
            </details>
          </Card>
        ))}
      </div>
    </section>
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

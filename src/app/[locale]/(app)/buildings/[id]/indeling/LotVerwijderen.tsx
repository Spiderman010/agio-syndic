import { getTranslations } from "next-intl/server";
import ActionForm from "@/components/ActionForm";
import SubmitButton from "@/components/SubmitButton";
import Card, { CardHeader } from "@/components/ui/Card";
import { Link } from "@/navigation";
import type { LayoutUnitRow } from "@/lib/layout";

import { deleteLot } from "./actions";

/**
 * Het bevestigingspaneel voor het verwijderen van één lot.
 *
 * ── WAAROM EEN PANEEL EN GEEN `confirm()` ──────────────────────────────────
 *
 * Een `window.confirm` is geen grens: JavaScript kan uit staan, en een
 * `onSubmit`-controle draait bij de gebruiker. Hier is de bevestiging een
 * FORMULIERVELD (`confirm=ja`) dat het schema verplicht stelt, dus stelt de
 * SERVER vast dat er bevestigd is. Dat is toetsbaar, en het werkt zonder
 * JavaScript.
 *
 * Bovendien staat het paneel op zijn eigen URL (`?verwijder=<id>`), net als de
 * bewerkpanelen. Eén formulier op de pagina in plaats van één per lot.
 *
 * ── WAT DIT PANEEL WÉL BELOOFT ─────────────────────────────────────────────
 *
 * Alleen dat er een POGING wordt gedaan. Of het lot echt weg mag beslist
 * `trig_00_unit_delete_history`: staat het lot in een vastgelegde lastenoproep,
 * dan weigert de database en komt er een uitleg terug. Dit paneel controleert
 * dat NIET zelf vooraf — dan zou er een tweede definitie van "heeft historie"
 * ontstaan die van de trigger kan afdrijven.
 */
export default async function LotVerwijderen({
  buildingId,
  lot,
}: {
  buildingId: string;
  lot: LayoutUnitRow;
}) {
  const t = await getTranslations("indeling.manage");

  return (
    <Card role="alert" data-testid="lot-verwijder-paneel">
      <CardHeader
        title={<span className="text-crit">{t("deleteLotTitle", { label: lot.label })}</span>}
        actions={
          <Link
            href={`/buildings/${buildingId}/indeling`}
            className="text-[0.8rem] text-primary"
            data-testid="lot-verwijder-annuleer"
          >
            {t("cancel")}
          </Link>
        }
      />

      <p className="mt-0 mb-2 text-[0.875rem]">{t("deleteLotBody")}</p>
      <p className="mt-0 mb-3 text-[0.8rem] text-ink-soft">{t("deleteLotCascade")}</p>

      <ActionForm action={deleteLot}>
        <input type="hidden" name="building_id" value={buildingId} />
        <input type="hidden" name="unit_id" value={lot.id} />
        {/* De bevestiging zelf. Het schema eist letterlijk "ja"; een POST zonder
            dit veld wordt geweigerd voordat er iets wordt verwijderd. */}
        <input type="hidden" name="confirm" value="ja" />
        <SubmitButton
          label={t("deleteLotConfirm")}
          pendingLabel={t("pending")}
          variant="danger"
        />
      </ActionForm>
    </Card>
  );
}

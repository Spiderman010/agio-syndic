import { getTranslations } from "next-intl/server";
import ActionForm from "@/components/ActionForm";
import SubmitButton from "@/components/SubmitButton";
import Card, { CardHeader } from "@/components/ui/Card";
import { Link } from "@/navigation";

import { deleteOwner } from "../actions";

/**
 * Het bevestigingspaneel voor het verwijderen van één eigenaar.
 *
 * Zelfde opzet als bij een lot: de bevestiging is een formulierveld dat het
 * schema verplicht stelt, dus de SERVER stelt vast dat er bevestigd is. Geen
 * `confirm()`, want dat is geen grens.
 *
 * ── WAT DIT PANEEL NIET DOET ───────────────────────────────────────────────
 *
 * Het kijkt niet zelf of deze eigenaar vorderingen of betalingen heeft. Dat
 * beslist `trig_00_owner_delete_history`, met twee eigen codes voor de twee
 * gevallen. Zou dit paneel het vooraf controleren, dan zou er een tweede
 * definitie van "heeft historie" naast de trigger staan — en bij verschil zou
 * het scherm iets beloven wat de database weerlegt.
 *
 * ── HET AANTAL LOTS STAAT ER WÉL BIJ ───────────────────────────────────────
 *
 * Niet als voorwaarde maar als GEVOLG: de eigendomskoppelingen van deze
 * eigenaar verdwijnen mee (ON DELETE CASCADE). Wie op het punt staat een
 * eigenaar van drie lots te verwijderen, hoort dat te zien.
 */
export default async function EigenaarVerwijderen({
  ownerId,
  naam,
  aantalKoppelingen,
}: {
  ownerId: string;
  naam: string;
  aantalKoppelingen: number;
}) {
  const t = await getTranslations("owners.delete");

  return (
    <Card role="alert" data-testid="owner-verwijder-paneel">
      <CardHeader
        title={<span className="text-crit break-words">{t("title", { name: naam })}</span>}
        actions={
          <Link
            href={`/owners/${ownerId}`}
            className="text-[0.8rem] text-primary"
            data-testid="owner-verwijder-annuleer"
          >
            {t("cancel")}
          </Link>
        }
      />

      <p className="mt-0 mb-2 text-[0.875rem]">{t("body")}</p>
      <p className="mt-0 mb-3 text-[0.8rem] text-ink-soft">
        {t("cascade", { count: aantalKoppelingen })}
      </p>

      <ActionForm action={deleteOwner}>
        <input type="hidden" name="owner_id" value={ownerId} />
        <input type="hidden" name="confirm" value="ja" />
        <SubmitButton label={t("confirm")} pendingLabel={t("pending")} variant="danger" />
      </ActionForm>
    </Card>
  );
}

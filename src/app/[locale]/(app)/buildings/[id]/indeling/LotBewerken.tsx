import { getTranslations } from "next-intl/server";
import ActionForm from "@/components/ActionForm";
import Field from "@/components/ui/Field";
import SubmitButton from "@/components/SubmitButton";
import Card, { CardHeader } from "@/components/ui/Card";
import { Link } from "@/navigation";
import type { BlockRow, LayoutUnitRow } from "@/lib/layout";

import { updateLotLayout } from "./actions";

/**
 * Eén lot bewerken vanaf het indelingsscherm.
 *
 * ── WAT HIER NIET STAAT ────────────────────────────────────────────────────
 *
 * Geen gebouwkeuze. `fn_guard_unit_building_immutable` weigert het verplaatsen
 * van een lot naar een ander gebouw, en `units_block_building_fk` eist dat blok
 * en lot hetzelfde gebouw delen. Een keuzelijst met vreemde gebouwen aanbieden
 * zou dus een val zijn: hij faalt gegarandeerd.
 *
 * Om dezelfde reden bevat de blokkeuze uitsluitend NIET-GEARCHIVEERDE blokken
 * van dit gebouw. Hangt het lot nu aan een blok dat daar niet in staat — omdat
 * het gearchiveerd is of niet meer bestaat — dan valt de keuze op "zonder blok"
 * en staat er een waarschuwing bij. Dat blok als stille huidige waarde tonen zou
 * erger zijn: het zou suggereren dat opslaan niets verandert, terwijl het de
 * verwijzing juist zou herstellen. De gebruiker moet de verplaatsing ZIEN.
 */
export default async function LotBewerken({
  buildingId,
  lot,
  blokken,
}: {
  buildingId: string;
  lot: LayoutUnitRow;
  /** Alleen de niet-gearchiveerde blokken van DIT gebouw. */
  blokken: readonly BlockRow[];
}) {
  const t = await getTranslations("indeling.manage");
  const tt = await getTranslations("buildings.unitTypes");

  const huidigBlokBestaat =
    lot.block_id !== null && blokken.some((b) => b.id === lot.block_id);

  return (
    <Card data-testid="lot-paneel">
      <CardHeader
        title={<span>{t("editLot", { label: lot.label })}</span>}
        actions={
          <Link href={`/buildings/${buildingId}/indeling`} className="text-[0.8rem] text-primary">
            {t("close")}
          </Link>
        }
      />

      <ActionForm action={updateLotLayout} className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="building_id" value={buildingId} />
        <input type="hidden" name="unit_id" value={lot.id} />

        <Field id="lot-label" label={t("label")} required>
          <input
            id="lot-label"
            name="label"
            type="text"
            required
            maxLength={80}
            defaultValue={lot.label}
            className="input w-full"
          />
        </Field>

        <Field id="lot-type" label={t("type")}>
          <select
            id="lot-type"
            name="unit_type"
            defaultValue={lot.unit_type}
            className="input w-full"
          >
            <option value="appartement">{tt("appartement")}</option>
            <option value="commerce">{tt("commerce")}</option>
            <option value="parking">{tt("parking")}</option>
            <option value="cave">{tt("cave")}</option>
            <option value="autre">{tt("autre")}</option>
          </select>
        </Field>

        <Field id="lot-tantiemes" label={t("tantiemes")} hint={t("tantiemesHint")} required>
          <input
            id="lot-tantiemes"
            name="tantiemes"
            type="number"
            min="0"
            step="1"
            required
            defaultValue={lot.tantiemes ?? 0}
            className="input w-full"
          />
        </Field>

        <Field id="lot-blok" label={t("block")} hint={t("blockHint")}>
          <select
            id="lot-blok"
            name="block_id"
            defaultValue={huidigBlokBestaat ? (lot.block_id as string) : ""}
            className="input w-full"
          >
            <option value="">{t("noBlock")}</option>
            {blokken.map((blok) => (
              <option key={blok.id} value={blok.id}>
                {blok.name ? `${blok.code} — ${blok.name}` : blok.code}
              </option>
            ))}
          </select>
        </Field>

        {/*
          Het lot hangt aan een blok dat niet meer in de keuzelijst staat. Dat
          moet expliciet zijn: opslaan zonder iets te wijzigen zou het lot naar
          "zonder blok" verplaatsen, en dat is een stille gegevenswijziging.
        */}
        {lot.block_id !== null && !huidigBlokBestaat ? (
          <p className="m-0 text-[0.8rem] text-warn sm:col-span-2" role="status">
            {t("blockArchivedWarning")}
          </p>
        ) : null}

        <div className="sm:col-span-2">
          <SubmitButton label={t("save")} pendingLabel={t("pending")} />
        </div>
      </ActionForm>
    </Card>
  );
}

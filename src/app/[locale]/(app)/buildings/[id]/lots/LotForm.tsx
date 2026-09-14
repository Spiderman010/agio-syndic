import { getTranslations } from "next-intl/server";
import ActionForm from "@/components/ActionForm";
import Field from "@/components/ui/Field";
import SubmitButton from "@/components/SubmitButton";
import type { UnitRow } from "@/lib/ownership";

/**
 * Formulier voor het aanmaken én bewerken van een lot.
 *
 * `building_id` gaat als verborgen veld mee en wordt server-side tegen de
 * organisatie gecontroleerd; bij bewerken wordt bovendien afgedwongen dat het
 * lot bij DIT gebouw hoort. Een lot naar een ander gebouw verplaatsen is
 * onmogelijk — de database blokkeert dat met `fn_guard_unit_building_immutable`
 * — en het formulier biedt het daarom niet aan.
 *
 * Typelabels komen uit de BESTAANDE `buildings.unitTypes`-sleutels.
 */
export default async function LotForm({
  action,
  buildingId,
  submitLabel,
  lot,
}: {
  action: (formData: FormData) => Promise<{ error?: string } | void>;
  buildingId: string;
  submitLabel: string;
  lot?: UnitRow;
}) {
  const t = await getTranslations("lots.form");
  const tt = await getTranslations("buildings.unitTypes");
  const prefix = lot ? `lot-edit-${lot.id}` : "lot-new";

  return (
    <ActionForm action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="building_id" value={buildingId} />
      {lot ? <input type="hidden" name="unit_id" value={lot.id} /> : null}

      <Field id={`${prefix}-label`} label={t("label")} required>
        <input
          id={`${prefix}-label`}
          name="label"
          type="text"
          required
          maxLength={80}
          defaultValue={lot?.label ?? ""}
          className="input w-full"
        />
      </Field>

      <Field id={`${prefix}-type`} label={t("type")}>
        <select
          id={`${prefix}-type`}
          name="unit_type"
          defaultValue={lot?.unit_type ?? "appartement"}
          className="input w-full"
        >
          <option value="appartement">{tt("appartement")}</option>
          <option value="commerce">{tt("commerce")}</option>
          <option value="parking">{tt("parking")}</option>
          <option value="cave">{tt("cave")}</option>
          <option value="autre">{tt("autre")}</option>
        </select>
      </Field>

      <Field id={`${prefix}-floor`} label={t("floor")}>
        <input
          id={`${prefix}-floor`}
          name="floor"
          type="text"
          maxLength={40}
          defaultValue={lot?.floor ?? ""}
          className="input w-full"
        />
      </Field>

      <Field id={`${prefix}-area`} label={t("area")}>
        <input
          id={`${prefix}-area`}
          name="area_m2"
          type="number"
          min="0"
          step="0.01"
          defaultValue={lot?.area_m2 == null ? "" : String(lot.area_m2)}
          className="input w-full"
        />
      </Field>

      <Field
        id={`${prefix}-tantiemes`}
        label={t("tantiemes")}
        hint={t("tantiemesHint")}
        required
      >
        <input
          id={`${prefix}-tantiemes`}
          name="tantiemes"
          type="number"
          min="0"
          step="1"
          required
          defaultValue={lot?.tantiemes ?? 0}
          className="input w-full"
        />
      </Field>

      <div className="flex items-end sm:col-span-2">
        <SubmitButton label={submitLabel} />
      </div>
    </ActionForm>
  );
}

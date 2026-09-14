import { getTranslations } from "next-intl/server";
import ActionForm from "@/components/ActionForm";
import Field from "@/components/ui/Field";
import SubmitButton from "@/components/SubmitButton";
import type { OwnerRow, OwnershipRow } from "@/lib/ownership";
import { linkFirstOwner, transferOwnership } from "./actions";

/**
 * Formulieren voor de twee toegestane eigendomsmutaties.
 *
 * Er is bewust geen derde formulier. Mede-eigendom beheren, een gesloten
 * historie heractiveren en een toekomstige overdracht plannen vallen alle drie
 * buiten deze sprint, maar om VERSCHILLENDE redenen — en die mogen niet op één
 * hoop:
 *
 *   heractiveren, geplande overdracht  de database weigert ze werkelijk
 *                                      (OWNERSHIP_HISTORY_EXISTS, OWNERSHIP_DATE_FUTURE);
 *   mede-eigendom beheren              alleen `transfer_ownership` weigert
 *                                      (OWNERSHIP_COOWNED). Een lastenoproep op
 *                                      zo'n lot slaagt gewoon, zolang er precies
 *                                      één aangewezen debiteur is.
 *
 * Deze formulieren worden daarom niet getoond bij gedeelde eigendom, maar het
 * scherm noemt dat een grens van DEZE flow — geen financieel probleem.
 */

/** Eerste koppeling: alleen zichtbaar op een lot zonder enige historie. */
export async function LinkFirstOwnerForm({
  buildingId,
  unitId,
  owners,
  today,
}: {
  buildingId: string;
  unitId: string;
  owners: readonly OwnerRow[];
  today: string;
}) {
  const t = await getTranslations("lots.link");
  const id = `link-${unitId}`;

  return (
    <ActionForm action={linkFirstOwner} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="building_id" value={buildingId} />
      <input type="hidden" name="unit_id" value={unitId} />

      <Field id={`${id}-owner`} label={t("owner")} required>
        <select id={`${id}-owner`} name="owner_id" required className="input w-full">
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.full_name}
            </option>
          ))}
        </select>
      </Field>

      <Field id={`${id}-date`} label={t("startDate")} hint={t("dateHint")} required>
        <input
          id={`${id}-date`}
          name="start_date"
          type="date"
          required
          max={today}
          defaultValue={today}
          className="input w-full"
        />
      </Field>

      <div className="sm:col-span-2">
        <SubmitButton label={t("submit")} pendingLabel={t("pending")} />
      </div>
    </ActionForm>
  );
}

/**
 * Overdracht.
 *
 * De pagina toont vóór het verzenden wie de huidige eigenaar is, sinds wanneer,
 * en dat historische lasten en betalingen NIET meeverhuizen. `expected_ownership_id`
 * is de rij die de gebruiker op dit moment ziet; wijkt die af op het moment van
 * uitvoeren, dan weigert de database met OWNERSHIP_STALE.
 */
export async function TransferOwnershipForm({
  buildingId,
  unitId,
  current,
  currentOwnerName,
  owners,
  minDate,
  maxDate,
  defaultDate,
  periodLabel,
}: {
  buildingId: string;
  unitId: string;
  current: OwnershipRow;
  currentOwnerName: string;
  owners: readonly OwnerRow[];
  /**
   * Het venster komt uit `transferability()` en spiegelt de RPC:
   * `start_date + 1` tot en met vandaag. Zonder ondergrens bood het formulier
   * datums aan waarvoor `transfer_ownership` gegarandeerd
   * OWNERSHIP_DATE_NOT_AFTER_START geeft.
   */
  minDate: string;
  maxDate: string;
  defaultDate: string;
  periodLabel: string;
}) {
  const t = await getTranslations("lots.transfer");
  const id = `transfer-${unitId}`;
  const kandidaten = owners.filter((o) => o.id !== current.owner_id);

  if (kandidaten.length === 0) {
    return (
      <p className="m-0 text-[0.8rem] text-ink-soft" role="status">
        {t("noCandidates")}
      </p>
    );
  }

  return (
    <ActionForm action={transferOwnership} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="building_id" value={buildingId} />
      <input type="hidden" name="unit_id" value={unitId} />
      <input type="hidden" name="expected_ownership_id" value={current.id} />

      <dl className="m-0 grid gap-1 text-[0.8rem] sm:col-span-2">
        <div className="flex flex-wrap gap-2">
          <dt className="text-ink-soft">{t("currentOwner")}</dt>
          <dd className="m-0 font-medium">{currentOwnerName}</dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="text-ink-soft">{t("currentPeriod")}</dt>
          <dd className="m-0">{periodLabel}</dd>
        </div>
      </dl>

      <Field id={`${id}-owner`} label={t("newOwner")} required>
        <select id={`${id}-owner`} name="new_owner_id" required className="input w-full">
          {kandidaten.map((o) => (
            <option key={o.id} value={o.id}>
              {o.full_name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        id={`${id}-date`}
        label={t("date")}
        hint={t("dateRange", { min: minDate, max: maxDate })}
        required
      >
        <input
          id={`${id}-date`}
          name="transfer_date"
          type="date"
          required
          min={minDate}
          max={maxDate}
          defaultValue={defaultDate}
          className="input w-full"
        />
      </Field>

      <p className="m-0 text-[0.8rem] text-ink-soft sm:col-span-2">{t("notice")}</p>

      <label className="flex items-start gap-2 text-[0.8rem] sm:col-span-2">
        <input type="checkbox" name="confirm" required className="mt-0.5 size-4" />
        <span>{t("confirm")}</span>
      </label>

      <div className="sm:col-span-2">
        <SubmitButton label={t("submit")} pendingLabel={t("pending")} variant="danger" />
      </div>
    </ActionForm>
  );
}

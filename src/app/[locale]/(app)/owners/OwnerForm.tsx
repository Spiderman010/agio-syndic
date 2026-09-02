import { getTranslations } from "next-intl/server";
import ActionForm from "@/components/ActionForm";
import Field from "@/components/ui/Field";
import SubmitButton from "@/components/SubmitButton";
import type { OwnerRow } from "@/lib/ownership";

/**
 * Formulier voor het aanmaken én bewerken van een eigenaar.
 *
 * Eén component voor beide gevallen, zodat de velden niet uiteen kunnen lopen.
 * Bij bewerken gaat `owner_id` mee als verborgen veld; de server vertrouwt dat
 * veld niet en controleert het tegen de actieve organisatie.
 *
 * Dit is een servercomponent: de labels komen uit next-intl en de interactieve
 * schil (pending-toestand, foutmelding als toast) zit in `ActionForm` en
 * `SubmitButton`. Zo staat er geen enkele gebruikerszin in clientcode.
 *
 * Taalopties komen uit de BESTAANDE `buildings.langs`-sleutels; een tweede
 * vertaling van dezelfde vier talen zou alleen maar uit de pas kunnen lopen.
 */
export default async function OwnerForm({
  action,
  submitLabel,
  owner,
}: {
  action: (formData: FormData) => Promise<{ error?: string } | void>;
  submitLabel: string;
  owner?: OwnerRow;
}) {
  const t = await getTranslations("owners.create");
  const tl = await getTranslations("buildings.langs");
  const prefix = owner ? `owner-edit-${owner.id}` : "owner-new";

  return (
    <ActionForm action={action} className="grid gap-3 sm:grid-cols-2">
      {owner ? <input type="hidden" name="owner_id" value={owner.id} /> : null}

      <Field id={`${prefix}-full_name`} label={t("fullName")} required className="sm:col-span-2">
        <input
          id={`${prefix}-full_name`}
          name="full_name"
          type="text"
          required
          maxLength={200}
          defaultValue={owner?.full_name ?? ""}
          className="input w-full"
        />
      </Field>

      <Field id={`${prefix}-email`} label={t("email")}>
        <input
          id={`${prefix}-email`}
          name="email"
          type="email"
          maxLength={200}
          defaultValue={owner?.email ?? ""}
          className="input w-full"
        />
      </Field>

      <Field id={`${prefix}-phone`} label={t("phone")}>
        <input
          id={`${prefix}-phone`}
          name="phone"
          type="tel"
          maxLength={40}
          defaultValue={owner?.phone ?? ""}
          className="input w-full"
        />
      </Field>

      <Field id={`${prefix}-language`} label={t("language")} hint={t("languageHint")}>
        <select
          id={`${prefix}-language`}
          name="language"
          defaultValue={owner?.language ?? "fr"}
          className="input w-full"
        >
          <option value="fr">{tl("fr")}</option>
          <option value="ar">{tl("ar")}</option>
          <option value="nl">{tl("nl")}</option>
          <option value="en">{tl("en")}</option>
        </select>
      </Field>

      <div className="flex flex-col justify-end gap-2 pb-1">
        <label className="flex items-center gap-2 text-[0.875rem]">
          <input
            type="checkbox"
            name="is_company"
            defaultChecked={owner?.is_company ?? false}
            className="size-4"
          />
          {t("isCompany")}
        </label>
        <label className="flex items-center gap-2 text-[0.875rem]">
          <input
            type="checkbox"
            name="is_mre"
            defaultChecked={owner?.is_mre ?? false}
            className="size-4"
          />
          {t("isMre")}
        </label>
      </div>

      <div className="sm:col-span-2">
        <SubmitButton label={submitLabel} />
      </div>
    </ActionForm>
  );
}

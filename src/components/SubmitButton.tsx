"use client";

import { useFormStatus } from "react-dom";
import { buttonClasses, type ButtonVariant } from "@/components/ui/Button";

/**
 * Verzendknop met een zichtbare pending-toestand.
 *
 * `useFormStatus` leest de status van het OMLIGGENDE formulier; deze component
 * moet daarom een kind van dat `<form>` zijn en niet het formulier zelf
 * renderen. Zonder deze knop is een trage server action onzichtbaar en klikt een
 * gebruiker hem een tweede keer — bij een eigendomsoverdracht is dat precies de
 * dubbele mutatie die `p_expected_current_ownership_id` moet opvangen.
 *
 * De labels komen als props binnen, vertaald door de servercomponent. Zo staat
 * er geen enkele gebruikerszin in clientcode.
 *
 * `aria-disabled` in plaats van `disabled`: een uitgeschakelde knop verdwijnt
 * uit de tabvolgorde en verliest zijn toegankelijke naam op het moment dat de
 * gebruiker juist wil weten wat er gebeurt. `aria-busy` en de statusregel
 * melden de voortgang aan een schermlezer.
 */
export default function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
}: {
  label: string;
  /** Tekst tijdens het verzenden; valt terug op `label`. */
  pendingLabel?: string;
  variant?: ButtonVariant;
}) {
  const { pending } = useFormStatus();
  const tekst = pending ? (pendingLabel ?? label) : label;

  return (
    <>
      <button
        type="submit"
        aria-disabled={pending}
        aria-busy={pending}
        className={buttonClasses(variant, "md", pending ? "opacity-60" : undefined)}
        onClick={(event) => {
          // Een tweede klik tijdens het verzenden mag geen tweede mutatie
          // opleveren; de knop blijft wel focusbaar en voorleesbaar.
          if (pending) event.preventDefault();
        }}
      >
        {tekst}
      </button>
      <span aria-live="polite" className="sr-only">
        {pending ? (pendingLabel ?? label) : ""}
      </span>
    </>
  );
}

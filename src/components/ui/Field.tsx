import { cloneElement, isValidElement } from "react";
import { cn } from "@/lib/utils";

/**
 * Formulierveld: label, controle, toelichting en fout.
 *
 * De combinatie label + input wordt op dit moment 51 keer letterlijk herhaald
 * in de app. Deze wrapper maakt er één ding van en regelt meteen de
 * toegankelijkheid die in die herhalingen ontbrak: `aria-describedby` naar
 * toelichting én fout, en een fout met `role="alert"` zodat een schermlezer
 * hem aankondigt in plaats van hem stil te laten verschijnen.
 *
 * De controle wordt als children doorgegeven in plaats van gerenderd, zodat
 * hetzelfde veld werkt voor input, select en textarea zonder dat deze
 * component elk attribuut van alle drie hoeft door te geven. De koppeling
 * `aria-describedby`/`aria-invalid` wordt hier op de controle gezet, zodat de
 * aanroeper daar niet aan hoeft te denken.
 */

type AriaProps = {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

export default function Field({
  id,
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: {
  /** Moet gelijk zijn aan het id van de controle in `children`. */
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const control = isValidElement<AriaProps>(children)
    ? cloneElement(children, {
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })
    : children;

  return (
    <div className={cn("min-w-0", className)}>
      <label className="label" htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-crit">
            {" *"}
          </span>
        ) : null}
      </label>

      {control}

      {hint ? (
        <p id={hintId} className="mt-1 text-[0.75rem] text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1 text-[0.75rem] font-medium text-crit"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

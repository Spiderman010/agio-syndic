"use client";

import { useActionState, useEffect, useId, useRef } from "react";

/**
 * Bevestigingsdialoog voor een storno of correctie.
 *
 * WAAROM GEEN confirm()
 * `window.confirm()` toont geen bedrag, geen eigenaar en geen waarschuwing over
 * het boekjaar, en kan geen verplichte reden afdwingen — terwijl de database die
 * reden hoe dan ook eist (CHECK 10–500 tekens). Een gebruiker die op "OK" klikt
 * zou dan alsnog een foutmelding krijgen. Deze dialoog toont de feiten en vraagt
 * de reden vóórdat er iets naar de server gaat.
 *
 * WAAROM HET NATIVE <dialog>-ELEMENT
 * Er staat geen shadcn/dialog in dit project — `components/ui` bevat alleen
 * sonner. Het platform-element geeft focus-trapping, Escape-om-te-sluiten en een
 * backdrop zonder een nieuwe afhankelijkheid of een eigen modal-abstractie.
 *
 * IDEMPOTENTIE
 * `useActionState` levert `isPending`; zolang die waar is zijn beide knoppen
 * uitgeschakeld, dus dubbel indienen kan niet vanuit deze UI. Zou het tóch
 * gebeuren — twee tabbladen, een herhaalde POST — dan weigert de database met
 * ALREADY_REVERSED en ziet de gebruiker een nette melding. Er wordt niets
 * optimistisch bijgewerkt: de pagina toont pas een nieuwe stand nadat de server
 * heeft bevestigd en `revalidatePath` de gegevens opnieuw heeft opgehaald.
 *
 * WAAROM DE FOUT IN DE DIALOOG STAAT EN NIET IN EEN TOAST
 * Een met `showModal()` geopende `<dialog>` staat in de TOP LAYER van de
 * browser. Die ligt per definitie boven elk normaal stapelcontext, ongeacht
 * z-index. Een sonner-toast is een gewoon `position: fixed`-element en zou dus
 * ACHTER de dialoog en zijn backdrop worden getekend: de gebruiker zou een
 * mislukte storno als een stille no-op ervaren. De melding staat daarom in de
 * dialoog zelf, met aria-live zodat een schermlezer hem ook krijgt.
 */

type ActionResult = { error?: string } | void | undefined;
type ServerAction = (formData: FormData) => Promise<ActionResult>;
type State = { error?: string; done: boolean; seq: number } | null;

export default function ReversalDialog({
  action,
  triggerLabel,
  triggerClassName = "btn",
  title,
  intro,
  warning,
  summary,
  fields,
  hidden,
  reasonLabel,
  reasonHint,
  reasonPlaceholder,
  confirmLabel,
  cancelLabel,
  pendingLabel,
  danger = false,
}: {
  action: ServerAction;
  triggerLabel: string;
  triggerClassName?: string;
  title: string;
  intro: string;
  /** Extra waarschuwing, bv. bij een afgesloten boekjaar. */
  warning?: string;
  /** Onbewerkbare feiten over de originele transactie. */
  summary?: React.ReactNode;
  /** Bewerkbare velden; alleen bij een correctie. */
  fields?: React.ReactNode;
  hidden: Record<string, string>;
  reasonLabel: string;
  reasonHint: string;
  reasonPlaceholder: string;
  confirmLabel: string;
  cancelLabel: string;
  pendingLabel: string;
  danger?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Elke rij rendert twee dialogen (corrigeren en storneren); zonder een unieke
  // id zouden alle motief-velden op de pagina dezelfde DOM-id dragen en zou
  // elk label naar het eerste veld wijzen.
  const reasonId = useId();

  const [state, formAction, isPending] = useActionState<State, FormData>(
    async (prev, formData) => {
      const result = (await action(formData)) ?? {};
      return {
        error: "error" in result ? result.error : undefined,
        done: true,
        seq: (prev?.seq ?? 0) + 1,
      };
    },
    null,
  );

  useEffect(() => {
    // Alleen bij succes sluiten. Bij een fout blijft de dialoog open zodat de
    // melding zichtbaar is en de gebruiker kan corrigeren.
    if (state?.done && !state.error) dialogRef.current?.close();
  }, [state]);

  return (
    <>
      <button
        type="button"
        className={triggerClassName}
        onClick={() => dialogRef.current?.showModal()}
      >
        {triggerLabel}
      </button>

      <dialog ref={dialogRef} className="reversal-dialog">
        <form action={formAction} method="dialog">
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}

          <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem" }}>{title}</h2>
          <p className="muted" style={{ margin: "0 0 0.9rem", fontSize: "0.83rem", lineHeight: 1.5 }}>
            {intro}
          </p>

          {warning && (
            <div
              className="badge badge-telaat"
              style={{
                display: "block",
                padding: "0.55rem 0.7rem",
                borderRadius: 8,
                marginBottom: "0.9rem",
                lineHeight: 1.45,
                whiteSpace: "normal",
              }}
            >
              {warning}
            </div>
          )}

          {summary && (
            <div
              className="card"
              style={{ padding: "0.6rem 0.75rem", marginBottom: "0.9rem", fontSize: "0.82rem" }}
            >
              {summary}
            </div>
          )}

          {fields}

          <div style={{ marginTop: "0.6rem" }}>
            <label className="label" htmlFor={reasonId}>
              {reasonLabel}
            </label>
            <textarea
              id={reasonId}
              className="input"
              name="reason"
              rows={3}
              minLength={10}
              maxLength={500}
              required
              placeholder={reasonPlaceholder}
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
            <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.2rem" }}>
              {reasonHint}
            </div>
          </div>

          {state?.error && (
            <div
              role="alert"
              aria-live="assertive"
              className="badge badge-telaat"
              style={{
                display: "block",
                padding: "0.55rem 0.7rem",
                borderRadius: 8,
                marginTop: "0.9rem",
                lineHeight: 1.45,
                whiteSpace: "normal",
              }}
            >
              {state.error}
            </div>
          )}

          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1.1rem" }}>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={() => dialogRef.current?.close()}
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              className={danger ? "btn btn-danger" : "btn btn-primary"}
              disabled={isPending}
            >
              {isPending ? pendingLabel : confirmLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

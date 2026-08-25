"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";

/**
 * Formulier-wrapper voor server actions die `{ error }` kunnen teruggeven.
 *
 * Twee problemen die dit oplost:
 *
 * 1. Een server action die een waarde retourneert is niet toewijsbaar aan het
 *    `action`-attribuut van `<form>`: React typeert dat als
 *    `(formData: FormData) => void | Promise<void>`. Een rechtstreekse
 *    `<form action={createUnit}>` levert daardoor TS2322 op en breekt
 *    `next build`.
 *
 * 2. Belangrijker: een kaal `<form action={fn}>` gooit de retourwaarde weg.
 *    Elke `{ error }` uit de Zod-validatie, de tenant-guards en de
 *    bonupload-controle verdween daarmee stilzwijgend — precies het gedrag dat
 *    P1-7 moest uitbannen.
 *
 * useActionState vangt de retourwaarde op en toont hem als toast.
 */

type ActionResult = { error?: string } | void | undefined;
type ServerAction = (formData: FormData) => Promise<ActionResult>;
type State = { error?: string } | null;

export default function ActionForm({
  action,
  children,
  className,
  style,
  id,
}: {
  action: ServerAction;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
}) {
  const [state, formAction] = useActionState<State, FormData>(
    async (_prev, formData) => ((await action(formData)) ?? null) as State,
    null,
  );

  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);

  return (
    <form action={formAction} className={className} style={style} id={id}>
      {children}
    </form>
  );
}

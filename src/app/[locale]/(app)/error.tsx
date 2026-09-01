"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";

/**
 * Foutgrens voor alle schermen binnen de schil.
 *
 * Twee harde regels:
 *
 *  1. GEEN databasedetails naar de gebruiker. `error.message` kan een
 *     PostgreSQL-constraintfout, een tabelnaam of een RLS-melding bevatten. De
 *     gebruiker krijgt een vaste, vertaalde tekst; alleen de `digest` — een
 *     hash zonder inhoud — is zichtbaar zodat een melding herleidbaar blijft.
 *  2. Altijd een uitweg. `reset()` probeert hetzelfde segment opnieuw te
 *     renderen, wat bij een tijdelijke netwerkfout gewoon werkt.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("shell.error");

  useEffect(() => {
    // De volledige fout hoort in de serverlogs, niet op het scherm.
    console.error("[app-shell] onverwachte fout", error);
  }, [error]);

  return (
    <Card className="mx-auto max-w-xl text-center">
      <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-crit-soft">
        <AlertTriangle className="size-5 text-crit" aria-hidden="true" />
      </div>
      <h1 className="mt-0 mb-1.5 text-lg font-semibold text-ink">{t("title")}</h1>
      <p className="mx-auto mb-4 max-w-prose text-[0.9rem] text-ink-soft">
        {t("body")}
      </p>
      <Button variant="primary" onClick={reset}>
        {t("retry")}
      </Button>
      {error.digest ? (
        <p className="mt-3 mb-0 font-mono text-[0.72rem] text-ink-soft">
          {t("reference")}: {error.digest}
        </p>
      ) : null}
    </Card>
  );
}

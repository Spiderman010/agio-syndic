"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { getReceiptUrl } from "@/app/[locale]/(app)/buildings/[id]/expenses/actions";

/**
 * P0-3: opent een bewijsstuk via een kortlevende, server-side gegenereerde
 * signed URL (60 s). Er staat geen langlevende link in de database of in de
 * HTML-broncode van de pagina.
 */
export default function ReceiptLink({
  expenseId,
  label,
}: {
  expenseId: string;
  label: string;
}) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  function open() {
    // Het tabblad wordt SYNCHROON binnen de klik geopend. Zou window.open()
    // pas ná de await volgen, dan telt het niet meer als gebruikersgebaar en
    // blokkeert de browser de pop-up.
    const tab = window.open("about:blank", "_blank");
    if (tab) {
      try {
        tab.opener = null;
      } catch {
        // Sommige browsers staan dit niet toe; niet fataal.
      }
    }

    setBusy(true);
    startTransition(async () => {
      const result = await getReceiptUrl(expenseId);
      setBusy(false);

      if (result.error || !result.url) {
        tab?.close();
        toast.error(result.error ?? "Het bewijsstuk kon niet worden geopend.");
        return;
      }

      if (tab) {
        tab.location.replace(result.url);
      } else {
        // Pop-up geblokkeerd: navigeer dan in het huidige tabblad.
        window.location.href = result.url;
      }
    });
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={pending || busy}
      className="btn"
      style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
    >
      {pending || busy ? "…" : `📎 ${label}`}
    </button>
  );
}

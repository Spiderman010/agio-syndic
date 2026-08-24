"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { getReceiptUrl } from "@/app/[locale]/buildings/[id]/expenses/actions";

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
    setBusy(true);
    startTransition(async () => {
      const result = await getReceiptUrl(expenseId);
      setBusy(false);
      if (result.error || !result.url) {
        toast.error(result.error ?? "Het bewijsstuk kon niet worden geopend.");
        return;
      }
      window.open(result.url, "_blank", "noopener,noreferrer");
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

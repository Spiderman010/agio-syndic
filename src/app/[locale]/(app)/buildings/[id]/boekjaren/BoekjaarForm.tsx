"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createFiscalYear } from "./actions";

type ActionState = { error?: string } | null;

export default function BoekjaarForm({
  buildingId,
  existingYears,
  huidigJaar,
}: {
  buildingId: string;
  existingYears: number[];
  huidigJaar: number;
}) {
  const t = useTranslations("boekjaren");
  const [jaar, setJaar] = useState(huidigJaar);
  const jaarAlBestaat = existingYears.includes(jaar);

  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    async (_prev, fd) => createFiscalYear(fd) as Promise<ActionState>,
    null,
  );

  useEffect(() => {
    if (!state?.error) return;
    if (state.error.startsWith("__duplicate_year__")) {
      const yr = state.error.replace("__duplicate_year__", "");
      toast.error(t("yearExists", { year: yr }));
    } else {
      toast.error(state.error);
    }
  }, [state, t]);

  const jaarStr = isNaN(jaar) ? String(huidigJaar) : String(jaar);

  return (
    <form action={formAction} className="card mt-5 px-4 py-5 sm:px-6">
      <input type="hidden" name="building_id" value={buildingId} />
      <h2 className="m-0 mb-4 text-base font-semibold">{t("newBoekjaar")}</h2>

      {/* Eén kolom op mobiel, pas vanaf `sm` drie. Wat hier telt is de nul in
          Tailwinds `grid-cols-3` (`repeat(3, minmax(0,1fr))`): het kale
          `1fr` van hiervoor gaf elke track de MIN-CONTENT-breedte van een
          datumveld als ondergrens, en drie van die ondergrenzen samen zijn
          breder dan 360px — daar kwam de horizontale overflow vandaan.
          `min-w-0` per veld houdt diezelfde regel binnen de kolom staan. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <label className="label" htmlFor="year">{t("year")}</label>
          <input
            className="input"
            id="year"
            name="year"
            type="number"
            min={2000}
            max={2100}
            value={jaar}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setJaar(isNaN(v) ? huidigJaar : v);
            }}
            required
          />
          {jaarAlBestaat && (
            <div style={{ color: "var(--crit)", fontSize: "0.76rem", marginTop: 3 }}>
              {t("yearExists", { year: jaarStr })}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <label className="label" htmlFor="start_date">{t("startDate")}</label>
          <input
            key={`start-${jaarStr}`}
            className="input"
            id="start_date"
            name="start_date"
            type="date"
            defaultValue={`${jaarStr}-01-01`}
            required
          />
        </div>
        <div className="min-w-0">
          <label className="label" htmlFor="end_date">{t("endDate")}</label>
          <input
            key={`end-${jaarStr}`}
            className="input"
            id="end_date"
            name="end_date"
            type="date"
            defaultValue={`${jaarStr}-12-31`}
            required
          />
        </div>
      </div>

      <button
        className="btn btn-primary mt-4"
        disabled={pending || jaarAlBestaat}
      >
        {pending ? "…" : t("createBtn")}
      </button>
    </form>
  );
}

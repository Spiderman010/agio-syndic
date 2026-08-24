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
    <form action={formAction} className="card" style={{ padding: "1.2rem 1.4rem", marginTop: "1.2rem" }}>
      <input type="hidden" name="building_id" value={buildingId} />
      <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>{t("newBoekjaar")}</h2>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.8rem" }}>
        <div>
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
        <div>
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
        <div>
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
        className="btn btn-primary"
        style={{ marginTop: "1rem" }}
        disabled={pending || jaarAlBestaat}
      >
        {pending ? "…" : t("createBtn")}
      </button>
    </form>
  );
}

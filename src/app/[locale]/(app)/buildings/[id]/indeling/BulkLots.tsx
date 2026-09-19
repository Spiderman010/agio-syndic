"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import ActionForm from "@/components/ActionForm";
import SubmitButton from "@/components/SubmitButton";
import Card, { CardHeader } from "@/components/ui/Card";

import { createLotsBulk } from "./actions";

/**
 * Meerdere lots in één keer aanmaken.
 *
 * ── WAAROM DIT HET ENIGE CLIENT-COMPONENT IS ───────────────────────────────
 *
 * Rijen toevoegen en verwijderen en een meelopend tantièmetotaal vragen state.
 * De rest van dit scherm blijft server-side; hier is het onvermijdelijk.
 *
 * ── ALLES OF NIETS ─────────────────────────────────────────────────────────
 *
 * De actie stuurt alle rijen in ÉÉN insert. Eén schending — een dubbel label,
 * een ongeldig tantième — laat de hele set mislukken. Dat is opzet: een halve
 * invoer waarvan de gebruiker niet weet welke helft is geland, is erger dan
 * geen invoer.
 *
 * ── HET TOTAAL IS EEN WAARSCHUWING, GEEN SLOT ──────────────────────────────
 *
 * De som van bestaande plus nieuwe tantièmes wordt tegen
 * `buildings.total_tantiemes` gelegd. Niet sluiten is géén reden om te
 * blokkeren: tijdens het inrichten van een gebouw klopt het totaal per definitie
 * pas aan het eind. Het scherm zegt het, en laat de beslissing bij de beheerder.
 */

type Rij = { label: string; unitType: string; tantiemes: string };

const LEGE_RIJ: Rij = { label: "", unitType: "appartement", tantiemes: "0" };
const TYPES = ["appartement", "commerce", "parking", "cave", "autre"] as const;

export default function BulkLots({
  buildingId,
  blokken,
  totalTantiemes,
  reedsToegekend,
}: {
  buildingId: string;
  blokken: readonly { id: string; code: string; name: string | null }[];
  totalTantiemes: number;
  reedsToegekend: number;
}) {
  const t = useTranslations("indeling.manage");
  const tt = useTranslations("buildings.unitTypes");
  const [rijen, setRijen] = useState<Rij[]>([{ ...LEGE_RIJ }, { ...LEGE_RIJ }, { ...LEGE_RIJ }]);

  const wijzig = (i: number, veld: keyof Rij, waarde: string) =>
    setRijen((huidig) => huidig.map((r, j) => (j === i ? { ...r, [veld]: waarde } : r)));

  const nieuwTotaal = rijen.reduce((som, r) => {
    const n = Number.parseInt(r.tantiemes, 10);
    return som + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  const straksToegekend = reedsToegekend + nieuwTotaal;
  const sluit = straksToegekend === totalTantiemes;

  return (
    <Card>
      <CardHeader title={<span id="bulk-kop">{t("bulkTitle")}</span>} />
      <p className="mt-0 mb-3 text-[0.8rem] text-ink-soft">{t("bulkHint")}</p>

      <ActionForm action={createLotsBulk}>
        <input type="hidden" name="building_id" value={buildingId} />
        <input type="hidden" name="rows" value={rijen.length} />

        <div className="mb-3 max-w-sm">
          <label className="label" htmlFor="bulk-blok">
            {t("block")}
          </label>
          <select id="bulk-blok" name="block_id" className="input w-full" defaultValue="">
            <option value="">{t("noBlock")}</option>
            {blokken.map((blok) => (
              <option key={blok.id} value={blok.id}>
                {blok.name ? `${blok.code} — ${blok.name}` : blok.code}
              </option>
            ))}
          </select>
        </div>

        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rijen.map((rij, i) => (
            <li key={i} className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
              <div className="min-w-0">
                <label className="label" htmlFor={`bulk-label-${i}`}>
                  {t("label")}
                </label>
                <input
                  id={`bulk-label-${i}`}
                  name={`label_${i}`}
                  type="text"
                  maxLength={80}
                  value={rij.label}
                  onChange={(e) => wijzig(i, "label", e.target.value)}
                  className="input w-full"
                />
              </div>

              <div className="min-w-0">
                <label className="label" htmlFor={`bulk-type-${i}`}>
                  {t("type")}
                </label>
                <select
                  id={`bulk-type-${i}`}
                  name={`unit_type_${i}`}
                  value={rij.unitType}
                  onChange={(e) => wijzig(i, "unitType", e.target.value)}
                  className="input w-full"
                >
                  {TYPES.map((type) => (
                    <option key={type} value={type}>
                      {tt(type)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0">
                <label className="label" htmlFor={`bulk-tantiemes-${i}`}>
                  {t("tantiemes")}
                </label>
                <input
                  id={`bulk-tantiemes-${i}`}
                  name={`tantiemes_${i}`}
                  type="number"
                  min="0"
                  step="1"
                  value={rij.tantiemes}
                  onChange={(e) => wijzig(i, "tantiemes", e.target.value)}
                  className="input w-full"
                />
              </div>

              <div className="flex items-end">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setRijen((h) => h.filter((_, j) => j !== i))}
                  disabled={rijen.length === 1}
                  aria-label={t("removeRow", { nummer: i + 1 })}
                >
                  {t("remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => setRijen((h) => [...h, { ...LEGE_RIJ }])}
            disabled={rijen.length >= 200}
          >
            {t("addRow")}
          </button>
          <SubmitButton label={t("createLots")} pendingLabel={t("pending")} />
        </div>

        <p
          className={`mt-3 mb-0 text-[0.8rem] ${sluit ? "text-ink-soft" : "text-warn"}`}
          role="status"
          data-testid="bulk-totaal"
        >
          {t("bulkTotal", {
            nieuw: nieuwTotaal,
            straks: straksToegekend,
            verklaard: totalTantiemes,
          })}
          {sluit ? "" : ` — ${t("bulkTotalMismatch")}`}
        </p>
      </ActionForm>
    </Card>
  );
}

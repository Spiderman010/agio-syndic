"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useFormStatus } from "react-dom";
import { Link } from "@/navigation";
import ActionForm from "@/components/ActionForm";
import Field from "@/components/ui/Field";
import Card from "@/components/ui/Card";
import { buttonClasses } from "@/components/ui/Button";
import {
  chargeCallReadiness,
  blockerKey,
  type AllocationRuleRow,
  type ChargeUnitRow,
  type ReadinessBlocker,
  type RuleUnitRow,
  type RuleWeightRow,
} from "@/lib/charges";
import type { OwnershipRow } from "@/lib/ownership";
import { createChargeCall } from "../actions";

/**
 * De lastenoproepworkflow: invoeren -> controleren -> definitief aanmaken.
 *
 * ── WAAROM DE CONTROLE IN DE CLIENT DRAAIT ─────────────────────────────────
 *
 * De controle is een PURE functie over rijen die de server al heeft opgehaald
 * en meegegeven. Ze mag daarom zo vaak draaien als de gebruiker een datum of
 * een regel wijzigt, zonder extra ronde naar de server. De rijen zelf komen
 * door RLS heen en bevatten niets wat deze gebruiker niet al mag zien.
 *
 * ── WAT HIER NIET GEBEURT ──────────────────────────────────────────────────
 *
 * Geen enkele berekening van bedragen per lot. De controle telt lots en
 * tantièmes voor de controlewaarde, en beoordeelt eigendom op de oproepdatum.
 * De verdeling zelf — welk lot welk bedrag krijgt, inclusief de restcenten —
 * bestaat uitsluitend in `create_charge_call`. Wat na afloop wordt getoond
 * komt uit `charge_allocations`, dus uit de database.
 *
 * ── DRIE ZICHTBARE STAPPEN ─────────────────────────────────────────────────
 *
 * De knop die geld vastlegt staat bewust achter twee handelingen: eerst de
 * controle uitvoeren, dan expliciet bevestigen. Wijzigt de gebruiker daarna
 * nog iets, dan vervalt zowel de controle als de bevestiging — een uitkomst
 * die bij andere invoer hoorde mag geen toestemming blijven geven.
 */

type Props = {
  buildingId: string;
  fiscalYearId: string;
  fiscalYear: { year: number; status: "open" | "closed" };
  declaredTantiemes: number | string | null;
  rules: readonly AllocationRuleRow[];
  units: readonly ChargeUnitRow[];
  ruleUnits: readonly RuleUnitRow[];
  ruleWeights: readonly RuleWeightRow[];
  ownership: readonly OwnershipRow[];
  /** Vandaag in ISO; standaardwaarde van de oproepdatum. */
  today: string;
};

export default function ChargeCallWorkflow({
  buildingId,
  fiscalYearId,
  fiscalYear,
  declaredTantiemes,
  rules,
  units,
  ruleUnits,
  ruleWeights,
  ownership,
  today,
}: Props) {
  const t = useTranslations("charges");
  const locale = useLocale();

  const standaard = rules.find((r) => r.is_default && r.status === "active") ?? rules[0];
  const [ruleId, setRuleId] = useState<string>(standaard?.id ?? "");
  const [callDate, setCallDate] = useState<string>(today);
  const [dueDate, setDueDate] = useState<string>("");
  const [totalAmount, setTotalAmount] = useState<string>("");
  const [manueel, setManueel] = useState<Record<string, string>>({});
  const [gecontroleerd, setGecontroleerd] = useState(false);
  const [bevestigd, setBevestigd] = useState(false);

  const regel = rules.find((r) => r.id === ruleId) ?? standaard ?? null;

  /**
   * Elke invoerwijziging maakt een eerdere controle ongeldig. Zonder dit zou
   * een groene uitkomst van vóór de wijziging de bevestigingsknop openhouden.
   */
  function invalideer() {
    setGecontroleerd(false);
    setBevestigd(false);
  }

  const uitkomst = useMemo(() => {
    if (!regel) return null;
    return chargeCallReadiness({
      rule: regel,
      buildingId,
      declaredTantiemes,
      fiscalYear,
      callDate,
      units,
      ruleUnits,
      ruleWeights,
      ownership,
      totalAmount,
      dueDate,
      manualAmounts: manueel,
    });
  }, [
    regel,
    buildingId,
    declaredTantiemes,
    fiscalYear,
    callDate,
    units,
    ruleUnits,
    ruleWeights,
    ownership,
    totalAmount,
    dueDate,
    manueel,
  ]);

  const deelnemers = uitkomst?.participants ?? [];
  const handmatig = regel?.method === "manual";
  const magAanmaken = Boolean(gecontroleerd && bevestigd && uitkomst?.clear);

  /*
   * Geen enkele actieve verdeelregel.
   *
   * De serverquery filtert al op `status = 'active'`, dus een lege lijst is
   * geen technische bronfout maar een domeinblokkade: zonder regel kan
   * `create_charge_call` niets verdelen en weigert de database met
   * ALLOC_NO_DEFAULT_RULE. Een lege keuzelijst met een controleknop die niets
   * kan zeggen is dan erger dan geen formulier: de beheerder zou blijven
   * proberen. Vandaar één vertaalde melding en verder niets — geen select,
   * geen controleknop, geen gereedmelding, geen aanmaakknop.
   */
  if (rules.length === 0) {
    return (
      <Card className="mt-4" data-testid="charge-call-workflow">
        <h3 className="mt-0 mb-1 text-[1rem] font-semibold">{t("new")}</h3>
        <p className="m-0 text-[0.85rem]" role="status" data-testid="no-rules">
          {t("noActiveRule")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="mt-4" data-testid="charge-call-workflow">
      <h3 className="mt-0 mb-1 text-[1rem] font-semibold">{t("new")}</h3>
      <ol className="text-ink-soft m-0 mb-4 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.75rem]">
        <li>{t("steps.input")}</li>
        <li>{t("steps.check")}</li>
        <li>{t("steps.create")}</li>
      </ol>

      <ActionForm action={createChargeCall} className="flex flex-col gap-4">
        <input type="hidden" name="building_id" value={buildingId} />
        <input type="hidden" name="fiscal_year_id" value={fiscalYearId} />

        {/* ── 1. invoeren ─────────────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="cc-type" label={t("type")}>
            <select
              id="cc-type"
              name="type"
              defaultValue="regulier"
              className="input w-full"
              onChange={invalideer}
            >
              <option value="regulier">{t("types.regulier")}</option>
              <option value="exceptionnel">{t("types.exceptionnel")}</option>
            </select>
          </Field>

          <Field id="cc-period" label={t("period")}>
            <input
              id="cc-period"
              name="period"
              type="text"
              maxLength={40}
              placeholder={t("periodPlaceholder")}
              className="input w-full"
              onChange={invalideer}
            />
          </Field>

          <Field id="cc-label" label={t("labelField")} className="sm:col-span-2">
            <input
              id="cc-label"
              name="label"
              type="text"
              maxLength={160}
              placeholder={t("labelPlaceholder")}
              className="input w-full"
              onChange={invalideer}
            />
          </Field>

          <Field id="cc-rule" label={t("rule")} className="sm:col-span-2">
            <select
              id="cc-rule"
              name="allocation_rule_id"
              value={ruleId}
              className="input w-full"
              onChange={(e) => {
                setRuleId(e.target.value);
                invalideer();
              }}
            >
              {rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} — {t(`methods.${r.method}`)} / {t(`scopes.${r.scope}`)}
                  {r.is_default ? ` · ${t("ruleDefault")}` : ""}
                  {r.status !== "active" ? ` ${t("ruleInactiveSuffix")}` : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field id="cc-amount" label={t("amount")} required>
            <input
              id="cc-amount"
              name="total_amount"
              type="text"
              inputMode="decimal"
              required
              placeholder="1200.00"
              className="input w-full"
              value={totalAmount}
              onChange={(e) => {
                setTotalAmount(e.target.value);
                invalideer();
              }}
            />
          </Field>

          <Field id="cc-call-date" label={t("callDate")} required>
            <input
              id="cc-call-date"
              name="call_date"
              type="date"
              required
              value={callDate}
              className="input w-full"
              onChange={(e) => {
                setCallDate(e.target.value);
                invalideer();
              }}
            />
          </Field>

          <Field id="cc-due-date" label={t("dueDate")}>
            <input
              id="cc-due-date"
              name="due_date"
              type="date"
              className="input w-full"
              value={dueDate}
              onChange={(e) => {
                setDueDate(e.target.value);
                invalideer();
              }}
            />
          </Field>
        </div>

        {handmatig && deelnemers.length > 0 && (
          <fieldset className="border-line m-0 rounded border p-3">
            <legend className="label px-1">{t("manual.title")}</legend>
            <p className="text-ink-soft mt-0 mb-2 text-[0.78rem]">{t("manual.hint")}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {deelnemers.map((lot) => (
                <Field key={lot.id} id={`manual_${lot.id}`} label={lot.label}>
                  <input
                    id={`manual_${lot.id}`}
                    name={`manual_${lot.id}`}
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    className="input w-full"
                    value={manueel[lot.id] ?? ""}
                    onChange={(e) => {
                      setManueel((m) => ({ ...m, [lot.id]: e.target.value }));
                      invalideer();
                    }}
                  />
                </Field>
              ))}
            </div>
          </fieldset>
        )}

        {/* ── 2. controleren ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={buttonClasses("secondary", "md")}
            onClick={() => {
              setGecontroleerd(true);
              setBevestigd(false);
            }}
            data-testid="run-check"
          >
            {gecontroleerd ? t("check.again") : t("check.run")}
          </button>

          {gecontroleerd && uitkomst && (
            <ReadinessPanel
              uitkomst={uitkomst}
              buildingId={buildingId}
              locale={locale}
            />
          )}
        </div>

        {/* ── 3. definitief aanmaken ──────────────────────────────────── */}
        {gecontroleerd && uitkomst?.clear && (
          <div className="border-line flex flex-col gap-2 rounded border p-3">
            <h4 className="m-0 text-[0.9rem] font-semibold">{t("confirm.title")}</h4>
            <p className="text-warn m-0 text-[0.8rem]" role="alert">
              {t("confirm.warning")}
            </p>
            <label className="flex items-center gap-2 text-[0.85rem]">
              <input
                id="cc-confirm"
                type="checkbox"
                className="size-4"
                checked={bevestigd}
                onChange={(e) => setBevestigd(e.target.checked)}
                data-testid="confirm-checkbox"
              />
              {t("confirm.checkbox")}
            </label>
            <FinalSubmit label={t("confirm.submit")} pendingLabel={t("confirm.pending")} enabled={magAanmaken} />
          </div>
        )}
      </ActionForm>
    </Card>
  );
}

/**
 * De knop die geld vastlegt.
 *
 * `aria-disabled` in plaats van `disabled`, net als elders in deze applicatie:
 * een uitgeschakelde knop verdwijnt uit de tabvolgorde precies wanneer de
 * gebruiker wil weten waarom hij niet kan verzenden. De klik wordt geblokkeerd
 * zolang de knop niet vrij is — dat dekt zowel "nog niet bevestigd" als een
 * tweede klik tijdens het verzenden.
 */
function FinalSubmit({
  label,
  pendingLabel,
  enabled,
}: {
  label: string;
  pendingLabel: string;
  enabled: boolean;
}) {
  const { pending } = useFormStatus();
  const geblokkeerd = pending || !enabled;

  return (
    <>
      <button
        type="submit"
        data-testid="final-submit"
        aria-disabled={geblokkeerd}
        aria-busy={pending}
        className={buttonClasses("primary", "md", geblokkeerd ? "opacity-60" : undefined)}
        onClick={(event) => {
          if (geblokkeerd) event.preventDefault();
        }}
      >
        {pending ? pendingLabel : label}
      </button>
      <span aria-live="polite" className="sr-only">
        {pending ? pendingLabel : ""}
      </span>
    </>
  );
}

function ReadinessPanel({
  uitkomst,
  buildingId,
  locale,
}: {
  uitkomst: NonNullable<ReturnType<typeof chargeCallReadiness>>;
  buildingId: string;
  locale: string;
}) {
  const t = useTranslations("charges");

  return (
    <section
      aria-labelledby="cc-check-kop"
      className="border-line flex flex-col gap-3 rounded border p-3"
      data-testid="readiness"
    >
      <div>
        <h4 id="cc-check-kop" className="m-0 text-[0.9rem] font-semibold">
          {t("check.title")}
        </h4>
        <p className="text-ink-soft mt-1 mb-0 text-[0.78rem]">{t("check.intro")}</p>
      </div>

      <p className="m-0 text-[0.82rem]">
        {t("check.participants")}:{" "}
        <strong className="[font-variant-numeric:tabular-nums]">
          {uitkomst.participantCount.toLocaleString(locale === "ar" ? "ar-MA-u-nu-latn" : locale)}
        </strong>
      </p>

      {uitkomst.blockers.length > 0 ? (
        <div role="alert" className="flex flex-col gap-2" data-testid="blockers">
          <h5 className="text-crit m-0 text-[0.82rem] font-semibold">
            {t("check.blockersTitle")}
          </h5>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {uitkomst.blockers.map((b) => (
              <li key={b.code} className="text-[0.8rem]">
                <span className="text-crit">{t(`errors.${blockerKey(b)}` as never)}</span>
                <LotList blocker={b} buildingId={buildingId} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p role="status" className="text-good m-0 text-[0.82rem]" data-testid="clear">
          {t("check.clear")}
        </p>
      )}

      {uitkomst.notices.length > 0 && (
        <div className="flex flex-col gap-1">
          <h5 className="text-ink-soft m-0 text-[0.78rem] font-semibold">
            {t("check.noticesTitle")}
          </h5>
          <ul className="text-ink-soft m-0 flex list-none flex-col gap-1 p-0 text-[0.78rem]">
            {uitkomst.notices.map((n) => (
              <li key={n.code}>
                {n.code === "PARTIAL_DENOMINATOR"
                  ? t("check.partialDenominator", {
                      year: n.untilYear,
                      participating: n.participating,
                      declared: n.declared,
                    })
                  : t("check.manualSumNote")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Nooit "dit zal slagen": de database beslist, en pas bij het aanmaken. */}
      <p className="text-ink-soft m-0 text-[0.75rem]">{t("check.notGuarantee")}</p>
    </section>
  );
}

/** De betrokken lots, met naam uit de eigen query — nooit uit databasefouttekst. */
function LotList({
  blocker,
  buildingId,
}: {
  blocker: ReadinessBlocker;
  buildingId: string;
}) {
  const t = useTranslations("charges");
  if (!("units" in blocker) || blocker.units.length === 0) return null;

  return (
    <span className="text-ink-soft block">
      {t("check.lots")}: {blocker.units.map((u) => u.label).join(", ")}{" "}
      <Link href={`/buildings/${buildingId}/lots`} className="underline">
        {t("check.openLots")}
      </Link>
    </span>
  );
}

"use client";

import { useTranslations } from "next-intl";
import ReversalDialog from "@/components/ReversalDialog";
import {
  correctPayment,
  reversePayment,
} from "@/app/[locale]/buildings/[id]/boekjaren/actions";

/**
 * De twee acties op een betaling: contrepasser en corriger.
 *
 * Rendert niets wanneer de gebruiker niet bevoegd is of de betaling al is
 * gestorneerd. De UI is geen security boundary — `fn_reversal_authorize`
 * beslist — maar we bieden geen knop aan waarvan we weten dat hij faalt.
 *
 * Bewerkbaar is uitsluitend wat correct_payment() accepteert: bedrag,
 * valutadatum, betaalwijze en referentie. Eigenaar en gebouw staan er bewust
 * niet bij: een andere debiteur is geen correctie van deze betaling maar een
 * andere transactie.
 */
export default function PaymentReversalActions({
  paymentId,
  fiscalYearId,
  ownerName,
  amount,
  valueDate,
  method,
  reference,
  closedFiscalYear,
}: {
  paymentId: string;
  fiscalYearId: string;
  ownerName: string;
  amount: number;
  valueDate: string;
  method: string;
  reference: string | null;
  /** Staat de ORIGINELE journaalpost in een afgesloten boekjaar? */
  closedFiscalYear: boolean;
}) {
  const t = useTranslations("reversal");
  const tp = useTranslations("payments");

  const hidden = { payment_id: paymentId, fy_id: fiscalYearId };
  const warning = closedFiscalYear ? t("closedFyWarning") : undefined;

  const summary = (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 0.8rem" }}>
      <dt className="muted">{t("owner")}</dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>{ownerName}</dd>
      <dt className="muted">{t("amount")}</dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>
        {amount.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD
      </dd>
      <dt className="muted">{t("date")}</dt>
      <dd style={{ margin: 0 }}>{valueDate}</dd>
      {reference && (
        <>
          <dt className="muted">{t("reference")}</dt>
          <dd style={{ margin: 0 }}>{reference}</dd>
        </>
      )}
    </dl>
  );

  return (
    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
      <ReversalDialog
        action={correctPayment}
        triggerLabel={t("correct")}
        title={t("correctPaymentTitle")}
        intro={t("correctPaymentIntro")}
        warning={warning}
        summary={summary}
        hidden={hidden}
        reasonLabel={t("reasonLabel")}
        reasonHint={t("reasonHint")}
        reasonPlaceholder={t("reasonPlaceholder")}
        confirmLabel={t("confirmCorrect")}
        cancelLabel={t("cancel")}
        pendingLabel={t("pending")}
        fields={
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem" }}>
              <div>
                <label className="label" htmlFor={`amt-${paymentId}`}>{t("amount")}</label>
                <input
                  className="input"
                  id={`amt-${paymentId}`}
                  name="amount"
                  type="text"
                  defaultValue={amount.toFixed(2)}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor={`vd-${paymentId}`}>{t("date")}</label>
                <input
                  className="input"
                  id={`vd-${paymentId}`}
                  name="value_date"
                  type="date"
                  defaultValue={valueDate}
                  required
                />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem" }}>
              <div>
                <label className="label" htmlFor={`m-${paymentId}`}>{t("method")}</label>
                <select className="input" id={`m-${paymentId}`} name="method" defaultValue={method}>
                  <option value="virement">{tp("methods.virement")}</option>
                  <option value="especes">{tp("methods.especes")}</option>
                  <option value="cheque">{tp("methods.cheque")}</option>
                  <option value="carte">{tp("methods.carte")}</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor={`ref-${paymentId}`}>{t("reference")}</label>
                <input
                  className="input"
                  id={`ref-${paymentId}`}
                  name="reference"
                  defaultValue={reference ?? ""}
                />
              </div>
            </div>
          </>
        }
      />

      <ReversalDialog
        action={reversePayment}
        triggerLabel={t("reverse")}
        title={t("reversePaymentTitle")}
        intro={t("reversePaymentIntro")}
        warning={warning}
        summary={summary}
        hidden={hidden}
        reasonLabel={t("reasonLabel")}
        reasonHint={t("reasonHint")}
        reasonPlaceholder={t("reasonPlaceholder")}
        confirmLabel={t("confirmReverse")}
        cancelLabel={t("cancel")}
        pendingLabel={t("pending")}
        danger
      />
    </div>
  );
}

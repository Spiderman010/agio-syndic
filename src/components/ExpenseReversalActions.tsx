"use client";

import { useTranslations } from "next-intl";
import ReversalDialog from "@/components/ReversalDialog";
import {
  correctExpense,
  reverseExpense,
} from "@/app/[locale]/buildings/[id]/expenses/actions";

/**
 * De twee acties op een uitgave: contrepasser en corriger.
 *
 * Het bewijsstuk van het origineel blijft altijd bestaan; de storno raakt het
 * niet aan. Bij een correctie mag een nieuw bewijsstuk worden meegestuurd via
 * hetzelfde veld en dezelfde bucket als bij het aanmaken van een uitgave — er is
 * geen tweede uploadpad. Wordt er niets meegestuurd, dan erft de correctie het
 * bewijsstuk van het origineel.
 *
 * De grootboekrekening staat bewust niet in het formulier: de invoerflow laat
 * die ook niet kiezen (hij volgt uit de categorie) en de server neemt hem over
 * van de originele uitgave.
 */
export default function ExpenseReversalActions({
  expenseId,
  amount,
  expenseDate,
  supplier,
  description,
  categoryId,
  categories,
  closedFiscalYear,
}: {
  expenseId: string;
  amount: number;
  expenseDate: string;
  supplier: string | null;
  description: string | null;
  categoryId: string | null;
  categories: { id: string; name: string }[];
  closedFiscalYear: boolean;
}) {
  const t = useTranslations("reversal");
  const te = useTranslations("expenses");

  const hidden = { expense_id: expenseId };
  const warning = closedFiscalYear ? t("closedFyWarning") : undefined;

  const summary = (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 0.8rem" }}>
      <dt className="muted">{t("supplier")}</dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>{supplier ?? description ?? "—"}</dd>
      <dt className="muted">{t("amount")}</dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>
        {amount.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MAD
      </dd>
      <dt className="muted">{t("date")}</dt>
      <dd style={{ margin: 0 }}>{expenseDate}</dd>
    </dl>
  );

  return (
    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
      <ReversalDialog
        action={correctExpense}
        triggerLabel={t("correct")}
        title={t("correctExpenseTitle")}
        intro={t("correctExpenseIntro")}
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
                <label className="label" htmlFor={`eamt-${expenseId}`}>{t("amount")}</label>
                <input
                  className="input"
                  id={`eamt-${expenseId}`}
                  name="amount"
                  type="text"
                  defaultValue={amount.toFixed(2)}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor={`edate-${expenseId}`}>{t("date")}</label>
                <input
                  className="input"
                  id={`edate-${expenseId}`}
                  name="expense_date"
                  type="date"
                  defaultValue={expenseDate}
                  required
                />
              </div>
            </div>
            <div>
              <label className="label" htmlFor={`esup-${expenseId}`}>{t("supplier")}</label>
              <input
                className="input"
                id={`esup-${expenseId}`}
                name="supplier"
                defaultValue={supplier ?? ""}
              />
            </div>
            <div>
              <label className="label" htmlFor={`edesc-${expenseId}`}>{t("description")}</label>
              <input
                className="input"
                id={`edesc-${expenseId}`}
                name="description"
                defaultValue={description ?? ""}
              />
            </div>
            <div>
              <label className="label" htmlFor={`ecat-${expenseId}`}>{t("category")}</label>
              <select
                className="input"
                id={`ecat-${expenseId}`}
                name="category_id"
                defaultValue={categoryId ?? ""}
              >
                <option value="">{t("noCategory")}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`erec-${expenseId}`}>{te("receipt")}</label>
              <input
                className="input"
                id={`erec-${expenseId}`}
                name="receipt"
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.heic,.pdf"
              />
              <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.2rem" }}>
                {te("uploadHint")}
              </div>
            </div>
          </>
        }
      />

      <ReversalDialog
        action={reverseExpense}
        triggerLabel={t("reverse")}
        title={t("reverseExpenseTitle")}
        intro={t("reverseExpenseIntro")}
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

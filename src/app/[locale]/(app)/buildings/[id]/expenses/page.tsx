import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";
import { createExpense, createExpenseCategory } from "./actions";
import ReceiptLink from "@/components/ReceiptLink";
import ActionForm from "@/components/ActionForm";
import ExpenseReversalActions from "@/components/ExpenseReversalActions";
import { canReverse } from "@/lib/roles";
import { correctionOf, fetchReversalIndexResult, netTotal, reversalOf } from "@/lib/reversal";
import type { Building, FiscalYear } from "@/lib/types";

type CategoryRow = { id: string; name: string; default_account_id: string | null };
type ExpenseRow = {
  id: string;
  supplier: string | null;
  description: string | null;
  amount: number;
  expense_date: string;
  receipt_path: string | null;
  receipt_url: string | null;
  fiscal_year_id: string | null;
  category_id: string | null;
  expense_categories: { name: string } | null;
};

function fmt(n: number) {
  return n.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function ExpensesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: buildingId } = await params;
  const { org, role } = await requireOrg();
  const supabase = await createClient();
  const t = await getTranslations("expenses");
  const tr = await getTranslations("reversal");

  const { data: buildingData } = await supabase.from("buildings").select("*").eq("id", buildingId).maybeSingle();
  if (!buildingData) notFound();
  const b = buildingData as Building;

  const [
    { data: catData, error: catError },
    { data: expData, error: expError },
    { data: fyData, error: openFyError },
  ] = await Promise.all([
    supabase
      .from("expense_categories")
      .select("id, name, default_account_id")
      .eq("organization_id", org.id)
      .order("name"),
    supabase
      .from("expenses")
      .select(
        "id, supplier, description, amount, expense_date, receipt_path, receipt_url, fiscal_year_id, category_id, expense_categories(name)",
      )
      .eq("building_id", buildingId)
      .order("expense_date", { ascending: false })
      .limit(50),
    // Alleen OPEN boekjaren: een afgesloten boekjaar accepteert geen uitgaven
    // meer (afgedwongen door trig_00_exp_closed_fy).
    supabase
      .from("fiscal_years")
      .select("id, year, status")
      .eq("building_id", buildingId)
      .eq("status", "open")
      .order("year", { ascending: false }),
  ]);

  // FAIL-CLOSED per bron. `data ?? []` maakt van elke mislukte query een lege
  // lijst, en leeg is hier nooit neutraal: het is een BEWERING. "Geen uitgaven"
  // is een uitspraak over geld, "geen categorieën" stuurt een formulier dat de
  // database vervolgens weigert, en "geen afgesloten boekjaren" laat een storno
  // eruitzien als een gewone ingreep. Elke bron krijgt daarom een eigen poort.
  const categories = (catData ?? []) as CategoryRow[];
  const expenses = (expData ?? []) as unknown as ExpenseRow[];
  const fiscalYears = (fyData ?? []) as Pick<FiscalYear, "id" | "year" | "status">[];

  const expensesOk = !expError;
  const categoriesOk = !catError;
  const openFyOk = !openFyError;

  // ---- Financial Reversal Engine -------------------------------------------
  // De storno's die bij deze uitgaven horen. Hiermee wordt de LIJST gemarkeerd
  // (klasse A: alles blijft zichtbaar) en het TOTAAL genet (klasse B).
  //
  // FAIL-CLOSED. Dit scherm gebruikt bewust de STRIKTE variant. De fail-open
  // variant gaf bij een leesfout een lege index terug, en een lege index is
  // hier niet onschuldig: `netTotal()` telt dan niets af en levert precies het
  // BRUTO bedrag op, terwijl het label en de hint dat getal als NETTO
  // presenteren. Een correctie van 1200 naar 900 werd zo als 2100 getoond op de
  // plek die zegt "dit is de stand". Tegelijk verdween de storno-markering uit
  // de lijst en verscheen er een stornoknop bij een rij die de database zeker
  // weigert.
  //
  // Nul uitgaven is GEEN fout: er valt dan niets op te halen en de lege index
  // is de juiste, betrouwbare uitkomst.
  const { index: reversals, error: reversalError } = await fetchReversalIndexResult(
    supabase,
    "expense",
    expenses.map((e) => e.id),
  );
  const reversalsOk = !reversalError;

  // Welke boekjaren zijn afgesloten? Bepaalt of storneren een owner/admin-
  // ingreep is; de database beslist definitief in fn_reversal_authorize.
  //
  // Ook hier telt de foutstatus. Een stil lege `closedFy` laat een uitgave uit
  // een GESLOTEN boekjaar eruitzien alsof de gewone rolregels volstaan, en
  // biedt de actie dan aan een manager aan die hem niet mag uitvoeren.
  const { data: allFyData, error: fyStatusError } = await supabase
    .from("fiscal_years")
    .select("id, status")
    .eq("building_id", buildingId);
  const fyStatusOk = !fyStatusError;
  const closedFy = new Set(
    (allFyData ?? []).filter((f) => f.status === "closed").map((f) => f.id as string),
  );

  // Het aanmaakformulier steunt op de categorieën EN op de open boekjaren. Valt
  // de boekjaarquery weg, dan verdwijnt de keuzelijst stilzwijgend en zou er een
  // uitgave zonder boekjaar kunnen ontstaan — zonder journaalpost, en daarmee
  // niet storneerbaar. Beide bronnen poorten dus hetzelfde formulier.
  const formOk = categoriesOk && openFyOk;

  // Totaal, rijen en lege toestand steunen op de uitgaven ÉN op de stornostatus.
  const listOk = expensesOk && reversalsOk;

  // NETTO totaal: een gestorneerde uitgave telt niet mee, de vervangende wel.
  // Een correctie van 1200 naar 900 levert dus 900 en niet 2100. De lijst
  // hieronder toont nog steeds alle rijen.
  //
  // Beide grootheden worden alleen berekend wanneer de stornostatus vaststaat.
  // Is dat niet zo, dan wordt er geen bedrag getoond: liever geen getal dan een
  // bruto bedrag onder een netto label.
  const totalAmount = listOk ? netTotal(expenses, reversals) : null;
  const heeftStorno = listOk && expenses.some((e) => reversals.bySource.has(e.id));

  // De lijst draagt de stornomarkering en de stornoknop. Zonder betrouwbare
  // index zou een gestorneerde uitgave als actief verschijnen, dus dan wordt de
  // lijst onderdrukt in plaats van half correct getoond.
  const zichtbareUitgaven = listOk ? expenses : [];

  return (
    <>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0 0 1.2rem", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h1 className="mt-0 mb-0 text-2xl font-semibold text-ink">{t("title")}</h1>
            <p className="muted mt-1 mb-0 text-[0.9rem]">{b.name}</p>
          </div>
          {/* Ook tonen bij 0: na een storno IS het nettototaal legitiem nul, en
              een verdwijnend totaal zou als "niet berekend" worden gelezen.
              Bij een onbetrouwbare stornostatus verschijnt er juist GEEN getal;
              de melding hieronder legt uit waarom. */}
          {listOk && totalAmount !== null && expenses.length > 0 && (
            <span style={{ fontWeight: 700, fontSize: "1rem" }} title={heeftStorno ? tr("netHint") : undefined} data-testid="expenses-total">
              {fmt(totalAmount)} MAD {t("title").toLowerCase()}
              {heeftStorno && (
                <span className="muted" style={{ fontWeight: 500, fontSize: "0.78rem", marginInlineStart: 6 }}>
                  ({tr("netLabel")})
                </span>
              )}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]">
          {/* Expenses list */}
          <div>
            <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>
              {t("title")}
              {listOk && <> ({expenses.length})</>}
            </h2>

            {/* Meldingen in mensentaal. Nooit de databasefout, de tabel- of
                viewnaam of een technische code: die horen in de serverlogs,
                niet op een financieel scherm. */}
            {!expensesOk && (
              <div
                className="card"
                style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}
                role="alert"
                data-testid="expenses-error"
              >
                {t("errors.listUnavailable")}
              </div>
            )}

            {expensesOk && !reversalsOk && (
              <div
                className="card"
                style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}
                role="alert"
                data-testid="reversals-error"
              >
                {tr("errors.expenseStatusUnavailable")}
              </div>
            )}

            {/* De lege toestand is een BEWERING: "er zijn geen uitgaven". Die
                mag alleen verschijnen wanneer de stornostatus vaststaat. */}
            {/* De boekjaarstatus bepaalt of storneren een owner/admin-ingreep
                is. Staat die niet vast, dan wordt de actie niet aangeboden en
                legt deze melding uit waarom. */}
            {listOk && expenses.length > 0 && !fyStatusOk && (
              <div
                className="card"
                style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}
                role="alert"
                data-testid="fy-status-error"
              >
                {t("errors.fiscalYearStatusUnavailable")}
              </div>
            )}

            {listOk && expenses.length === 0 && (
              <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
                <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🧾</div>
                <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>{t("noExpenses")}</div>
              </div>
            )}

            <div style={{ display: "grid", gap: "0.6rem" }}>
              {zichtbareUitgaven.map((e) => {
                const rawCat = e.expense_categories as { name: string } | { name: string }[] | null;
                const catName = Array.isArray(rawCat) ? (rawCat[0]?.name ?? null) : rawCat?.name ?? null;

                // Storno-context. `reversal` = deze uitgave is gestorneerd;
                // `correction` = deze uitgave IS de vervangende rij.
                const reversal = reversalOf(reversals, e.id);
                const correction = correctionOf(reversals, e.id);
                const isClosed = e.fiscal_year_id !== null && closedFy.has(e.fiscal_year_id);

                // Alleen aanbieden wat kan slagen: bevoegd, nog niet gestorneerd,
                // en gejournaliseerd (een uitgave zonder boekjaar heeft geen
                // journaalpost en wordt gewoon verwijderd, niet gestorneerd).
                const mayReverse =
                  reversalsOk &&
                  fyStatusOk &&
                  reversal === null &&
                  e.fiscal_year_id !== null &&
                  canReverse(role, isClosed);

                return (
                  <div key={e.id} className="card" style={{ padding: "0.9rem 1rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "0.95rem", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          {e.supplier ?? e.description ?? "—"}
                          {reversal && (
                            <span className="badge badge-storno">
                              {reversal.isCorrection ? tr("corrected") : tr("reversed")}
                            </span>
                          )}
                          {correction && <span className="badge badge-correctie">{tr("isCorrection")}</span>}
                        </div>
                        <div className="muted" style={{ fontSize: "0.78rem", marginTop: 2 }}>
                          {e.expense_date}
                          {catName && <> · {catName}</>}
                          {e.description && e.supplier && <> · {e.description}</>}
                        </div>
                        {reversal && (
                          <div className="muted" style={{ fontSize: "0.74rem", marginTop: 4, lineHeight: 1.45 }}>
                            {reversal.isCorrection ? tr("replacedBy") : tr("typeReversal")}
                            {" · "}
                            {tr("reasonLabel")}: {reversal.reason}
                            {reversal.effectiveDate && <> · {reversal.effectiveDate}</>}
                            {reversal.isPriorYearCorrection && <> · {tr("priorYear")}</>}
                          </div>
                        )}
                        {correction && (
                          <div className="muted" style={{ fontSize: "0.74rem", marginTop: 4 }}>
                            {tr("correctionOf")}
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                        <span
                          className={reversal ? "amount-reversed" : undefined}
                          style={reversal ? { fontSize: "0.97rem" } : { fontWeight: 700, fontSize: "0.97rem" }}
                        >
                          {fmt(Number(e.amount))} MAD
                        </span>
                        {(e.receipt_path || e.receipt_url) && (
                          <ReceiptLink expenseId={e.id} label={t("viewReceipt")} />
                        )}
                      </div>
                    </div>
                    {mayReverse && (
                      <div style={{ marginTop: "0.6rem", borderTop: "1px solid var(--line)", paddingTop: "0.55rem" }}>
                        <ExpenseReversalActions
                          expenseId={e.id}
                          amount={Number(e.amount)}
                          expenseDate={e.expense_date}
                          supplier={e.supplier}
                          description={e.description}
                          categoryId={e.category_id}
                          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
                          closedFiscalYear={isClosed}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add expense form. Zonder betrouwbare categorieën of boekjaren
                verschijnt er GEEN formulier en dus ook geen aanmaakknop: een
                formulier dat de database zeker weigert, of dat stilzwijgend een
                uitgave zonder boekjaar aanmaakt, is erger dan geen formulier. */}
            {!formOk && (
              <div
                className="card"
                style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginTop: "0.9rem" }}
                role="alert"
                data-testid="form-error"
              >
                {t("errors.formUnavailable")}
              </div>
            )}

            {formOk && (
            <ActionForm action={createExpense} className="card" style={{ padding: "1.1rem 1.2rem", marginTop: "0.9rem" }}>
              <input type="hidden" name="building_id" value={buildingId} />
              <h3 style={{ fontSize: "0.92rem", margin: "0 0 0.9rem" }}>{t("addExpense")}</h3>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.7rem", marginBottom: "0.7rem" }}>
                <div>
                  <label className="label" htmlFor="supplier">{t("supplier")}</label>
                  <input className="input" id="supplier" name="supplier" placeholder={t("supplierPlaceholder")} />
                </div>
                <div>
                  <label className="label" htmlFor="expense_date">{t("date")}</label>
                  <input className="input" id="expense_date" name="expense_date" type="date" required />
                </div>
              </div>

              <div style={{ marginBottom: "0.7rem" }}>
                <label className="label" htmlFor="description">{t("description")}</label>
                <input className="input" id="description" name="description" placeholder={t("descPlaceholder")} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.7rem", marginBottom: "0.7rem" }}>
                <div>
                  <label className="label" htmlFor="amount">{t("amount")}</label>
                  <input className="input" id="amount" name="amount" type="text" placeholder="1200.00" required />
                </div>
                <div>
                  <label className="label" htmlFor="category_id">{t("category")}</label>
                  <select className="input" id="category_id" name="category_id">
                    <option value="">{t("noCategory")}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {fiscalYears.length > 0 && (
                <div style={{ marginBottom: "0.7rem" }}>
                  <label className="label" htmlFor="fiscal_year_id">{t("fiscalYear")}</label>
                  <select className="input" id="fiscal_year_id" name="fiscal_year_id">
                    <option value="">{t("noFiscalYear")}</option>
                    {fiscalYears.map((fy) => (
                      <option key={fy.id} value={fy.id}>
                        Exercice {fy.year}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div style={{ marginBottom: "0.9rem" }}>
                <label className="label" htmlFor="receipt">{t("receipt")}</label>
                <input
                  className="input"
                  id="receipt"
                  name="receipt"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                  style={{ padding: "0.4rem 0.5rem" }}
                />
                <div className="muted" style={{ fontSize: "0.72rem", marginTop: 3 }}>{t("uploadHint")}</div>
              </div>

              <button className="btn btn-primary" style={{ width: "100%" }}>{t("createBtn")}</button>
            </ActionForm>
            )}
          </div>

          {/* Categories */}
          <div>
            <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>{t("categories")}</h2>

            {!categoriesOk && (
              <div
                className="card"
                style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}
                role="alert"
                data-testid="categories-error"
              >
                {t("errors.categoriesUnavailable")}
              </div>
            )}

            {/* "Geen categorieën" is een bewering en mag niet gokken. */}
            {categoriesOk && categories.length === 0 && (
              <div className="card" style={{ padding: "1rem", marginBottom: "0.7rem" }}>
                <div className="muted" style={{ fontSize: "0.85rem" }}>{t("noCategories")}</div>
              </div>
            )}

            <div style={{ display: "grid", gap: "0.4rem", marginBottom: "0.7rem" }}>
              {(categoriesOk ? categories : []).map((c) => (
                <div key={c.id} className="card" style={{ padding: "0.65rem 0.9rem", fontSize: "0.88rem" }}>
                  {c.name}
                </div>
              ))}
            </div>

            {categoriesOk && (
            <ActionForm action={createExpenseCategory} className="card" style={{ padding: "1rem 1.1rem" }}>
              <input type="hidden" name="building_id" value={buildingId} />
              <h3 style={{ fontSize: "0.88rem", margin: "0 0 0.7rem" }}>{t("addExpense").replace("dépense", "catégorie")}</h3>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  className="input"
                  name="name"
                  placeholder={t("categoryName")}
                  required
                  style={{ flex: 1 }}
                />
                <button className="btn btn-primary" style={{ whiteSpace: "nowrap" }}>{t("addCategory")}</button>
              </div>
            </ActionForm>
            )}
          </div>
        </div>
    </>
  );
}

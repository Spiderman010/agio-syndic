import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import { Link } from "@/navigation";
import { getTranslations } from "next-intl/server";
import { createExpense, createExpenseCategory } from "./actions";
import type { Building, FiscalYear } from "@/lib/types";

type CategoryRow = { id: string; name: string; default_account_id: string | null };
type ExpenseRow = {
  id: string;
  supplier: string | null;
  description: string | null;
  amount: number;
  expense_date: string;
  receipt_url: string | null;
  fiscal_year_id: string | null;
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
  const { org } = await requireOrg();
  const supabase = await createClient();
  const t = await getTranslations("expenses");

  const { data: buildingData } = await supabase.from("buildings").select("*").eq("id", buildingId).maybeSingle();
  if (!buildingData) notFound();
  const b = buildingData as Building;

  const [{ data: catData }, { data: expData }, { data: fyData }] = await Promise.all([
    supabase
      .from("expense_categories")
      .select("id, name, default_account_id")
      .eq("organization_id", org.id)
      .order("name"),
    supabase
      .from("expenses")
      .select("id, supplier, description, amount, expense_date, receipt_url, fiscal_year_id, expense_categories(name)")
      .eq("building_id", buildingId)
      .order("expense_date", { ascending: false })
      .limit(50),
    supabase
      .from("fiscal_years")
      .select("id, year, status")
      .eq("building_id", buildingId)
      .order("year", { ascending: false }),
  ]);

  const categories = (catData ?? []) as CategoryRow[];
  const expenses = (expData ?? []) as unknown as ExpenseRow[];
  const fiscalYears = (fyData ?? []) as Pick<FiscalYear, "id" | "year" | "status">[];

  const totalAmount = expenses.reduce((s, e) => s + Number(e.amount), 0);

  return (
    <>
      <TopBar orgName={org.name} />
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1.6rem 1.3rem 4rem" }}>
        <div style={{ fontSize: "0.82rem", display: "flex", gap: 6, alignItems: "center" }} className="muted">
          <Link href="/buildings" className="muted">Bâtiments</Link>
          <span>/</span>
          <Link href={`/buildings/${buildingId}`} className="muted">{b.name}</Link>
          <span>/</span>
          <span style={{ color: "var(--ink)" }}>{t("title")}</span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0.7rem 0 1.2rem", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ margin: 0, fontSize: "1.4rem" }}>{t("title")}</h1>
          {totalAmount > 0 && (
            <span style={{ fontWeight: 700, fontSize: "1rem" }}>
              {fmt(totalAmount)} MAD {t("title").toLowerCase()}
            </span>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "1.4rem", alignItems: "start" }}>
          {/* Expenses list */}
          <div>
            <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>
              {t("title")} ({expenses.length})
            </h2>

            {expenses.length === 0 && (
              <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
                <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🧾</div>
                <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>{t("noExpenses")}</div>
              </div>
            )}

            <div style={{ display: "grid", gap: "0.6rem" }}>
              {expenses.map((e) => {
                const rawCat = e.expense_categories as { name: string } | { name: string }[] | null;
                const catName = Array.isArray(rawCat) ? (rawCat[0]?.name ?? null) : rawCat?.name ?? null;
                return (
                  <div key={e.id} className="card" style={{ padding: "0.9rem 1rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                          {e.supplier ?? e.description ?? "—"}
                        </div>
                        <div className="muted" style={{ fontSize: "0.78rem", marginTop: 2 }}>
                          {e.expense_date}
                          {catName && <> · {catName}</>}
                          {e.description && e.supplier && <> · {e.description}</>}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                        <span style={{ fontWeight: 700, fontSize: "0.97rem" }}>{fmt(Number(e.amount))} MAD</span>
                        {e.receipt_url && (
                          <a
                            href={e.receipt_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn"
                            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                          >
                            📎 {t("viewReceipt")}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add expense form */}
            <form action={createExpense} className="card" style={{ padding: "1.1rem 1.2rem", marginTop: "0.9rem" }}>
              <input type="hidden" name="building_id" value={buildingId} />
              <h3 style={{ fontSize: "0.92rem", margin: "0 0 0.9rem" }}>{t("addExpense")}</h3>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem", marginBottom: "0.7rem" }}>
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

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem", marginBottom: "0.7rem" }}>
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
                        Exercice {fy.year}{fy.status === "closed" ? " (clôturé)" : ""}
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
            </form>
          </div>

          {/* Categories */}
          <div>
            <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>{t("categories")}</h2>

            {categories.length === 0 && (
              <div className="card" style={{ padding: "1rem", marginBottom: "0.7rem" }}>
                <div className="muted" style={{ fontSize: "0.85rem" }}>{t("noCategories")}</div>
              </div>
            )}

            <div style={{ display: "grid", gap: "0.4rem", marginBottom: "0.7rem" }}>
              {categories.map((c) => (
                <div key={c.id} className="card" style={{ padding: "0.65rem 0.9rem", fontSize: "0.88rem" }}>
                  {c.name}
                </div>
              ))}
            </div>

            <form action={createExpenseCategory} className="card" style={{ padding: "1rem 1.1rem" }}>
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
            </form>
          </div>
        </div>
      </main>
    </>
  );
}

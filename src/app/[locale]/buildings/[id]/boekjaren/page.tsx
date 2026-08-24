import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import { Link } from "@/navigation";
import { getTranslations } from "next-intl/server";
import type { Building, FiscalYear } from "@/lib/types";
import BoekjaarForm from "./BoekjaarForm";

export default async function BoekjarenPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const t = await getTranslations("boekjaren");

  const { data: buildingData } = await supabase.from("buildings").select("*").eq("id", id).maybeSingle();
  if (!buildingData) notFound();
  const b = buildingData as Building;

  const { data: fyData } = await supabase
    .from("fiscal_years")
    .select("*")
    .eq("building_id", id)
    .order("year", { ascending: false });
  const fiscalYears = (fyData ?? []) as FiscalYear[];

  const fyIds = fiscalYears.map((fy) => fy.id);
  const callSums: Record<string, number> = {};
  if (fyIds.length > 0) {
    const { data: sums } = await supabase
      .from("charge_calls")
      .select("fiscal_year_id, total_amount")
      .in("fiscal_year_id", fyIds);
    for (const row of sums ?? []) {
      callSums[row.fiscal_year_id] = (callSums[row.fiscal_year_id] ?? 0) + Number(row.total_amount);
    }
  }

  const huidigJaar = new Date().getFullYear();
  const existingYears = fiscalYears.map((fy) => fy.year);

  return (
    <>
      <TopBar orgName={org.name} />
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "1.6rem 1.3rem 4rem" }}>
        <Link href={`/buildings/${id}`} className="muted" style={{ fontSize: "0.82rem" }}>
          ← {b.name}
        </Link>

        <h1 style={{ margin: "0.7rem 0 0", fontSize: "1.4rem" }}>{t("title")}</h1>

        <section style={{ marginTop: "1.2rem" }}>
          {fiscalYears.length === 0 && (
            <div className="card" style={{ padding: "1.6rem", textAlign: "center" }}>
              <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>📅</div>
              <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>{t("noBoekjaren")}</div>
            </div>
          )}
          <div style={{ display: "grid", gap: "0.6rem" }}>
            {fiscalYears.map((fy) => {
              const totaal = callSums[fy.id] ?? 0;
              return (
                <Link key={fy.id} href={`/buildings/${id}/boekjaren/${fy.id}`} style={{ textDecoration: "none" }}>
                  <div className="card" style={{ padding: "1rem 1.2rem", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
                    <div>
                      <strong style={{ fontSize: "1.05rem" }}>{t("title")} {fy.year}</strong>
                      <div className="muted" style={{ fontSize: "0.8rem", marginTop: 2 }}>
                        {fy.start_date} → {fy.end_date}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {totaal > 0 && (
                        <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
                          {totaal.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} {t("called")}
                        </span>
                      )}
                      <span className={`badge ${fy.status === "open" ? "badge-klein" : "badge-midden"}`}>
                        {fy.status === "open" ? t("status.open") : t("status.closed")}
                      </span>
                      <span className="muted" style={{ fontSize: "0.85rem" }}>→</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        <BoekjaarForm buildingId={b.id} existingYears={existingYears} huidigJaar={huidigJaar} />
      </main>
    </>
  );
}

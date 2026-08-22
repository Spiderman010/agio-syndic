import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import { createFiscalYear } from "./actions";
import type { Building, FiscalYear } from "@/lib/types";

export default async function BoekjarenPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();

  const { data: buildingData } = await supabase
    .from("buildings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!buildingData) notFound();
  const b = buildingData as Building;

  const { data: fyData } = await supabase
    .from("fiscal_years")
    .select("*")
    .eq("building_id", id)
    .order("year", { ascending: false });
  const fiscalYears = (fyData ?? []) as FiscalYear[];

  // Totaal opgeroepen per boekjaar
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

  return (
    <>
      <TopBar orgName={org.name} />
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "1.6rem 1.3rem 4rem" }}>
        <Link href={`/buildings/${id}`} className="muted" style={{ fontSize: "0.82rem" }}>
          ← {b.name}
        </Link>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: "0.7rem" }}>
          <h1 style={{ margin: 0, fontSize: "1.4rem" }}>Boekjaren</h1>
        </div>

        {error && (
          <p style={{ background: "#f6e3e1", color: "var(--crit)", padding: "0.6rem 0.8rem", borderRadius: 8, fontSize: "0.85rem", marginTop: "0.8rem" }}>
            {error}
          </p>
        )}

        {/* Boekjaaroverzicht */}
        <section style={{ marginTop: "1.2rem" }}>
          {fiscalYears.length === 0 && (
            <p className="muted" style={{ fontSize: "0.9rem" }}>Nog geen boekjaren aangemaakt.</p>
          )}
          <div style={{ display: "grid", gap: "0.6rem" }}>
            {fiscalYears.map((fy) => {
              const totaal = callSums[fy.id] ?? 0;
              return (
                <Link
                  key={fy.id}
                  href={`/buildings/${id}/boekjaren/${fy.id}`}
                  style={{ textDecoration: "none" }}
                >
                  <div
                    className="card"
                    style={{
                      padding: "1rem 1.2rem",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      cursor: "pointer",
                      transition: "border-color 0.12s",
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: "1.05rem" }}>Boekjaar {fy.year}</strong>
                      <div className="muted" style={{ fontSize: "0.8rem", marginTop: 2 }}>
                        {fy.start_date} → {fy.end_date}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {totaal > 0 && (
                        <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
                          {totaal.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} MAD
                        </span>
                      )}
                      <span
                        className={`badge ${fy.status === "open" ? "badge-klein" : "badge-midden"}`}
                      >
                        {fy.status === "open" ? "Open" : "Gesloten"}
                      </span>
                      <span className="muted" style={{ fontSize: "0.85rem" }}>→</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        {/* Nieuw boekjaar */}
        <form action={createFiscalYear} className="card" style={{ padding: "1.2rem 1.4rem", marginTop: "1.2rem" }}>
          <input type="hidden" name="building_id" value={b.id} />
          <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Nieuw boekjaar aanmaken</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.8rem" }}>
            <div>
              <label className="label" htmlFor="year">Jaar</label>
              <input
                className="input"
                id="year"
                name="year"
                type="number"
                min={2000}
                max={2100}
                defaultValue={huidigJaar}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="start_date">Startdatum</label>
              <input
                className="input"
                id="start_date"
                name="start_date"
                type="date"
                defaultValue={`${huidigJaar}-01-01`}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="end_date">Einddatum</label>
              <input
                className="input"
                id="end_date"
                name="end_date"
                type="date"
                defaultValue={`${huidigJaar}-12-31`}
                required
              />
            </div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: "1rem" }}>
            Boekjaar aanmaken
          </button>
        </form>
      </main>
    </>
  );
}

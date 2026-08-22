import Link from "next/link";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import { createBuilding } from "./actions";
import { TIER_LABELS } from "@/lib/tier";
import type { Building } from "@/lib/types";

export default async function BuildingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();
  const { data: buildings } = await supabase
    .from("buildings")
    .select("*")
    .order("created_at", { ascending: false });

  const list = (buildings ?? []) as Building[];

  return (
    <>
      <TopBar orgName={org.name} />
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1.6rem 1.3rem 4rem" }}>
        <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.2rem" }}>Gebouwen</h1>
        <p className="muted" style={{ margin: "0 0 1.4rem", fontSize: "0.9rem" }}>
          Beheer je copropriétés. Het tier bepaalt welke bijlagen en boekhouding gelden.
        </p>

        {error && (
          <p style={{ background: "#f6e3e1", color: "var(--crit)", padding: "0.6rem 0.8rem", borderRadius: 8, fontSize: "0.85rem" }}>
            {error}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: "1.4rem", alignItems: "start" }}>
          {/* Lijst */}
          <div style={{ display: "grid", gap: "0.7rem" }}>
            {list.length === 0 && (
              <div className="card muted" style={{ padding: "1.4rem", fontSize: "0.9rem" }}>
                Nog geen gebouwen. Maak er rechts een aan.
              </div>
            )}
            {list.map((b) => (
              <Link key={b.id} href={`/buildings/${b.id}`} className="card" style={{ padding: "1rem 1.1rem", display: "block" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div>
                    <strong style={{ color: "var(--ink)" }}>{b.name}</strong>
                    {b.address && (
                      <div className="muted" style={{ fontSize: "0.82rem" }}>{b.address}</div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className={`badge badge-${b.tier}`}>{TIER_LABELS[b.tier]}</span>
                    {b.requires_audit && <span className="badge badge-audit">Audit</span>}
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* Nieuw gebouw */}
          <form action={createBuilding} className="card" style={{ padding: "1.2rem" }}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Nieuw gebouw</h2>
            <div style={{ marginBottom: "0.8rem" }}>
              <label className="label" htmlFor="name">Naam</label>
              <input className="input" id="name" name="name" required placeholder="Résidence Al Andalous" />
            </div>
            <div style={{ marginBottom: "0.8rem" }}>
              <label className="label" htmlFor="address">Adres</label>
              <input className="input" id="address" name="address" placeholder="Tanger" />
            </div>
            <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.8rem" }}>
              <div style={{ flex: 1 }}>
                <label className="label" htmlFor="tier">Tier</label>
                <select className="input" id="tier" name="tier" defaultValue="klein">
                  <option value="klein">Klein</option>
                  <option value="midden">Midden</option>
                  <option value="groot">Groot</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label" htmlFor="total_tantiemes">Tantièmes</label>
                <input className="input" id="total_tantiemes" name="total_tantiemes" type="number" defaultValue={1000} min={1} />
              </div>
            </div>
            <div style={{ marginBottom: "1.1rem" }}>
              <label className="label" htmlFor="default_language">Taal</label>
              <select className="input" id="default_language" name="default_language" defaultValue="fr">
                <option value="fr">Frans</option>
                <option value="ar">Arabisch</option>
                <option value="nl">Nederlands</option>
                <option value="en">Engels</option>
              </select>
            </div>
            <button className="btn btn-primary" style={{ width: "100%" }}>Gebouw aanmaken</button>
            <p className="muted" style={{ fontSize: "0.72rem", marginTop: "0.7rem", marginBottom: 0 }}>
              Later leidt het systeem het tier automatisch af uit de opgeroepen lasten.
            </p>
          </form>
        </div>
      </main>
    </>
  );
}

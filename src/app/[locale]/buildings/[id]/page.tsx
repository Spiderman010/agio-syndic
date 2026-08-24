import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import { Link } from "@/navigation";
import { createUnit, createOwner, assignOwner, updateBankInfo } from "./actions";
import ActionForm from "@/components/ActionForm";
import { TIER_LABELS, TIER_ANNEXES } from "@/lib/tier";
import type { Building, Owner } from "@/lib/types";

type UnitRow = {
  id: string;
  label: string;
  unit_type: string;
  tantiemes: number;
  ownership: { id: string; end_date: string | null; owners: { id: string; full_name: string } | null }[];
};

export default async function BuildingDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { org } = await requireOrg();
  const supabase = await createClient();

  const { data: building } = await supabase.from("buildings").select("*").eq("id", id).maybeSingle();
  if (!building) notFound();
  const b = building as Building;

  const { data: unitsData } = await supabase
    .from("units")
    .select("id, label, unit_type, tantiemes, ownership(id, end_date, owners(id, full_name))")
    .eq("building_id", id)
    .order("label", { ascending: true });
  const units = (unitsData ?? []) as unknown as UnitRow[];

  const { data: ownersData } = await supabase
    .from("owners")
    .select("*")
    .order("full_name", { ascending: true });
  const owners = (ownersData ?? []) as Owner[];

  const sumTantiemes = units.reduce((s, u) => s + (u.tantiemes ?? 0), 0);
  const annexes = TIER_ANNEXES[b.tier];

  const currentOwner = (u: UnitRow) => {
    const active = u.ownership?.find((o) => o.end_date === null && o.owners);
    return active?.owners?.full_name ?? null;
  };

  return (
    <>
      <TopBar orgName={org.name} />
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1.6rem 1.3rem 4rem" }}>
        <Link href="/buildings" className="muted" style={{ fontSize: "0.82rem" }}>
          ← Tous les bâtiments
        </Link>

        <div className="card" style={{ padding: "1.3rem 1.4rem", margin: "0.7rem 0 1.4rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div>
              <h1 style={{ margin: "0 0 0.2rem", fontSize: "1.5rem" }}>{b.name}</h1>
              {b.address && <div className="muted" style={{ fontSize: "0.9rem" }}>{b.address}</div>}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Link href={`/buildings/${id}/expenses`} className="btn" style={{ fontSize: "0.82rem", padding: "0.3rem 0.7rem" }}>
                Dépenses →
              </Link>
              <Link href={`/buildings/${id}/boekjaren`} className="btn" style={{ fontSize: "0.82rem", padding: "0.3rem 0.7rem" }}>
                Exercices →
              </Link>
              <span className={`badge badge-${b.tier}`}>Tier: {TIER_LABELS[b.tier]}</span>
              {b.requires_audit && <span className="badge badge-audit">Audit requis</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: "1.6rem", marginTop: "1rem", flexWrap: "wrap", fontSize: "0.85rem" }}>
            <div>
              <div className="label" style={{ marginBottom: 2 }}>Annexes obligatoires</div>
              <div>{annexes.join(" · ")}</div>
            </div>
            <div>
              <div className="label" style={{ marginBottom: 2 }}>Tantièmes répartis</div>
              <div style={{ color: sumTantiemes === b.total_tantiemes ? "var(--good)" : "var(--warn)" }}>
                {sumTantiemes} / {b.total_tantiemes}
                {sumTantiemes !== b.total_tantiemes && " ⚠"}
              </div>
            </div>
          </div>
        </div>

        {/* Bankgegevens */}
        <div className="card" style={{ padding: "1.1rem 1.4rem", marginBottom: "1.4rem" }}>
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.8rem" }}>Coordonnées bancaires</h2>
          <ActionForm action={updateBankInfo} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "0.7rem", alignItems: "end" }}>
            <input type="hidden" name="building_id" value={b.id} />
            <div>
              <label className="label" htmlFor="bank_name">Banque</label>
              <input className="input" id="bank_name" name="bank_name" defaultValue={b.bank_name ?? ""} placeholder="ex. Attijariwafa Bank" />
            </div>
            <div>
              <label className="label" htmlFor="bank_rib">RIB / IBAN</label>
              <input className="input" id="bank_rib" name="bank_rib" defaultValue={b.bank_rib ?? ""} placeholder="007 780 0001234567890123 56" />
            </div>
            <button className="btn btn-primary" style={{ whiteSpace: "nowrap" }}>Enregistrer</button>
          </ActionForm>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: "1.4rem", alignItems: "start" }}>
          {/* Units */}
          <section>
            <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.7rem" }}>Lots ({units.length})</h2>
            <div style={{ display: "grid", gap: "0.6rem" }}>
              {units.length === 0 && (
                <div className="card muted" style={{ padding: "1rem", fontSize: "0.88rem" }}>Aucun lot.</div>
              )}
              {units.map((u) => (
                <div key={u.id} className="card" style={{ padding: "0.85rem 1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <div>
                      <strong>{u.label}</strong>
                      <span className="muted" style={{ fontSize: "0.8rem", marginLeft: 8 }}>
                        {u.unit_type} · {u.tantiemes} tantièmes
                      </span>
                    </div>
                    <div style={{ fontSize: "0.82rem" }}>
                      {currentOwner(u) ? (
                        <span>{currentOwner(u)}</span>
                      ) : (
                        <span className="muted">sans propriétaire</span>
                      )}
                    </div>
                  </div>
                  {!currentOwner(u) && owners.length > 0 && (
                    <ActionForm action={assignOwner} style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <input type="hidden" name="building_id" value={b.id} />
                      <input type="hidden" name="unit_id" value={u.id} />
                      <select className="input" name="owner_id" style={{ fontSize: "0.82rem", padding: "0.35rem 0.5rem" }}>
                        {owners.map((o) => (
                          <option key={o.id} value={o.id}>{o.full_name}</option>
                        ))}
                      </select>
                      <button className="btn" style={{ padding: "0.35rem 0.7rem", fontSize: "0.8rem" }}>Affecter</button>
                    </ActionForm>
                  )}
                </div>
              ))}
            </div>

            <ActionForm action={createUnit} className="card" style={{ padding: "1.1rem", marginTop: "0.9rem" }}>
              <input type="hidden" name="building_id" value={b.id} />
              <h3 style={{ fontSize: "0.92rem", margin: "0 0 0.8rem" }}>Ajouter un lot</h3>
              <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.7rem" }}>
                <div style={{ flex: 1 }}>
                  <label className="label" htmlFor="label">Label</label>
                  <input className="input" id="label" name="label" required placeholder="Appt 3B" />
                </div>
                <div style={{ width: 120 }}>
                  <label className="label" htmlFor="tantiemes">Tantièmes</label>
                  <input className="input" id="tantiemes" name="tantiemes" type="number" min={0} defaultValue={0} />
                </div>
              </div>
              <div style={{ marginBottom: "0.9rem" }}>
                <label className="label" htmlFor="unit_type">Type</label>
                <select className="input" id="unit_type" name="unit_type" defaultValue="appartement">
                  <option value="appartement">Appartement</option>
                  <option value="commerce">Commerce</option>
                  <option value="parking">Parking</option>
                  <option value="cave">Cave</option>
                  <option value="autre">Autre</option>
                </select>
              </div>
              <button className="btn btn-primary" style={{ width: "100%" }}>Ajouter</button>
            </ActionForm>
          </section>

          {/* Eigenaars */}
          <section>
            <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.7rem" }}>Propriétaires ({owners.length})</h2>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {owners.length === 0 && (
                <div className="card muted" style={{ padding: "1rem", fontSize: "0.88rem" }}>Aucun propriétaire.</div>
              )}
              {owners.map((o) => (
                <div key={o.id} className="card" style={{ padding: "0.7rem 0.9rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{o.full_name}</span>
                  {o.is_mre && <span className="badge badge-midden">MRE</span>}
                </div>
              ))}
            </div>

            <ActionForm action={createOwner} className="card" style={{ padding: "1.1rem", marginTop: "0.9rem" }}>
              <input type="hidden" name="building_id" value={b.id} />
              <h3 style={{ fontSize: "0.92rem", margin: "0 0 0.8rem" }}>Ajouter un propriétaire</h3>
              <div style={{ marginBottom: "0.7rem" }}>
                <label className="label" htmlFor="full_name">Nom complet</label>
                <input className="input" id="full_name" name="full_name" required placeholder="Youssef El Amrani" />
              </div>
              <div style={{ marginBottom: "0.7rem" }}>
                <label className="label" htmlFor="email">E-mail</label>
                <input className="input" id="email" name="email" type="email" />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.85rem", marginBottom: "0.9rem" }}>
                <input type="checkbox" name="is_mre" /> Réside à l'étranger (MRE)
              </label>
              <button className="btn btn-primary" style={{ width: "100%" }}>Ajouter</button>
            </ActionForm>
          </section>
        </div>
      </main>
    </>
  );
}

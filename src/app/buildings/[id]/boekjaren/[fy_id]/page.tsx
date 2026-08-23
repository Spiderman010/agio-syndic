import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import TopBar from "@/components/TopBar";
import { createChargeCall, createPayment } from "../actions";
import type { Building, FiscalYear, Owner } from "@/lib/types";

type AllocRow = {
  id: string;
  amount: number;
  settled_amount: number;
  owner_id: string | null;
  units: { label: string } | null;
  owners: { full_name: string } | null;
};

type CallRow = {
  id: string;
  type: string;
  period: string | null;
  label: string | null;
  total_amount: number;
  call_date: string;
  due_date: string | null;
  charge_allocations: AllocRow[];
};

type PayRow = {
  id: string;
  amount: number;
  method: string;
  value_date: string;
  reference: string | null;
  owners: { full_name: string } | null;
  payment_allocations: {
    amount: number;
    charge_allocations: {
      amount: number;
      settled_amount: number;
      charge_calls: { period: string | null; label: string | null; due_date: string | null } | null;
      units: { label: string } | null;
    } | null;
  }[];
};

function fmt(n: number) {
  return n.toLocaleString("fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusKleur(open: number, dueDate: string | null): string {
  if (open <= 0) return "var(--good)";
  if (dueDate && new Date(dueDate) < new Date()) return "var(--crit)";
  return "var(--warn)";
}

export default async function FiscalYearDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; fy_id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id: buildingId, fy_id: fyId } = await params;
  const { error } = await searchParams;
  const { org } = await requireOrg();
  const supabase = await createClient();

  // Building + boekjaar
  const [{ data: bData }, { data: fyData }] = await Promise.all([
    supabase.from("buildings").select("*").eq("id", buildingId).maybeSingle(),
    supabase.from("fiscal_years").select("*").eq("id", fyId).maybeSingle(),
  ]);
  if (!bData || !fyData) notFound();
  const b = bData as Building;
  const fy = fyData as FiscalYear;

  // Lastenoproepen met allocaties
  const { data: callsData } = await supabase
    .from("charge_calls")
    .select(`
      id, type, period, label, total_amount, call_date, due_date,
      charge_allocations(
        id, amount, settled_amount, owner_id,
        units(label),
        owners(full_name)
      )
    `)
    .eq("fiscal_year_id", fyId)
    .order("call_date", { ascending: false });
  const calls = (callsData ?? []) as unknown as CallRow[];

  // Eigenaars voor dit gebouw (via units)
  const { data: unitIds } = await supabase
    .from("units")
    .select("id")
    .eq("building_id", buildingId);

  const { data: ownershipData } = await supabase
    .from("ownership")
    .select("owners(id, full_name)")
    .in("unit_id", (unitIds ?? []).map((u: { id: string }) => u.id))
    .is("end_date", null);

  const eigenaarMap = new Map<string, string>();
  for (const row of ownershipData ?? []) {
    // Supabase typt to-one FK-joins soms als array; normaliseer naar enkel object
    const rawOwner = row.owners as { id: string; full_name: string }[] | { id: string; full_name: string } | null;
    const o = Array.isArray(rawOwner) ? (rawOwner[0] ?? null) : rawOwner;
    if (o) eigenaarMap.set(o.id, o.full_name);
  }
  const eigenaars = Array.from(eigenaarMap.entries()).map(([id, full_name]) => ({ id, full_name }));

  // Betalingen (laatste 20)
  const { data: paysData } = await supabase
    .from("payments")
    .select(`
      id, amount, method, value_date, reference,
      owners(full_name),
      payment_allocations(
        amount,
        charge_allocations(
          amount, settled_amount,
          charge_calls(period, label, due_date),
          units(label)
        )
      )
    `)
    .eq("building_id", buildingId)
    .order("value_date", { ascending: false })
    .limit(20);
  const pays = (paysData ?? []) as unknown as PayRow[];

  // Saldo per eigenaar
  const callIds = calls.map((c) => c.id);
  let saldoRows: {
    ownerId: string;
    naam: string;
    opgeroepen: number;
    voldaan: number;
    teLaat: number;
  }[] = [];

  if (callIds.length > 0) {
    const { data: allocData } = await supabase
      .from("charge_allocations")
      .select("amount, settled_amount, owner_id, owners(id, full_name), charge_calls(due_date)")
      .in("charge_call_id", callIds)
      .not("owner_id", "is", null);

    const saldoMap = new Map<string, { naam: string; opgeroepen: number; voldaan: number; teLaat: number }>();
    for (const row of allocData ?? []) {
      // Supabase typt to-one FK-joins soms als array; normaliseer naar enkel object
      const rawOwner = row.owners as { id: string; full_name: string }[] | { id: string; full_name: string } | null;
      const owner = Array.isArray(rawOwner) ? (rawOwner[0] ?? null) : rawOwner;
      if (!owner) continue;
      const rawCc = row.charge_calls as { due_date: string | null }[] | { due_date: string | null } | null;
      const cc = Array.isArray(rawCc) ? (rawCc[0] ?? null) : rawCc;
      const open = Number(row.amount) - Number(row.settled_amount);
      const teLaat =
        cc?.due_date && new Date(cc.due_date) < new Date() && open > 0 ? open : 0;

      const existing = saldoMap.get(owner.id) ?? { naam: owner.full_name, opgeroepen: 0, voldaan: 0, teLaat: 0 };
      existing.opgeroepen += Number(row.amount);
      existing.voldaan += Number(row.settled_amount);
      existing.teLaat += teLaat;
      saldoMap.set(owner.id, existing);
    }
    saldoRows = Array.from(saldoMap.entries())
      .map(([ownerId, v]) => ({ ownerId, ...v }))
      .sort((a, b) => (b.opgeroepen - b.voldaan) - (a.opgeroepen - a.voldaan));
  }

  const totalOpgeroepen = calls.reduce((s, c) => s + Number(c.total_amount), 0);

  return (
    <>
      <TopBar orgName={org.name} />
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1.6rem 1.3rem 4rem" }}>
        {/* Breadcrumb */}
        <div style={{ fontSize: "0.82rem", display: "flex", gap: 6, alignItems: "center" }} className="muted">
          <Link href="/buildings" className="muted">Gebouwen</Link>
          <span>/</span>
          <Link href={`/buildings/${buildingId}`} className="muted">{b.name}</Link>
          <span>/</span>
          <Link href={`/buildings/${buildingId}/boekjaren`} className="muted">Boekjaren</Link>
          <span>/</span>
          <span style={{ color: "var(--ink)" }}>Boekjaar {fy.year}</span>
        </div>

        {/* Header */}
        <div className="card" style={{ padding: "1.1rem 1.4rem", margin: "0.7rem 0 1.4rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ margin: "0 0 0.15rem", fontSize: "1.4rem" }}>Boekjaar {fy.year}</h1>
            <div className="muted" style={{ fontSize: "0.83rem" }}>
              {b.name} · {fy.start_date} → {fy.end_date}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {totalOpgeroepen > 0 && (
              <span style={{ fontWeight: 600, fontSize: "1.05rem" }}>{fmt(totalOpgeroepen)} MAD opgeroepen</span>
            )}
            <span className={`badge ${fy.status === "open" ? "badge-klein" : "badge-midden"}`}>
              {fy.status === "open" ? "Open" : "Gesloten"}
            </span>
          </div>
        </div>

        {error && (
          <p style={{ background: "#f6e3e1", color: "var(--crit)", padding: "0.6rem 0.8rem", borderRadius: 8, fontSize: "0.85rem", marginBottom: "1rem" }}>
            {error}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: "1.4rem", alignItems: "start" }}>

          {/* ── LINKERKOLOM: Lastenoproepen ── */}
          <div>
            {/* ───── Lastenoproepen lijst ───── */}
            <section>
              <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>
                Lastenoproepen ({calls.length})
              </h2>

              {calls.length === 0 && (
                <div className="card muted" style={{ padding: "1rem", fontSize: "0.88rem" }}>
                  Nog geen lastenoproepen.
                </div>
              )}

              <div style={{ display: "grid", gap: "0.7rem" }}>
                {calls.map((cc) => {
                  const telaat = cc.due_date && new Date(cc.due_date) < new Date();
                  return (
                    <div key={cc.id} className="card" style={{ padding: "0.9rem 1rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.97rem" }}>
                            {cc.label ?? (cc.period ? `Lastenoproep ${cc.period}` : `Lastenoproep ${cc.call_date}`)}
                          </div>
                          <div className="muted" style={{ fontSize: "0.78rem", marginTop: 2 }}>
                            {cc.type === "exceptionnel" ? "Uitzonderlijk" : "Regulier"}
                            {cc.period && ` · ${cc.period}`}
                            {" · "}Datum: {cc.call_date}
                            {cc.due_date && ` · Vervaldatum: `}
                            {cc.due_date && (
                              <span style={{ color: telaat ? "var(--crit)" : undefined }}>
                                {cc.due_date}{telaat ? " ⚠ te laat" : ""}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: "1rem" }}>{fmt(Number(cc.total_amount))} MAD</div>
                        </div>
                      </div>

                      {/* Verdeling per unit */}
                      {cc.charge_allocations.length > 0 && (
                        <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--line)", paddingTop: "0.6rem" }}>
                          <div className="label" style={{ marginBottom: "0.35rem" }}>Verdeling per unit</div>
                          <div style={{ display: "grid", gap: "0.3rem" }}>
                            {cc.charge_allocations.map((ca) => {
                              const open = Number(ca.amount) - Number(ca.settled_amount);
                              return (
                                <div key={ca.id} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", alignItems: "center" }}>
                                  <span>
                                    <strong>{ca.units?.label ?? "—"}</strong>
                                    {ca.owners && <span className="muted"> · {ca.owners.full_name}</span>}
                                  </span>
                                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                    <span style={{ fontWeight: 600 }}>{fmt(Number(ca.amount))} MAD</span>
                                    {open <= 0 ? (
                                      <span style={{ color: "var(--good)", fontSize: "0.72rem", fontWeight: 600 }}>✓ betaald</span>
                                    ) : (
                                      <span style={{ color: statusKleur(open, cc.due_date), fontSize: "0.72rem", fontWeight: 600 }}>
                                        {fmt(open)} open
                                      </span>
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ───── Nieuwe lastenoproep ───── */}
            {fy.status === "open" && (
              <form action={createChargeCall} className="card" style={{ padding: "1.1rem 1.2rem", marginTop: "0.9rem" }}>
                <input type="hidden" name="building_id" value={buildingId} />
                <input type="hidden" name="fiscal_year_id" value={fyId} />
                <h3 style={{ fontSize: "0.92rem", margin: "0 0 0.9rem" }}>Lastenoproep toevoegen</h3>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem", marginBottom: "0.7rem" }}>
                  <div>
                    <label className="label" htmlFor="cc_type">Type</label>
                    <select className="input" id="cc_type" name="type" defaultValue="regulier">
                      <option value="regulier">Regulier</option>
                      <option value="exceptionnel">Uitzonderlijk</option>
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="period">Periode</label>
                    <input className="input" id="period" name="period" placeholder="bv. Q1 2026" />
                  </div>
                </div>

                <div style={{ marginBottom: "0.7rem" }}>
                  <label className="label" htmlFor="cc_label">Label (optioneel)</label>
                  <input className="input" id="cc_label" name="label" placeholder="Onderhoud lift Q2" />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.7rem", marginBottom: "0.9rem" }}>
                  <div>
                    <label className="label" htmlFor="total_amount">Bedrag (MAD)</label>
                    <input className="input" id="total_amount" name="total_amount" type="text" placeholder="1200.00" required />
                  </div>
                  <div>
                    <label className="label" htmlFor="call_date">Oproepdatum</label>
                    <input className="input" id="call_date" name="call_date" type="date" required />
                  </div>
                  <div>
                    <label className="label" htmlFor="due_date">Vervaldatum</label>
                    <input className="input" id="due_date" name="due_date" type="date" />
                  </div>
                </div>

                <button className="btn btn-primary" style={{ width: "100%" }}>
                  Lastenoproep aanmaken
                </button>
              </form>
            )}
          </div>

          {/* ── RECHTERKOLOM: Betalingen + Saldo ── */}
          <div style={{ display: "grid", gap: "1.4rem" }}>

            {/* ───── Betaling registreren ───── */}
            <section id="betalingen">
              <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>Betalingen</h2>

              {pays.length === 0 && (
                <div className="card muted" style={{ padding: "0.8rem 1rem", fontSize: "0.85rem", marginBottom: "0.7rem" }}>
                  Nog geen betalingen.
                </div>
              )}

              <div style={{ display: "grid", gap: "0.55rem" }}>
                {pays.map((p) => {
                  return (
                    <div key={p.id} className="card" style={{ padding: "0.75rem 0.9rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                            {p.owners?.full_name ?? "—"}
                          </div>
                          <div className="muted" style={{ fontSize: "0.76rem" }}>
                            {p.value_date} · {p.method}{p.reference ? ` · ${p.reference}` : ""}
                          </div>
                        </div>
                        <div style={{ fontWeight: 700, color: "var(--good)", fontSize: "0.95rem" }}>
                          +{fmt(Number(p.amount))} MAD
                        </div>
                      </div>
                      {p.payment_allocations.length > 0 && (
                        <div style={{ marginTop: "0.5rem", borderTop: "1px solid var(--line)", paddingTop: "0.4rem" }}>
                          {p.payment_allocations.map((pa, i) => {
                            const ca = pa.charge_allocations;
                            if (!ca) return null;
                            const periode = ca.charge_calls?.period ?? ca.charge_calls?.label ?? "—";
                            return (
                              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.76rem", color: "var(--ink-soft)" }}>
                                <span>{ca.units?.label ?? "?"} · {periode}</span>
                                <span>{fmt(Number(pa.amount))} MAD</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {fy.status === "open" && eigenaars.length > 0 && (
                <form action={createPayment} className="card" style={{ padding: "1rem 1.1rem", marginTop: "0.7rem" }}>
                  <input type="hidden" name="building_id" value={buildingId} />
                  <input type="hidden" name="fiscal_year_id" value={fyId} />
                  <h3 style={{ fontSize: "0.88rem", margin: "0 0 0.75rem" }}>Betaling registreren</h3>

                  <div style={{ marginBottom: "0.6rem" }}>
                    <label className="label" htmlFor="owner_id">Eigenaar</label>
                    <select className="input" id="owner_id" name="owner_id" required>
                      {eigenaars.map((o) => (
                        <option key={o.id} value={o.id}>{o.full_name}</option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", marginBottom: "0.6rem" }}>
                    <div>
                      <label className="label" htmlFor="pay_amount">Bedrag (MAD)</label>
                      <input className="input" id="pay_amount" name="amount" type="text" placeholder="300.00" required />
                    </div>
                    <div>
                      <label className="label" htmlFor="value_date">Datum</label>
                      <input className="input" id="value_date" name="value_date" type="date" required />
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", marginBottom: "0.75rem" }}>
                    <div>
                      <label className="label" htmlFor="method">Methode</label>
                      <select className="input" id="method" name="method" defaultValue="virement">
                        <option value="virement">Virement</option>
                        <option value="especes">Espèces</option>
                        <option value="cheque">Chèque</option>
                        <option value="carte">Carte</option>
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="reference">Referentie</label>
                      <input className="input" id="reference" name="reference" placeholder="VIR-2026-001" />
                    </div>
                  </div>

                  <button className="btn btn-primary" style={{ width: "100%" }}>Betaling registreren</button>
                </form>
              )}
            </section>

            {/* ───── Saldo-overzicht per eigenaar ───── */}
            <section>
              <h2 style={{ fontSize: "1.05rem", margin: "0 0 0.7rem" }}>Saldo per eigenaar</h2>

              {saldoRows.length === 0 && (
                <div className="card muted" style={{ padding: "0.8rem 1rem", fontSize: "0.85rem" }}>
                  Nog geen lastenoproepen of geen eigenaars gekoppeld.
                </div>
              )}

              {saldoRows.length > 0 && (
                <div className="card" style={{ overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.83rem" }}>
                    <thead>
                      <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--line)" }}>
                        <th style={{ textAlign: "left", padding: "0.55rem 0.8rem", fontWeight: 600, color: "var(--ink-faint)", fontSize: "0.72rem", textTransform: "uppercase" }}>Eigenaar</th>
                        <th style={{ textAlign: "right", padding: "0.55rem 0.6rem", fontWeight: 600, color: "var(--ink-faint)", fontSize: "0.72rem", textTransform: "uppercase" }}>Opgeroepen</th>
                        <th style={{ textAlign: "right", padding: "0.55rem 0.6rem", fontWeight: 600, color: "var(--ink-faint)", fontSize: "0.72rem", textTransform: "uppercase" }}>Voldaan</th>
                        <th style={{ textAlign: "right", padding: "0.55rem 0.8rem", fontWeight: 600, color: "var(--ink-faint)", fontSize: "0.72rem", textTransform: "uppercase" }}>Open</th>
                      </tr>
                    </thead>
                    <tbody>
                      {saldoRows.map((row, i) => {
                        const open = row.opgeroepen - row.voldaan;
                        const volledigBetaald = open <= 0.001;
                        return (
                          <tr
                            key={row.ownerId}
                            style={{ borderBottom: i < saldoRows.length - 1 ? "1px solid var(--line)" : "none" }}
                          >
                            <td style={{ padding: "0.55rem 0.8rem" }}>
                              <div style={{ fontWeight: 500 }}>{row.naam}</div>
                              {row.teLaat > 0 && (
                                <div style={{ color: "var(--crit)", fontSize: "0.72rem", fontWeight: 600 }}>
                                  {fmt(row.teLaat)} MAD te laat
                                </div>
                              )}
                            </td>
                            <td style={{ textAlign: "right", padding: "0.55rem 0.6rem" }}>
                              {fmt(row.opgeroepen)}
                            </td>
                            <td style={{ textAlign: "right", padding: "0.55rem 0.6rem", color: "var(--good)" }}>
                              {fmt(row.voldaan)}
                            </td>
                            <td style={{ textAlign: "right", padding: "0.55rem 0.8rem", fontWeight: 600 }}>
                              <span style={{ color: volledigBetaald ? "var(--good)" : row.teLaat > 0 ? "var(--crit)" : "var(--warn)" }}>
                                {volledigBetaald ? "✓" : fmt(open)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: "2px solid var(--line)", background: "var(--surface-2)" }}>
                        <td style={{ padding: "0.6rem 0.8rem", fontWeight: 700, fontSize: "0.85rem" }}>Totaal</td>
                        <td style={{ textAlign: "right", padding: "0.6rem 0.6rem", fontWeight: 700 }}>
                          {fmt(saldoRows.reduce((s, r) => s + r.opgeroepen, 0))}
                        </td>
                        <td style={{ textAlign: "right", padding: "0.6rem 0.6rem", fontWeight: 700, color: "var(--good)" }}>
                          {fmt(saldoRows.reduce((s, r) => s + r.voldaan, 0))}
                        </td>
                        <td style={{ textAlign: "right", padding: "0.6rem 0.8rem", fontWeight: 700 }}>
                          {fmt(saldoRows.reduce((s, r) => s + (r.opgeroepen - r.voldaan), 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

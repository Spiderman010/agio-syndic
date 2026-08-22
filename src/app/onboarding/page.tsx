import { redirect } from "next/navigation";
import { getActiveOrg } from "@/lib/org";
import { createOrganization } from "./actions";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const active = await getActiveOrg();
  if (active) redirect("/buildings");

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <div className="card" style={{ width: "100%", maxWidth: 440, padding: "2rem" }}>
        <h1 style={{ margin: "0 0 0.3rem", fontSize: "1.4rem" }}>Welkom bij Agio Syndic</h1>
        <p className="muted" style={{ margin: "0 0 1.4rem", fontSize: "0.9rem" }}>
          Maak je organisatie (syndickantoor) aan om te beginnen.
        </p>

        {error && (
          <p
            style={{
              background: "#f6e3e1",
              color: "var(--crit)",
              padding: "0.6rem 0.8rem",
              borderRadius: 8,
              fontSize: "0.85rem",
              margin: "0 0 1rem",
            }}
          >
            {error}
          </p>
        )}

        <form action={createOrganization}>
          <div style={{ marginBottom: "1.2rem" }}>
            <label className="label" htmlFor="name">
              Naam organisatie
            </label>
            <input className="input" id="name" name="name" required placeholder="bv. Agio Syndic Tanger" />
          </div>
          <button className="btn btn-primary" style={{ width: "100%" }}>
            Aanmaken en starten
          </button>
        </form>
      </div>
    </main>
  );
}

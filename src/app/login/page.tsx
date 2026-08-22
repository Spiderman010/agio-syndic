import { signIn, signUp } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <div className="card" style={{ width: "100%", maxWidth: 400, padding: "2rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: "var(--primary)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
            }}
          >
            A
          </div>
          <strong style={{ fontSize: "1.05rem" }}>Agio Syndic</strong>
        </div>
        <p className="muted" style={{ margin: "0 0 1.4rem", fontSize: "0.9rem" }}>
          Log in of maak een beheerdersaccount aan.
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
        {message && (
          <p
            style={{
              background: "var(--good-soft)",
              color: "var(--good)",
              padding: "0.6rem 0.8rem",
              borderRadius: 8,
              fontSize: "0.85rem",
              margin: "0 0 1rem",
            }}
          >
            {message}
          </p>
        )}

        <form>
          <div style={{ marginBottom: "0.9rem" }}>
            <label className="label" htmlFor="email">
              E-mail
            </label>
            <input className="input" id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div style={{ marginBottom: "1.2rem" }}>
            <label className="label" htmlFor="password">
              Wachtwoord
            </label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              required
              minLength={6}
              autoComplete="current-password"
            />
          </div>
          <div style={{ display: "grid", gap: "0.6rem" }}>
            <button className="btn btn-primary" formAction={signIn}>
              Inloggen
            </button>
            <button className="btn" formAction={signUp}>
              Account aanmaken
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

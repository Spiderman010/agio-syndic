import { Link } from "@/navigation";
import { signOut } from "@/app/[locale]/login/actions";
import LanguageSwitcher from "@/components/LanguageSwitcher";

export default function TopBar({ orgName }: { orgName: string }) {
  return (
    <header style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
      <div
        style={{
          maxWidth: 1000,
          margin: "0 auto",
          padding: "0.8rem 1.3rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Link href="/buildings" style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "var(--primary)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
              fontSize: "0.9rem",
            }}
          >
            A
          </span>
          <strong style={{ color: "var(--ink)" }}>Agio Syndic</strong>
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <LanguageSwitcher />
          <span className="muted" style={{ fontSize: "0.85rem" }}>{orgName}</span>
          <form action={signOut}>
            <button className="btn" style={{ padding: "0.4rem 0.8rem", fontSize: "0.82rem" }}>
              Déconnexion
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

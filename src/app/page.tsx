import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) redirect("/buildings");

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <div className="card" style={{ maxWidth: 460, padding: "2.4rem", textAlign: "center" }}>
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            background: "var(--primary)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontWeight: 800,
            fontSize: "1.4rem",
            margin: "0 auto 1rem",
          }}
        >
          A
        </div>
        <h1 style={{ margin: "0 0 0.4rem", fontSize: "1.6rem", letterSpacing: "-0.02em" }}>
          Agio Syndic
        </h1>
        <p className="muted" style={{ margin: "0 0 1.6rem" }}>
          Syndic-software voor de Marokkaanse markt — conform Décret 2.23.700.
        </p>
        <Link href="/login" className="btn btn-primary" style={{ width: "100%" }}>
          Inloggen / account aanmaken
        </Link>
      </div>
    </main>
  );
}

import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import AppShell from "@/components/shell/AppShell";
import type { SwitcherBuilding } from "@/components/shell/BuildingSwitcher";

/**
 * Layout voor alle ingelogde routes.
 *
 * De routegroep `(app)` verandert niets aan de URL's — `/fr/buildings` blijft
 * `/fr/buildings` — maar geeft alle schermen achter de login één gedeelde
 * schil. Login en onboarding vallen er bewust buiten: die horen geen navigatie
 * te tonen naar een organisatie die er nog niet is.
 *
 * De organisatie en de gebouwenlijst worden hier ÉÉN keer opgehaald, niet per
 * pagina. De gebouwenlijst is dezelfde query die het overzichtsscherm al deed;
 * er komt dus geen nieuwe queryarchitectuur bij, alleen een gedeelde plek.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { org } = await requireOrg();
  const supabase = await createClient();

  const { data } = await supabase
    .from("buildings")
    .select("id, name, address")
    .order("name", { ascending: true });

  const buildings = (data ?? []) as SwitcherBuilding[];

  return (
    <AppShell orgName={org.name} buildings={buildings}>
      {children}
    </AppShell>
  );
}

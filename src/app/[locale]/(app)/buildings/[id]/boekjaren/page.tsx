import { ArrowRight } from "lucide-react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
      {/* De terugkoppeling naar het gebouw zit nu in de broodkruimels van de
          schil; een tweede "← naam" erboven zou hetzelfde twee keer zeggen. */}
      <h1 className="mt-0 mb-0 text-2xl font-semibold text-ink">{t("title")}</h1>
      <p className="muted mt-1 mb-0 text-[0.9rem]">{b.name}</p>

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
                <Link key={fy.id} href={`/buildings/${id}/boekjaren/${fy.id}`} className="block no-underline">
                  {/* `flex-wrap` met `justify-between`: op 360px past jaar +
                      periode + bedrag + status + pijl niet op één regel, en
                      zonder wrap schoof de rechterhelft de pagina uit. Nu zakt
                      die helft naar een tweede regel — hetzelfde patroon als in
                      `components/ui/Card.tsx`. `min-w-0` laat de linkerhelft
                      krimpen in plaats van te duwen. */}
                  <div className="card flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-4 sm:px-5">
                    <div className="min-w-0">
                      <strong className="text-[1.05rem]">{t("title")} {fy.year}</strong>
                      {/* De periode is een bereik van twee ISO-datums. In een
                          RTL-alinea zijn dat twee losse cijferreeksen die het
                          bidi-algoritme van rechts naar links ordent: begin en
                          einde wisselen dan van plaats. `dir="ltr"` houdt het
                          bereik leesbaar; `text-start` laat het blok zelf wel
                          met de leesrichting meelopen. */}
                      <div className="muted mt-0.5 text-[0.8rem] text-start" dir="ltr">
                        {fy.start_date} → {fy.end_date}
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {totaal > 0 && (
                        <span className="text-[0.9rem] font-semibold">
                          {totaal.toLocaleString("fr-MA", { minimumFractionDigits: 2 })} {t("called")}
                        </span>
                      )}
                      <span className={`badge ${fy.status === "open" ? "badge-klein" : "badge-midden"}`}>
                        {fy.status === "open" ? t("status.open") : t("status.closed")}
                      </span>
                      {/* Dezelfde detailpijl als in de broodkruimels en op het
                          dashboard: een logisch icoon dat in RTL meedraait. De
                          losse "→" deed dat niet en wees in het Arabisch de
                          verkeerde kant op. */}
                      <ArrowRight className="size-4 shrink-0 text-ink-faint rtl:rotate-180" aria-hidden="true" />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

      <BoekjaarForm buildingId={b.id} existingYears={existingYears} huidigJaar={huidigJaar} />
    </>
  );
}

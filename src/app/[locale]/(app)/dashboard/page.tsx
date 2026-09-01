import { getTranslations } from "next-intl/server";
import { ArrowRight } from "lucide-react";
import { requireOrg } from "@/lib/org";
import { createClient } from "@/lib/supabase/server";
import { Link } from "@/navigation";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import type { Building } from "@/lib/types";

/**
 * Dashboard — landingsscherm binnen de schil.
 *
 * BEWUST GEEN KPI'S. Sprint 1 levert het fundament; cijfers vragen om
 * rapportageviews die er nog niet zijn, en een dashboard met geschatte of
 * verzonnen getallen is erger dan een dashboard zonder getallen.
 *
 * Wat hier wél staat is echte, al bestaande informatie: welke gebouwen er zijn
 * en hoe je er komt. Het aantal gebouwen is een telling, geen metriek.
 */
export default async function DashboardPage() {
  const { org } = await requireOrg();
  const t = await getTranslations("dashboard");
  const supabase = await createClient();

  const { data } = await supabase
    .from("buildings")
    .select("id, name, address, tier, requires_audit")
    .order("name", { ascending: true });

  const buildings = (data ?? []) as Pick<
    Building,
    "id" | "name" | "address" | "tier" | "requires_audit"
  >[];

  return (
    <>
      <h1 className="mt-0 mb-1 text-2xl font-semibold text-ink">
        {t("title")}
      </h1>
      <p className="mt-0 mb-6 text-[0.9rem] text-ink-soft">
        {t("subtitle", { org: org.name })}
      </p>

      {buildings.length === 0 ? (
        <Card className="text-center">
          <h2 className="mt-0 mb-1.5 text-base font-semibold text-ink">
            {t("empty.title")}
          </h2>
          <p className="mx-auto mb-4 max-w-prose text-[0.9rem] text-ink-soft">
            {t("empty.body")}
          </p>
          <Link href="/buildings" className={buttonClasses("primary", "md")}>
            {t("empty.cta")}
          </Link>
        </Card>
      ) : (
        <section aria-labelledby="dashboard-buildings">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2
              id="dashboard-buildings"
              className="m-0 text-base font-semibold text-ink"
            >
              {t("buildings.title")}
            </h2>
            <Link
              href="/buildings"
              className="inline-flex items-center gap-1 text-[0.82rem] text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
            >
              {t("buildings.all", { count: buildings.length })}
              <ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden="true" />
            </Link>
          </div>

          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
            {buildings.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/buildings/${b.id}`}
                  className="card block h-full p-4 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <strong className="block truncate text-ink">
                        {b.name}
                      </strong>
                      {b.address ? (
                        <span className="block truncate text-[0.8rem] text-ink-soft">
                          {b.address}
                        </span>
                      ) : null}
                    </div>
                    {b.requires_audit ? (
                      <Badge tone="crit">{t("buildings.audit")}</Badge>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

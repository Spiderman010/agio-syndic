"use client";

import { useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { Link } from "@/navigation";
import type { Crumb } from "@/lib/nav";

/**
 * Broodkruimels.
 *
 * De kruimels zelf worden afgeleid in `@/lib/nav` (pure functie, getest); deze
 * component doet alleen de weergave en de vertaling.
 *
 * Het scheidingsteken is een icoon met `aria-hidden`, want een schermlezer moet
 * de structuur uit de `<ol>` halen en niet uit voorgelezen pijltjes. In RTL
 * draait het icoon mee via `rtl:rotate-180`.
 */
export default function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const t = useTranslations("nav");
  if (crumbs.length === 0) return null;

  return (
    <nav aria-label={t("breadcrumb")} data-testid="breadcrumbs" className="min-w-0">
      <ol className="m-0 flex min-w-0 list-none items-center gap-1 p-0 text-[0.8rem]">
        {crumbs.map((crumb, i) => {
          const label = crumb.text ?? (crumb.labelKey ? t(crumb.labelKey) : "");
          const isLast = i === crumbs.length - 1;
          return (
            <li key={`${crumb.labelKey ?? "text"}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 ? (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-ink-faint rtl:rotate-180"
                />
              ) : null}
              {crumb.href && !isLast ? (
                <Link
                  href={crumb.href}
                  className="truncate text-ink-soft no-underline hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
                >
                  {label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className="truncate font-medium text-ink"
                >
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

"use client";

import { useTranslations } from "next-intl";
import {
  Blocks,
  Building2,
  CalendarRange,
  ClipboardList,
  KeyRound,
  LayoutDashboard,
  LayoutList,
  ReceiptText,
  Users,
} from "lucide-react";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { isNavItemActive, type NavIcon, type NavItem } from "@/lib/nav";

/**
 * Navigatielijst, gedeeld door de vaste sidebar en de mobiele lade.
 *
 * Eén component voor beide zodat de actieve staat, de vertaling en de
 * toegankelijkheidsattributen niet op twee plaatsen uit elkaar kunnen lopen.
 */

const ICONS: Record<NavIcon, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  buildings: Building2,
  overview: LayoutList,
  fiscalYears: CalendarRange,
  expenses: ReceiptText,
  owners: Users,
  lots: KeyRound,
  layout: Blocks,
  setup: ClipboardList,
};

export default function NavList({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  /** Sluit de mobiele lade zodra er genavigeerd wordt. */
  onNavigate?: () => void;
}) {
  const t = useTranslations("nav");

  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {items.map((item) => {
        const active = isNavItemActive(pathname, item);
        const Icon = ICONS[item.icon];
        return (
          <li key={item.key}>
            <Link
              href={item.href}
              onClick={onNavigate}
              // `aria-current="page"` is wat een schermlezer voorleest; de
              // kleur alleen is voor een deel van de gebruikers onzichtbaar.
              aria-current={active ? "page" : undefined}
              data-testid={`nav-${item.key}`}
              data-active={active ? "true" : "false"}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[0.875rem] no-underline",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]",
                active
                  ? "bg-primary-soft font-semibold text-primary"
                  : "font-medium text-ink-soft hover:bg-surface-2 hover:text-ink",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {/* `min-w-0` + `truncate`: lange Franse labels mogen de sidebar
                  niet oprekken en zeker geen horizontale overflow geven. */}
              <span className="min-w-0 truncate">{t(item.labelKey)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

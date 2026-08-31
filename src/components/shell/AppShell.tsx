"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { LogOut, Menu, X } from "lucide-react";
import { Link, usePathname } from "@/navigation";
import { signOut } from "@/app/[locale]/login/actions";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import NavList from "@/components/shell/NavList";
import Breadcrumbs from "@/components/shell/Breadcrumbs";
import BuildingSwitcher, {
  type SwitcherBuilding,
} from "@/components/shell/BuildingSwitcher";
import {
  buildBreadcrumbs,
  buildingNavItems,
  currentBuildingId,
  globalNavItems,
} from "@/lib/nav";

/**
 * Applicatieschil voor alle ingelogde routes.
 *
 * Client component omdat de actieve navigatiestaat, de gebouwcontext en de
 * mobiele lade allemaal van het pad of van lokale state afhangen. De pagina's
 * zelf blijven server components: ze worden als `children` doorgegeven en zijn
 * al op de server gerenderd voordat deze component ze plaatst.
 *
 * Layout: de sidebar staat `fixed` en de contentkolom krijgt een
 * marge-inline-start ter grootte van de sidebar. Dat is bewust geen CSS-grid —
 * met een grid zou elke pagina die een brede tabel bevat de kolom kunnen
 * oprekken; met een vaste sidebar plus marge kan dat niet, en blijft de belofte
 * "geen horizontale paginaoverflow" afdwingbaar.
 */
export default function AppShell({
  orgName,
  buildings,
  children,
}: {
  orgName: string;
  buildings: SwitcherBuilding[];
  children: React.ReactNode;
}) {
  const t = useTranslations("shell");
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const buildingId = currentBuildingId(pathname);
  const building = buildings.find((b) => b.id === buildingId) ?? null;
  const crumbs = buildBreadcrumbs({
    pathname,
    orgName,
    buildingName: building?.name ?? null,
  });

  // De lade sluit bij navigatie. Zonder dit blijft hij op mobiel openstaan over
  // het scherm waar je net naartoe bent gegaan — ook bij een terugknop, waar
  // de onClick op de links niet afgaat.
  //
  // Bewust GEEN useEffect: state aanpassen tijdens de render is het patroon dat
  // React hiervoor voorschrijft. Een effect zou een tweede render veroorzaken
  // waarin de lade nog even open staat over het nieuwe scherm.
  const [pathAtRender, setPathAtRender] = useState(pathname);
  if (pathname !== pathAtRender) {
    setPathAtRender(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  // Escape sluit, focus keert terug naar de knop die de lade opende, en de
  // pagina eronder scrollt niet mee zolang de lade open is.
  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawerRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  const navContent = (onNavigate?: () => void) => (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
      <div>
        <p className="label mb-2">{t("organisation")}</p>
        <p className="m-0 truncate text-[0.9rem] font-semibold text-ink">
          {orgName}
        </p>
      </div>

      <NavList
        items={globalNavItems()}
        pathname={pathname}
        onNavigate={onNavigate}
      />

      <div className="flex flex-col gap-2">
        <p className="label m-0">{t("building")}</p>
        <BuildingSwitcher
          buildings={buildings}
          currentId={buildingId}
          onNavigate={onNavigate}
        />
        {buildingId ? (
          <NavList
            items={buildingNavItems(buildingId)}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-ground">
      {/* Overslaan-naar-inhoud: zichtbaar zodra hij focus krijgt. Zonder deze
          link moet een toetsenbordgebruiker elke navigatie-item passeren. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-white"
      >
        {t("skipToContent")}
      </a>

      {/* ── Sidebar, alleen desktop ───────────────────────────────────────── */}
      <aside
        aria-label={t("mainNav")}
        data-testid="sidebar"
        className="fixed inset-y-0 start-0 z-20 hidden w-[var(--shell-sidebar)] flex-col gap-5 border-e border-line bg-surface p-4 lg:flex"
      >
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-[0.85rem] font-extrabold text-white">
            A
          </span>
          <strong className="truncate text-ink">Agio Syndic</strong>
        </Link>
        {navContent()}
      </aside>

      {/* ── Contentkolom ──────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-col lg:ms-[var(--shell-sidebar)]">
        <header className="sticky top-0 z-10 flex h-[var(--shell-topbar)] items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("openMenu")}
            aria-expanded={drawerOpen}
            data-testid="menu-button"
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-strong bg-surface text-ink-soft hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] lg:hidden"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>

          {/* Onder 640px is er geen ruimte voor een kruimelspoor naast de
              menuknop, de taalwissel en afmelden; alles zou tot een paar tekens
              worden afgekapt. De context staat op mobiel al in de H1 van de
              pagina en in de lade, dus het spoor is daar overbodig. */}
          <div className="hidden min-w-0 flex-1 sm:block">
            <Breadcrumbs crumbs={crumbs} />
          </div>
          <div className="flex-1 sm:hidden" />

          <div className="flex shrink-0 items-center gap-2">
            <LanguageSwitcher />
            <form action={signOut}>
              <button
                type="submit"
                aria-label={t("signOut")}
                className="btn grid size-9 place-items-center p-0 text-[0.78rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] sm:flex sm:size-auto sm:px-2.5 sm:py-1.5"
              >
                <LogOut className="size-4 sm:hidden" aria-hidden="true" />
                <span className="hidden sm:inline">{t("signOut")}</span>
              </button>
            </form>
          </div>
        </header>

        <main
          id="main-content"
          className="mx-auto w-full min-w-0 max-w-5xl px-3 pt-5 pb-16 sm:px-5"
        >
          {children}
        </main>
      </div>

      {/* ── Mobiele lade ──────────────────────────────────────────────────── */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label={t("closeMenu")}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default border-0 bg-black/40 p-0"
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("mainNav")}
            data-testid="mobile-drawer"
            tabIndex={-1}
            className="absolute inset-y-0 start-0 flex w-[min(20rem,85vw)] flex-col gap-5 border-e border-line bg-surface p-4 shadow-xl focus:outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-semibold text-ink">Agio Syndic</span>
              <button
                type="button"
                onClick={() => {
                  setDrawerOpen(false);
                  menuButtonRef.current?.focus();
                }}
                aria-label={t("closeMenu")}
                data-testid="drawer-close"
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-strong text-ink-soft hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {navContent(() => setDrawerOpen(false))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

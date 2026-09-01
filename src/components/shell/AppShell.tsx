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
  const drawerRef = useRef<HTMLDialogElement>(null);
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

  /**
   * De lade is een native <dialog> die met showModal() wordt geopend.
   *
   * Daarmee levert de BROWSER de drie dingen die een handgeschreven overlay niet
   * betrouwbaar krijgt: de top layer, een echt inerte achtergrond (alles buiten
   * de dialoog is niet klikbaar én niet focusbaar) en een focus trap waar Tab en
   * Shift+Tab niet uit ontsnappen. Escape komt er gratis bij.
   *
   * Dit is hetzelfde patroon dat ReversalDialog al gebruikt; er zit geen eigen
   * toetsenbordafhandeling meer in dit bestand.
   *
   * De React-state blijft leidend voor "moet hij open zijn", dit effect
   * synchroniseert de DOM ernaartoe. De `open`-controle voorkomt dat een
   * hernieuwde render showModal() een tweede keer aanroept (dat gooit).
   */
  useEffect(() => {
    const dialog = drawerRef.current;
    if (!dialog) return;
    if (drawerOpen && !dialog.open) dialog.showModal();
    else if (!drawerOpen && dialog.open) dialog.close();
  }, [drawerOpen]);

  /**
   * Scrollvergrendeling van de pagina eronder.
   *
   * Browsers doen dit voor een modale <dialog> grotendeels zelf, maar niet
   * overal even consistent. Dit blijft daarom expliciet: het is de garantie die
   * de vorige versie ook al gaf, en hij is goedkoop.
   */
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  /**
   * Boven de lg-grens bestaat de menuknop niet meer en staat de vaste sidebar er
   * al. Een openstaande modale lade zou dan de hele pagina inert houden zonder
   * dat de gebruiker begrijpt waarom. Sluiten dus, zodra het scherm groeit.
   */
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    function onChange(e: MediaQueryListEvent | MediaQueryList) {
      if (e.matches) setDrawerOpen(false);
    }
    onChange(query);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  /**
   * Eén sluitpad voor alle sluitpaden.
   *
   * Het `close`-event van <dialog> vuurt ongeacht de oorzaak: Escape, onze eigen
   * close(), of de achtergrondklik. Door de focus hier te herstellen in plaats
   * van bij elke knop apart, kan geen enkel pad het vergeten — dat was precies
   * de fout in de vorige versie, waar de achtergrondklik de focus liet vallen.
   *
   * De zichtbaarheidscontrole is nodig omdat de menuknop boven 1024px verborgen
   * is; focus zetten op een onzichtbare knop zou de focus laten verdwijnen.
   */
  function handleDialogClose() {
    setDrawerOpen(false);
    const button = menuButtonRef.current;
    if (button && getComputedStyle(button).display !== "none") button.focus();
  }

  /**
   * Een klik op de ::backdrop van een modale <dialog> heeft de dialoog zelf als
   * target; een klik op de inhoud heeft een kind als target. Dat onderscheid is
   * genoeg om "buiten geklikt" te herkennen zonder een eigen overlay-element.
   */
  function handleDialogClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === drawerRef.current) setDrawerOpen(false);
  }

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
            aria-haspopup="dialog"
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

      {/* ── Mobiele lade ──────────────────────────────────────────────────────
          Native <dialog>: geen eigen overlay-element en geen `role`/`aria-modal`
          meer. Beide zijn impliciet zodra de dialoog met showModal() opengaat,
          en de browser maakt de achtergrond dan werkelijk inert in plaats van
          het alleen aan te kondigen. De ::backdrop komt uit globals.css.
          De dialoog blijft in de DOM staan; alleen zijn open-state wisselt. */}
      <dialog
        ref={drawerRef}
        aria-label={t("mainNav")}
        data-testid="mobile-drawer"
        onClose={handleDialogClose}
        onClick={handleDialogClick}
        className="nav-drawer"
      >
        {/* De inhoud bestaat alleen zolang de lade open is. Het <dialog> zelf
            blijft staan omdat de ref hem nodig heeft, maar de navigatie twee
            keer in de DOM hebben — één keer in de sidebar, één keer hier —
            zou de organisatienaam, de gebouwkiezer en elk menu-item dubbel
            aankondigen aan een schermlezer. */}
        {drawerOpen ? (
          <div className="flex h-full flex-col gap-5 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-semibold text-ink">Agio Syndic</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label={t("closeMenu")}
                data-testid="drawer-close"
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-strong text-ink-soft hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {navContent(() => setDrawerOpen(false))}
          </div>
        ) : null}
      </dialog>
    </div>
  );
}

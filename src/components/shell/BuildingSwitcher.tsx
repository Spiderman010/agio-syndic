"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown } from "lucide-react";
import { Link, usePathname } from "@/navigation";
import { cn } from "@/lib/utils";

export type SwitcherBuilding = { id: string; name: string; address: string | null };

/**
 * Gebouwkiezer.
 *
 * Wisselen HERSCHRIJFT HET PAD: het `[id]`-segment wordt vervangen terwijl de
 * huidige sectie behouden blijft, zodat je vanaf de uitgaven van gebouw A op de
 * uitgaven van gebouw B landt in plaats van terug bij het begin. De scope zit
 * dus in de URL en niet in serverstate — meerdere tabbladen blijven daardoor
 * onafhankelijk werken en een link blijft deelbaar.
 *
 * Bewust een eigen knop-plus-lijst in plaats van een componentbibliotheek: het
 * is één interactiepatroon en een Radix-afhankelijkheid toevoegen voor deze ene
 * plek is duurder dan de handvol regels hieronder.
 *
 * SEMANTIEK: dit is een DISCLOSURE, geen ARIA-menu. Een `role="menu"` verplicht
 * tot pijltoetsnavigatie, roving tabindex en focusbeheer bij openen; dat was
 * niet geïmplementeerd, en een half menupatroon is voor een schermlezer erger
 * dan geen menupatroon — hij kondigt gedrag aan dat er niet is. Wat er wél is,
 * is een knop met `aria-expanded` die een lijst met links toont. Dat is precies
 * wat `aria-expanded` + `<ul>` + `<a>` uitdrukt, en Tab werkt er vanzelf in.
 * Het actieve gebouw draagt `aria-current`, zodat het ook zonder kleur en
 * zonder het (decoratieve) vinkje herkenbaar is.
 */
export default function BuildingSwitcher({
  buildings,
  currentId,
  onNavigate,
}: {
  buildings: SwitcherBuilding[];
  currentId: string | null;
  onNavigate?: () => void;
}) {
  const t = useTranslations("shell");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const menuId = useId();

  const current = buildings.find((b) => b.id === currentId) ?? null;

  // Sluiten bij Escape (focus terug naar de knop) en bij een klik buiten het
  // menu. Zonder deze twee blijft het menu op mobiel open hangen achter de lade.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointer(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  /**
   * Het pad van het huidige scherm, maar dan voor een ander gebouw.
   * `/buildings/A/expenses` -> `/buildings/B/expenses`.
   * De detailpagina van een boekjaar hoort NIET mee te verhuizen: dat boekjaar
   * bestaat niet bij het andere gebouw. Daarom kappen we af op de sectie.
   */
  function hrefFor(id: string): string {
    const segments = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (segments[0] !== "buildings" || !segments[1]) return `/buildings/${id}`;
    const section = segments[2];
    if (section === "boekjaren" || section === "expenses") {
      return `/buildings/${id}/${section}`;
    }
    return `/buildings/${id}`;
  }

  if (buildings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-[0.8rem] text-ink-soft">
        {t("noBuildings")}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={menuId}
        data-testid="building-switcher"
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-start",
          "hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.875rem] font-semibold text-ink">
            {current ? current.name : t("allBuildings")}
          </span>
          {current?.address ? (
            <span className="block truncate text-[0.72rem] text-ink-soft">
              {current.address}
            </span>
          ) : null}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-ink-faint" />
      </button>

      {open ? (
        <ul
          id={menuId}
          aria-label={t("switchBuilding")}
          data-testid="building-switcher-list"
          className={cn(
            "absolute start-0 z-30 m-0 mt-1 w-full list-none overflow-hidden rounded-lg border border-line bg-surface p-0 shadow-lg",
            "max-h-72 overflow-y-auto",
          )}
        >
          {buildings.map((b) => {
            const isCurrent = b.id === currentId;
            return (
              <li key={b.id}>
                <Link
                  href={hrefFor(b.id)}
                  // Het vinkje is decoratief; dit is wat een schermlezer hoort.
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => {
                    setOpen(false);
                    onNavigate?.();
                  }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 text-[0.85rem] no-underline",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)]",
                    isCurrent
                      ? "bg-primary-soft font-semibold text-primary"
                      : "text-ink-soft hover:bg-surface-2",
                  )}
                >
                  <Check
                    className={cn("size-4 shrink-0", !isCurrent && "opacity-0")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{b.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

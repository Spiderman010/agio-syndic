import { cn } from "@/lib/utils";

/**
 * Tabelschil.
 *
 * De hele applicatie bevat vandaag één enkele `<table>`, opgebouwd uit een
 * twintigtal inline stijlen. Deze schil is het gedeelde alternatief en lost
 * meteen het responsive-probleem op: een brede tabel scrollt HORIZONTAAL IN
 * ZIJN EIGEN CONTAINER, zodat de pagina zelf nooit zijwaarts scrollt. Dat is
 * de enige plek in de app waar horizontaal scrollen is toegestaan.
 *
 * `tabular-nums` staat op de tabel omdat vrijwel elke kolom in dit product een
 * bedrag in MAD is; zonder uitgelijnde cijfers is een bedragenkolom onleesbaar.
 */

export default function Table({
  caption,
  className,
  children,
}: {
  /** Toegankelijke omschrijving; visueel verborgen maar wel voorgelezen. */
  caption?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "card overflow-x-auto",
        // De container is focusbaar zodat een toetsenbordgebruiker een brede
        // tabel ook zonder muis horizontaal kan scrollen.
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]",
        className,
      )}
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full border-collapse text-[0.875rem] [font-variant-numeric:tabular-nums]">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

/** Kopcel. `scope="col"` is verplicht: zonder scope kan een schermlezer de
 *  kolomkop niet aan de datacel koppelen. */
export function Th({
  className,
  align = "start",
  children,
  ...rest
}: Omit<React.ThHTMLAttributes<HTMLTableCellElement>, "align"> & {
  /** Logische uitlijning; `start`/`end` volgen de leesrichting, dus in het
   *  Arabisch spiegelt een bedragenkolom automatisch mee. Het ingebouwde
   *  `align`-attribuut kent alleen left/right en wordt daarom weggelaten. */
  align?: "start" | "end";
}) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap border-b border-line-strong bg-surface-2 px-3 py-2",
        "text-[0.7rem] font-semibold tracking-wider text-ink-soft uppercase",
        align === "end" ? "text-end" : "text-start",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({
  className,
  align = "start",
  children,
  ...rest
}: Omit<React.TdHTMLAttributes<HTMLTableCellElement>, "align"> & {
  align?: "start" | "end";
}) {
  return (
    <td
      className={cn(
        "border-b border-line px-3 py-2 align-top",
        align === "end" ? "text-end" : "text-start",
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

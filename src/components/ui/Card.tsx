import { cn } from "@/lib/utils";

/**
 * Kaartoppervlak.
 *
 * Gebruikt de bestaande `.card`-klasse voor achtergrond, rand, radius en
 * schaduw; die klasse wordt al op 32 plaatsen in de app gebruikt en blijft
 * daarmee de enige definitie. Deze component voegt alleen padding en een
 * optionele kop toe, zodat nieuwe schermen niet opnieuw een padding-waarde
 * hoeven te verzinnen.
 */

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  padded?: boolean;
};

export default function Card({
  padded = true,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div className={cn("card", padded && "p-4 sm:p-5", className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * Kop binnen een kaart: titel links, acties aan de eindzijde.
 * `justify-between` met flex-wrap houdt lange Franse labels leesbaar op 360px,
 * en werkt in RTL zonder aanpassing omdat er geen links/rechts in zit.
 */
export function CardHeader({
  title,
  actions,
  className,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-3 flex flex-wrap items-center justify-between gap-2",
        className,
      )}
    >
      <h2 className="m-0 text-base font-semibold text-ink">{title}</h2>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

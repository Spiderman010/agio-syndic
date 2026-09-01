import { cn } from "@/lib/utils";

/**
 * Knop.
 *
 * Vorm en kleur komen uit de bestaande projectklassen (`btn`, `btn-primary`,
 * `btn-danger` in globals.css), niet uit een nieuwe set Tailwind-utilities.
 * Daarmee ziet een knop in de nieuwe schil er exact zo uit als een knop op de
 * bestaande schermen, en verandert een latere restyling beide tegelijk.
 *
 * Tailwind wordt hier alleen gebruikt voor wat de projectklassen niet dekken:
 * maat en breedte. `buttonClasses` bestaat apart zodat een `<Link>` er precies
 * zo uit kan zien als een `<button>` zonder de knop in een link te wikkelen.
 */

export type ButtonVariant = "primary" | "secondary" | "danger";
export type ButtonSize = "sm" | "md";

const SIZE: Record<ButtonSize, string> = {
  sm: "text-[0.8rem] px-3 py-1.5",
  md: "text-[0.9rem] px-4 py-2",
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "",
  danger: "btn-danger",
};

export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(
    "btn",
    VARIANT[variant],
    SIZE[size],
    // De projectklasse `.btn` zet zelf geen zichtbare focusring; toetsenbord-
    // navigatie door de schil moet altijd zichtbaar zijn.
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]",
    className,
  );
}

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
};

export default function Button({
  variant = "secondary",
  size = "md",
  fullWidth = false,
  className,
  type = "button",
  ...rest
}: Props) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, cn(fullWidth && "w-full", className))}
      {...rest}
    />
  );
}

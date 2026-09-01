import { cn } from "@/lib/utils";

/**
 * Statuslabel.
 *
 * Vorm (pil, formaat, gewicht) komt uit de bestaande `.badge`-klasse. De toon
 * gebruikt de Tailwind-tokens die op hun beurt naar dezelfde CSS-variabelen
 * verwijzen als de bestaande `badge-*`-varianten.
 *
 * Bewust GEEN vervanging van `badge-klein`, `badge-betaald`, `badge-storno` en
 * de andere domeinvarianten: die dragen betekenis (tier, betaalstatus, storno)
 * en horen bij hun eigen scherm. Deze component is de generieke variant voor
 * nieuwe, niet-domeinspecifieke labels in de schil.
 */

export type BadgeTone = "neutral" | "good" | "warn" | "crit" | "info";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-ink-soft border-line-strong",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  crit: "bg-crit-soft text-crit",
  info: "bg-primary-soft text-primary",
};

export default function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  return <span className={cn("badge", TONE[tone], className)}>{children}</span>;
}

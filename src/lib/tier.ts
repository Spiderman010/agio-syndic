import type { SyndicTier } from "./types";

// Deterministische tier-afleiding uit opgeroepen lasten per jaar (MAD).
// Conform Décret 2.23.700. Auditplicht boven 1.000.000 MAD (aparte vlag).
export function deriveTier(calledChargesPerYear: number): SyndicTier {
  if (calledChargesPerYear >= 500000) return "groot";
  if (calledChargesPerYear > 200000) return "midden";
  return "klein";
}

export function requiresAudit(calledChargesPerYear: number): boolean {
  return calledChargesPerYear > 1000000;
}

export const TIER_LABELS: Record<SyndicTier, string> = {
  klein: "Klein",
  midden: "Midden",
  groot: "Groot",
};

// Verplichte bijlagen per tier (referentie; DB blijft de bron van waarheid).
export const TIER_ANNEXES: Record<SyndicTier, string[]> = {
  klein: ["10", "13-1", "13-2"],
  midden: ["10", "11", "12"],
  groot: ["3", "4", "5", "6", "7", "8", "9", "10"],
};

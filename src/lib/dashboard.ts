import { isReversed, netTotal, type ReversalIndex } from "@/lib/reversal";

/**
 * Rekenkern van het financiële dashboard.
 *
 * Dit bestand bevat GEEN React en GEEN databasetoegang: alles is een pure
 * functie over rijen die de pagina al heeft opgehaald. Dat is bewust — de
 * bedragen op dit scherm moeten tot op de cent kloppen, en pure functies zijn de
 * enige vorm waarin dat volledig te testen is zonder database of DOM.
 *
 * ── WAAROM DEZE BRONNEN ────────────────────────────────────────────────────
 *
 * APPELÉ en RESTANT DÛ komen uit `charge_allocations` (via
 * `v_settlement_integrity`, die dezelfde kolommen draagt plus de
 * integriteitsvlag), niet uit `charge_calls.total_amount`. Twee redenen: de
 * allocatie is de rij waar de DEBITEURENPOSITIE aan hangt, en `settled_amount`
 * staat er direct naast, zodat appelé en restant dû per definitie uit dezelfde
 * rijverzameling komen en niet uit elkaar kunnen lopen. Wijkt de som van de
 * allocaties af van het opgeroepen totaal, dan is dat een integriteitsprobleem
 * dat `v_allocation_integrity` al signaleert — het wordt getoond, niet stil
 * gecorrigeerd.
 *
 * ENCAISSÉ en DÉPENSES zijn NETTO en gebruiken `netTotal()` uit
 * `@/lib/reversal`, dezelfde functie waarmee het uitgavenscherm zijn totaal al
 * berekent. Bruto sommeren is aantoonbaar fout: bij één storno en één correctie
 * van 1000 naar 800 telt bruto 3800 waar de economische positie 1800 is.
 *
 * ── WAAROM RESTANT DÛ NOOIT NEGATIEF IS ────────────────────────────────────
 *
 * Afgedwongen door de database, niet aangenomen:
 *   charge_allocations_check                 CHECK (settled_amount <= amount)
 *   charge_allocations_settled_amount_check  CHECK (settled_amount >= 0)
 * Per allocatie geldt dus 0 <= amount - settled_amount <= amount. Een
 * overbetaling kan `settled_amount` niet boven `amount` duwen; het meerdere
 * landt op 4419 (vooruitontvangen) en raakt de vordering niet.
 */

/** Rij uit `v_settlement_integrity`. */
export type SettlementRow = {
  charge_allocation_id: string;
  building_id: string | null;
  owner_id: string | null;
  amount: number | string;
  settled_amount: number | string;
  ok: boolean;
};

export type MoneyRow = {
  id: string;
  amount: number | string;
  building_id: string | null;
};

export type Kpis = {
  /** Totaal opgeroepen (som van de allocaties). */
  appele: number;
  /** Netto ontvangen: gestorneerde betalingen tellen niet, correcties wel. */
  encaisse: number;
  /** Openstaande debiteurenpositie; nooit negatief (zie CHECK hierboven). */
  restant: number;
  /** Netto uitgegeven, zelfde storno-semantiek als encaissé. */
  depenses: number;
  /**
   * Inningsgraad in procenten, of null wanneer er niets is opgeroepen.
   *
   * Formule: (appelé - restant) / appelé, oftewel het deel van de VORDERINGEN
   * dat is afgeboekt. Bewust niet encaissé/appelé: een overbetaling telt in
   * encaissé volledig mee en zou het percentage boven de 100 tillen, terwijl de
   * metriek "inning van de oproepen" heet. Deze vorm is structureel begrensd op
   * 0–100 omdat settled_amount nooit boven amount kan komen.
   *
   * Null bij appelé = 0: er is dan niets om een percentage van te nemen, en 0%
   * tonen zou suggereren dat er niet is geïnd terwijl er niets is opgeroepen.
   */
  taux: number | null;
};

function num(value: number | string): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Rondt af op centen; voorkomt drijvende-kommaruis in opgetelde bedragen. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeKpis(input: {
  settlements: readonly SettlementRow[];
  payments: readonly MoneyRow[];
  expenses: readonly MoneyRow[];
  reversals: ReversalIndex;
}): Kpis {
  let appele = 0;
  let settled = 0;
  for (const row of input.settlements) {
    appele += num(row.amount);
    settled += num(row.settled_amount);
  }
  appele = cents(appele);
  const restant = cents(appele - cents(settled));

  return {
    appele,
    encaisse: netTotal(input.payments, input.reversals),
    restant,
    depenses: netTotal(input.expenses, input.reversals),
    taux: appele > 0 ? cents(((appele - restant) / appele) * 100) : null,
  };
}

// ── Debiteuren ──────────────────────────────────────────────────────────────

export type Debtor = {
  ownerId: string;
  name: string;
  appele: number;
  settled: number;
  restant: number;
  /** Aantal allocaties met een openstaand restant. */
  openPosten: number;
};

/**
 * Openstaande posities per eigenaar, aflopend op openstaand bedrag.
 *
 * Allocaties zonder `owner_id` worden NIET als eigenaar opgevoerd: dat zou een
 * datagat presenteren als een persoon. Ze komen apart terug in `zonderEigenaar`
 * zodat het dashboard er een signaal van kan maken in plaats van het te
 * verbergen.
 */
export function topDebtors(
  settlements: readonly SettlementRow[],
  ownerNames: ReadonlyMap<string, string>,
  limit = 5,
): { debtors: Debtor[]; zonderEigenaar: number; totaalDebiteuren: number } {
  const perOwner = new Map<string, Debtor>();
  let zonderEigenaar = 0;

  for (const row of settlements) {
    const open = num(row.amount) - num(row.settled_amount);
    if (!row.owner_id) {
      if (open > 0) zonderEigenaar = cents(zonderEigenaar + open);
      continue;
    }
    let entry = perOwner.get(row.owner_id);
    if (!entry) {
      entry = {
        ownerId: row.owner_id,
        name: ownerNames.get(row.owner_id) ?? "",
        appele: 0,
        settled: 0,
        restant: 0,
        openPosten: 0,
      };
      perOwner.set(row.owner_id, entry);
    }
    entry.appele += num(row.amount);
    entry.settled += num(row.settled_amount);
    if (open > 0) entry.openPosten += 1;
  }

  const alle = [...perOwner.values()].map((d) => ({
    ...d,
    appele: cents(d.appele),
    settled: cents(d.settled),
    restant: cents(cents(d.appele) - cents(d.settled)),
  }));

  const metSchuld = alle.filter((d) => d.restant > 0);
  metSchuld.sort((a, b) => b.restant - a.restant || a.name.localeCompare(b.name));

  return {
    debtors: metSchuld.slice(0, limit),
    zonderEigenaar,
    totaalDebiteuren: metSchuld.length,
  };
}

// ── Boekjaarcontext ─────────────────────────────────────────────────────────

export type FiscalYearRow = {
  id: string;
  building_id: string;
  year: number;
  start_date: string;
  end_date: string;
  status: "open" | "closed";
};

export type FiscalYearContext = {
  /** Het boekjaar waarop het dashboard rekent, of null. */
  huidig: FiscalYearRow | null;
  /** Meer dan één open boekjaar binnen de scope: de keuze is dan ambigu. */
  meerdereOpen: boolean;
  aantalOpen: number;
};

/**
 * Kiest het boekjaar waarop het dashboard rekent.
 *
 * Voorkeur: het OPEN boekjaar waarin vandaag valt. Anders het meest recente
 * open jaar. Anders het meest recente jaar überhaupt, zodat een volledig
 * afgesloten gebouw nog steeds cijfers toont in plaats van een leeg scherm.
 *
 * Zijn er meerdere open jaren, dan wordt dat gemeld in plaats van weggepoetst:
 * de keuze is dan een aanname en de gebruiker hoort te weten dat hij die maakt.
 */
export function pickFiscalYear(
  rows: readonly FiscalYearRow[],
  today: string,
): FiscalYearContext {
  const open = rows.filter((r) => r.status === "open");
  const lopend = open.filter((r) => r.start_date <= today && today <= r.end_date);
  const opJaarAflopend = (a: FiscalYearRow, b: FiscalYearRow) => b.year - a.year;

  const huidig =
    [...lopend].sort(opJaarAflopend)[0] ??
    [...open].sort(opJaarAflopend)[0] ??
    [...rows].sort(opJaarAflopend)[0] ??
    null;

  return { huidig, meerdereOpen: open.length > 1, aantalOpen: open.length };
}

// ── Aandachtspunten ─────────────────────────────────────────────────────────

export type AttentionTone = "crit" | "warn" | "info";

export type AttentionItem = {
  key: string;
  /** Vertaalsleutel binnen `dashboard.attention`. */
  labelKey: string;
  tone: AttentionTone;
  /** Waarden voor de interpolatie in de vertaling. */
  values?: Record<string, string | number>;
  /** Locale-loos pad, of null wanneer er geen bestaand scherm voor is. */
  href: string | null;
};

/**
 * Vertaalt meetbare toestanden naar begrijpelijke signalen.
 *
 * De integriteitsviews heten intern `v_settlement_integrity` en dergelijke.
 * Die namen komen hier NIET in de uitvoer: de gebruiker krijgt een
 * productzin, de sleutel verwijst naar de vertaling. Wat er technisch onder
 * ligt hoort in de logs, niet op het scherm.
 */
export function buildAttentionItems(input: {
  restant: number;
  aantalDebiteuren: number;
  zonderEigenaar: number;
  settlementNok: number;
  allocationNok: number;
  reconciliatieVerschil: number;
  meerdereOpenBoekjaren: number;
  buildingHref: string | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Technische integriteit eerst: als de cijfers zelf niet kloppen, is de rest
  // van het dashboard geen betrouwbare basis om op te handelen.
  if (input.settlementNok > 0) {
    items.push({
      key: "settlement",
      labelKey: "settlementMismatch",
      tone: "crit",
      values: { count: input.settlementNok },
      href: null,
    });
  }
  if (input.allocationNok > 0) {
    items.push({
      key: "allocation",
      labelKey: "allocationMismatch",
      tone: "crit",
      values: { count: input.allocationNok },
      href: null,
    });
  }
  if (Math.abs(input.reconciliatieVerschil) > 0.005) {
    items.push({
      key: "reconciliation",
      labelKey: "reconciliationMismatch",
      tone: "crit",
      href: null,
    });
  }
  if (input.zonderEigenaar > 0) {
    items.push({
      key: "orphan",
      labelKey: "allocationWithoutOwner",
      tone: "crit",
      href: null,
    });
  }
  if (input.meerdereOpenBoekjaren > 1) {
    items.push({
      key: "fiscal-years",
      labelKey: "multipleOpenFiscalYears",
      tone: "warn",
      values: { count: input.meerdereOpenBoekjaren },
      href: input.buildingHref ? `${input.buildingHref}/boekjaren` : null,
    });
  }
  if (input.restant > 0) {
    items.push({
      key: "arrears",
      labelKey: "outstanding",
      tone: "warn",
      values: { count: input.aantalDebiteuren },
      href: null,
    });
  }

  return items;
}

// ── Snelkoppelingen ─────────────────────────────────────────────────────────

export type QuickAction = {
  key: string;
  /** Locale-loos pad naar een BESTAAND scherm. */
  href: string;
  /** Vertaalsleutel binnen `dashboard.actions`. */
  labelKey: string;
  /** Muterend: verboden voor een rol zonder schrijfrecht. */
  mutating: boolean;
};

/**
 * Bepaalt welke snelkoppelingen zichtbaar zijn.
 *
 * Twee harde regels, allebei getest:
 *  - alleen paden die als route bestaan (geen dode links);
 *  - geen muterende actie voor wie niet mag schrijven. De database weigert het
 *    sowieso; dit voorkomt dat we een knop tonen waarvan we wéten dat hij faalt.
 *
 * Zonder gebouwcontext is er maar één zinnige stap — naar de gebouwenlijst —
 * want betalingen en uitgaven horen altijd bij één gebouw.
 */
export function quickActions(input: {
  buildingId: string | null;
  fiscalYearId: string | null;
  mayWrite: boolean;
}): QuickAction[] {
  if (!input.buildingId) {
    return [
      { key: "buildings", href: "/buildings", labelKey: "allBuildings", mutating: false },
    ];
  }

  const base = `/buildings/${input.buildingId}`;
  const acties: QuickAction[] = [];

  if (input.mayWrite && input.fiscalYearId) {
    acties.push({
      key: "payment",
      href: `${base}/boekjaren/${input.fiscalYearId}`,
      labelKey: "recordPayment",
      mutating: true,
    });
  }
  if (input.mayWrite) {
    acties.push({
      key: "expense",
      href: `${base}/expenses`,
      labelKey: "addExpense",
      mutating: true,
    });
  }
  acties.push({
    key: "fiscal-years",
    href: `${base}/boekjaren`,
    labelKey: "fiscalYears",
    mutating: false,
  });
  acties.push({
    key: "building",
    href: base,
    labelKey: "manageBuilding",
    mutating: false,
  });

  return acties;
}

// ── Recente financiële activiteit ───────────────────────────────────────────

export type ActivityKind = "payment" | "expense";

export type ActivityRow = {
  id: string;
  kind: ActivityKind;
  date: string;
  amount: number;
  /** Vrije contextregel: leverancier, omschrijving of eigenaarsnaam. */
  context: string;
  /** Deze rij is gestorneerd. */
  reversed: boolean;
  /** Deze rij IS de vervangende rij van een correctie. */
  isCorrection: boolean;
};

/**
 * De laatste financiële gebeurtenissen, betalingen en uitgaven door elkaar,
 * op datum aflopend.
 *
 * Bewust BRUTO: dit is een historielijst, geen totaal. Een gestorneerde
 * betaling hoort zichtbaar te blijven — juist die wil een syndic terugzien —
 * maar dan gemarkeerd. Dat is dezelfde scheiding tussen "wat is er gebeurd" en
 * "wat is de positie" die de rest van de applicatie ook aanhoudt.
 */
export function recentActivity(
  payments: readonly (MoneyRow & { date: string; context: string })[],
  expenses: readonly (MoneyRow & { date: string; context: string })[],
  reversals: ReversalIndex,
  limit = 8,
): ActivityRow[] {
  const rijen: ActivityRow[] = [];

  for (const p of payments) {
    rijen.push({
      id: p.id,
      kind: "payment",
      date: p.date,
      amount: num(p.amount),
      context: p.context,
      reversed: isReversed(reversals, p.id),
      isCorrection: reversals.byCorrection.has(p.id),
    });
  }
  for (const e of expenses) {
    rijen.push({
      id: e.id,
      kind: "expense",
      date: e.date,
      amount: num(e.amount),
      context: e.context,
      reversed: isReversed(reversals, e.id),
      isCorrection: reversals.byCorrection.has(e.id),
    });
  }

  rijen.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rijen.slice(0, limit);
}

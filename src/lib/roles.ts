import type { OrgRole } from "@/lib/types";

/**
 * Rolpredicaten voor de UI.
 *
 * Dit is NADRUKKELIJK geen security boundary. De database beslist: `can_write`
 * en `can_manage_members` draaien SECURITY DEFINER binnen elke RPC en weigeren
 * onafhankelijk van wat de UI toont. Deze helpers bestaan om te voorkomen dat we
 * een knop aanbieden waarvan we zeker weten dat hij zal falen.
 *
 * De twee lijsten spiegelen letterlijk de SQL-definities:
 *   can_write          -> owner, admin, manager, accountant
 *   can_manage_members -> owner, admin
 * Loopt de database uiteen met dit bestand, dan wint de database en ziet de
 * gebruiker een nette foutmelding in plaats van een corrupte toestand.
 */

const WRITE_ROLES: readonly OrgRole[] = ["owner", "admin", "manager", "accountant"];
const MANAGE_ROLES: readonly OrgRole[] = ["owner", "admin"];

export function canWrite(role: OrgRole): boolean {
  return WRITE_ROLES.includes(role);
}

export function canManageMembers(role: OrgRole): boolean {
  return MANAGE_ROLES.includes(role);
}

/**
 * Mag deze rol een financiële transactie storneren of corrigeren?
 *
 * `originalFiscalYearClosed` volgt de regel uit `fn_reversal_authorize`: staat de
 * ORIGINELE journaalpost in een afgesloten boekjaar, dan is het een
 * owner/admin-ingreep; anders volstaat schrijfrecht.
 */
export function canReverse(role: OrgRole, originalFiscalYearClosed: boolean): boolean {
  return originalFiscalYearClosed ? canManageMembers(role) : canWrite(role);
}

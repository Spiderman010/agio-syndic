// Types die het M1-datamodel weerspiegelen (subset).
export type SyndicTier = "klein" | "midden" | "groot";
export type OrgRole = "owner" | "admin" | "manager" | "accountant" | "reader";
export type UnitType =
  | "appartement"
  | "commerce"
  | "parking"
  | "cave"
  | "autre";
export type AppLanguage = "fr" | "ar" | "nl" | "en" | "es" | "ru" | "de";

export type Organization = {
  id: string;
  name: string;
  created_at: string;
};

export type Building = {
  id: string;
  organization_id: string;
  name: string;
  address: string | null;
  tier: SyndicTier;
  tier_auto: boolean;
  requires_audit: boolean;
  total_tantiemes: number;
  default_language: AppLanguage;
  bank_name: string | null;
  bank_rib: string | null;
  created_at: string;
};

export type Unit = {
  id: string;
  building_id: string;
  label: string;
  unit_type: UnitType;
  tantiemes: number;
  floor: string | null;
  area_m2: number | null;
  created_at: string;
};

export type ChargeCallType = "regulier" | "exceptionnel";
export type FiscalYearStatus = "open" | "closed";
export type PaymentMethod = "virement" | "especes" | "cheque" | "carte";

export type FiscalYear = {
  id: string;
  organization_id: string;
  building_id: string;
  year: number;
  start_date: string;
  end_date: string;
  status: FiscalYearStatus;
  created_at: string;
};

export type ChargeCall = {
  id: string;
  organization_id: string;
  fiscal_year_id: string;
  type: ChargeCallType;
  period: string | null;
  label: string | null;
  total_amount: number;
  call_date: string;
  due_date: string | null;
  resolution_ref: string | null;
  created_at: string;
};

export type ChargeAllocation = {
  id: string;
  charge_call_id: string;
  unit_id: string;
  owner_id: string | null;
  amount: number;
  settled_amount: number;
};

export type Payment = {
  id: string;
  organization_id: string;
  building_id: string;
  owner_id: string;
  amount: number;
  method: PaymentMethod;
  value_date: string;
  reference: string | null;
  created_at: string;
};

export type ExpenseCategory = {
  id: string;
  organization_id: string;
  name: string;
  default_account_id: string | null;
};

export type Expense = {
  id: string;
  organization_id: string;
  building_id: string;
  fiscal_year_id: string | null;
  category_id: string | null;
  account_id: string | null;
  supplier: string | null;
  description: string | null;
  amount: number;
  expense_date: string;
  /** Storage-objectpad: {organization_id}/{building_id}/{bestand}. */
  receipt_path: string | null;
  /** DEPRECATED (P0-3): historische signed URL, niet meer vullen. */
  receipt_url: string | null;
  created_at: string;
};

export type Owner = {
  id: string;
  organization_id: string;
  full_name: string;
  is_company: boolean;
  email: string | null;
  phone: string | null;
  is_mre: boolean;
  language: AppLanguage;
  timezone: string;
  created_at: string;
};

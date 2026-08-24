import { z } from "zod";

// Server-side inputvalidatie. Elke server action valideert hiermee vóór de
// database wordt aangeraakt; hidden form fields worden nooit vertrouwd.

const uuid = z.string().uuid("Ongeldige identificatie.");

/**
 * Normaliseert een optioneel formulierveld naar string | null.
 * Vangt zowel een leeg veld ("") als een veld dat helemaal NIET is meegestuurd
 * (undefined) af — dat laatste gebeurt bijvoorbeeld wanneer een select
 * conditioneel niet gerenderd wordt.
 */
const blankToNull = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Optioneel UUID: leeg of ontbrekend veld -> null. */
const optionalUuid = z.preprocess(
  blankToNull,
  z
    .string()
    .uuid("Ongeldige identificatie.")
    .nullable(),
);

/** Optioneel tekstveld: leeg of ontbrekend veld -> null. */
const optionalText = (max: number) =>
  z.preprocess(
    blankToNull,
    z.string().max(max, `Maximaal ${max} tekens.`).nullable(),
  );

/** Optionele ISO-datum: leeg of ontbrekend veld -> null. */
const optionalIsoDate = z.preprocess(
  blankToNull,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Ongeldige datum.")
    .nullable(),
);

/**
 * Bedrag in MAD. Accepteert komma of punt als decimaalteken.
 * Weigert NaN, negatief, nul en onrealistisch grote bedragen.
 */
const amount = z
  .string()
  .trim()
  .min(1, "Bedrag is verplicht.")
  .transform((v) => Number.parseFloat(v.replace(/\s/g, "").replace(",", ".")))
  .refine((n) => Number.isFinite(n), { message: "Bedrag is geen geldig getal." })
  .refine((n) => n > 0, { message: "Bedrag moet groter dan nul zijn." })
  .refine((n) => n <= 1_000_000_000, { message: "Bedrag is onrealistisch hoog." })
  .transform((n) => Math.round(n * 100) / 100);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Ongeldige datum.")
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Ongeldige datum." });

export const tierEnum = z.enum(["klein", "midden", "groot"]);
export const unitTypeEnum = z.enum(["appartement", "commerce", "parking", "cave", "autre"]);
export const languageEnum = z.enum(["fr", "ar", "nl", "en", "es", "ru", "de"]);
export const chargeTypeEnum = z.enum(["regulier", "exceptionnel"]);
export const paymentMethodEnum = z.enum(["virement", "especes", "cheque", "carte"]);

export const organizationSchema = z.object({
  name: z.string().trim().min(1, "Naam is verplicht.").max(200),
});

export const buildingSchema = z.object({
  name: z.string().trim().min(1, "Naam is verplicht.").max(200),
  address: optionalText(300),
  tier: tierEnum.default("klein"),
  total_tantiemes: z.coerce
    .number()
    .int("Tantièmes moeten een geheel getal zijn.")
    .positive("Tantièmes moeten groter dan nul zijn.")
    .max(10_000_000),
  default_language: languageEnum.default("fr"),
});

export const bankInfoSchema = z.object({
  building_id: uuid,
  bank_name: optionalText(120),
  bank_rib: optionalText(60),
});

export const unitSchema = z.object({
  building_id: uuid,
  label: z.string().trim().min(1, "Label is verplicht.").max(80),
  unit_type: unitTypeEnum.default("appartement"),
  tantiemes: z.coerce.number().int().min(0).max(10_000_000),
});

export const ownerSchema = z.object({
  building_id: uuid,
  full_name: z.string().trim().min(1, "Naam is verplicht.").max(200),
  email: z.preprocess(
    blankToNull,
    z.string().email("Ongeldig e-mailadres.").max(200).nullable(),
  ),
  is_mre: z.boolean().default(false),
});

export const assignOwnerSchema = z.object({
  building_id: uuid,
  unit_id: uuid,
  owner_id: uuid,
});

export const fiscalYearSchema = z
  .object({
    building_id: uuid,
    year: z.coerce.number().int().min(2000).max(2100),
    start_date: isoDate,
    end_date: isoDate,
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: "Einddatum moet op of na de startdatum liggen.",
    path: ["end_date"],
  });

export const chargeCallSchema = z
  .object({
    fiscal_year_id: uuid,
    type: chargeTypeEnum.default("regulier"),
    period: optionalText(40),
    label: optionalText(160),
    total_amount: amount,
    call_date: isoDate,
    due_date: optionalIsoDate,
  })
  .refine((v) => v.due_date === null || v.due_date >= v.call_date, {
    message: "Vervaldatum moet op of na de oproepdatum liggen.",
    path: ["due_date"],
  });

export const paymentSchema = z.object({
  building_id: uuid,
  fiscal_year_id: uuid,
  owner_id: uuid,
  amount,
  value_date: isoDate,
  method: paymentMethodEnum.default("virement"),
  reference: optionalText(80),
});

export const expenseSchema = z.object({
  building_id: uuid,
  fiscal_year_id: optionalUuid,
  category_id: optionalUuid,
  supplier: optionalText(200),
  description: optionalText(400),
  amount,
  expense_date: isoDate,
});

export const expenseCategorySchema = z.object({
  building_id: uuid,
  name: z.string().trim().min(1, "Naam is verplicht.").max(120),
});

/**
 * Valideert FormData tegen een schema en geeft óf de geparste waarden óf een
 * enkele, leesbare foutmelding terug.
 */
export function parseForm<T extends z.ZodTypeAny>(
  schema: T,
  formData: FormData,
  overrides: Record<string, unknown> = {},
): { data: z.infer<T>; error?: undefined } | { data?: undefined; error: string } {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;
    raw[key] = value;
  }
  Object.assign(raw, overrides);

  const result = schema.safeParse(raw);
  if (!result.success) {
    return { error: result.error.issues[0]?.message ?? "Ongeldige invoer." };
  }
  return { data: result.data };
}

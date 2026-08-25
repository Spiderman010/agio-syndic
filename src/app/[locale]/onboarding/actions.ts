"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { localeRedirect } from "@/lib/redirect";
import { organizationSchema, parseForm } from "@/lib/validation";
import { toUserError } from "@/lib/errors";

/**
 * Maakt de organisatie aan via de atomische create_organization()-RPC.
 *
 * De RPC voert organisatie -> membership (rol owner) -> PCSI-seed uit binnen
 * één transactie. Losse inserts zijn niet meer mogelijk: de INSERT-policy op
 * `organizations` staat op WITH CHECK (false), zodat er geen weesorganisatie
 * kan ontstaan wanneer een tussenstap faalt.
 */
export async function createOrganization(formData: FormData) {
  const parsed = parseForm(organizationSchema, formData);
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return localeRedirect("/login");

  const { data: orgId, error } = await supabase.rpc("create_organization", {
    org_name: parsed.data.name,
  });

  if (error || !orgId) {
    return { error: toUserError(error, "Aanmaken van de organisatie is mislukt.") };
  }

  revalidatePath("/", "layout");
  return localeRedirect("/buildings");
}

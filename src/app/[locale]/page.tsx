import { redirect } from "@/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveOrg } from "@/lib/org";

/**
 * Instappunt per taal. Blijft een redirect, maar landt nu binnen de schil.
 *
 * De oude versie stuurde iedereen zonder actieve organisatie naar /login,
 * omdat `getActiveOrg()` null teruggeeft in twee heel verschillende gevallen:
 * niet ingelogd, én ingelogd zonder lidmaatschap. Een gebruiker die net een
 * account had aangemaakt zag daardoor opnieuw het loginscherm in plaats van de
 * onboarding. Die twee gevallen worden hier nu uit elkaar gehouden.
 */
export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect({ href: "/login", locale });

  const active = await getActiveOrg();
  redirect({ href: active ? "/dashboard" : "/onboarding", locale });
}

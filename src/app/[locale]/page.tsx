import { redirect } from "@/navigation";
import { getActiveOrg } from "@/lib/org";

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const active = await getActiveOrg();
  redirect({ href: active ? "/buildings" : "/login", locale });
}

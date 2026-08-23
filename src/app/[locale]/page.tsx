import { redirect } from "@/navigation";
import { getActiveOrg } from "@/lib/org";

export default async function LocaleHomePage() {
  const active = await getActiveOrg();
  if (active) redirect("/buildings");
  else redirect("/login");
}

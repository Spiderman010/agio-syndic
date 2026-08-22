"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createOrganization(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect(`/onboarding?error=${encodeURIComponent("Naam is verplicht")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_organization", {
    org_name: name,
  });

  if (error) {
    redirect(`/onboarding?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/buildings");
}

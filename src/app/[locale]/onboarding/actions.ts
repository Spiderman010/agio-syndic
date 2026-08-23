"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "@/navigation";

export async function createOrganization(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Naam verplicht." };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .insert({ name })
    .select("id")
    .single();
  if (orgErr || !org) return { error: orgErr?.message ?? "Aanmaken mislukt." };

  const { error: memErr } = await supabase
    .from("memberships")
    .insert({ org_id: org.id, user_id: user.id, role: "admin" });
  if (memErr) return { error: memErr.message };

  revalidatePath("/", "layout");
  redirect("/buildings");
}

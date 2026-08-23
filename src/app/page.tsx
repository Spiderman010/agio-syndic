import { redirect } from "next/navigation";

// Middleware redirecteert / naar /fr; dit is een vangnet.
export default function RootPage() {
  redirect("/fr");
}

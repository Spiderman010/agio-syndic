"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { createOrganization } from "./actions";
import { useTranslations } from "next-intl";

type ActionState = { error?: string } | null;

export default function OnboardingPage() {
  const t = useTranslations("onboarding");

  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    async (_prev, fd) => createOrganization(fd) as Promise<ActionState>,
    null,
  );

  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <div className="card" style={{ width: "100%", maxWidth: 440, padding: "2rem" }}>
        <h1 style={{ margin: "0 0 0.3rem", fontSize: "1.4rem" }}>{t("title")}</h1>
        <p className="muted" style={{ margin: "0 0 1.4rem", fontSize: "0.9rem" }}>{t("subtitle")}</p>

        <form action={formAction}>
          <div style={{ marginBottom: "1.2rem" }}>
            <label className="label" htmlFor="name">{t("orgName")}</label>
            <input className="input" id="name" name="name" required placeholder="Agio Syndic Tanger" />
          </div>
          <button className="btn btn-primary" style={{ width: "100%" }} disabled={pending}>
            {pending ? "…" : t("createBtn")}
          </button>
        </form>
      </div>
    </main>
  );
}

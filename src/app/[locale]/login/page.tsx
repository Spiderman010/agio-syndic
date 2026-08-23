"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { signIn, signUp } from "./actions";
import { useTranslations } from "next-intl";

type ActionState = { error?: string; success?: string } | null;

export default function LoginPage() {
  const t = useTranslations("auth");

  const [inState, signInAction, signInPending] = useActionState<ActionState, FormData>(
    async (_prev, fd) => signIn(fd) as Promise<ActionState>,
    null,
  );
  const [upState, signUpAction, signUpPending] = useActionState<ActionState, FormData>(
    async (_prev, fd) => signUp(fd) as Promise<ActionState>,
    null,
  );

  useEffect(() => {
    if (inState?.error) toast.error(inState.error);
  }, [inState]);

  useEffect(() => {
    if (upState?.error) toast.error(upState.error);
    if (upState?.success) toast.success(upState.success);
  }, [upState]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <div className="card" style={{ width: "100%", maxWidth: 400, padding: "2rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: "var(--primary)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
            }}
          >
            A
          </div>
          <strong style={{ fontSize: "1.05rem" }}>Agio Syndic</strong>
        </div>
        <p className="muted" style={{ margin: "0 0 1.4rem", fontSize: "0.9rem" }}>
          {t("subtitle")}
        </p>

        <form>
          <div style={{ marginBottom: "0.9rem" }}>
            <label className="label" htmlFor="email">{t("email")}</label>
            <input className="input" id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div style={{ marginBottom: "1.2rem" }}>
            <label className="label" htmlFor="password">{t("password")}</label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              required
              minLength={6}
              autoComplete="current-password"
            />
          </div>
          <div style={{ display: "grid", gap: "0.6rem" }}>
            <button className="btn btn-primary" formAction={signInAction} disabled={signInPending}>
              {signInPending ? "…" : t("signIn")}
            </button>
            <button className="btn" formAction={signUpAction} disabled={signUpPending}>
              {signUpPending ? "…" : t("signUp")}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

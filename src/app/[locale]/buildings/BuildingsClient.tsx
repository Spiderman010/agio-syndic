"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Link } from "@/navigation";
import { createBuilding } from "./actions";
import { useTranslations } from "next-intl";
import type { Building } from "@/lib/types";
import { TIER_LABELS } from "@/lib/tier";
import TopBar from "@/components/TopBar";

type ActionState = { error?: string } | null;

export default function BuildingsClient({
  orgName,
  buildings,
}: {
  orgName: string;
  buildings: Building[];
}) {
  const t = useTranslations("buildings");

  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    async (_prev, fd) => createBuilding(fd) as Promise<ActionState>,
    null,
  );

  useEffect(() => {
    if (state?.error) toast.error(state.error);
  }, [state]);

  return (
    <>
      <TopBar orgName={orgName} />
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1.6rem 1.3rem 4rem" }}>
        <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.2rem" }}>{t("title")}</h1>
        <p className="muted" style={{ margin: "0 0 1.4rem", fontSize: "0.9rem" }}>{t("subtitle")}</p>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: "1.4rem", alignItems: "start" }}>
          <div style={{ display: "grid", gap: "0.7rem" }}>
            {buildings.length === 0 && (
              <div className="card muted" style={{ padding: "1.4rem", fontSize: "0.9rem" }}>{t("noBuildings")}</div>
            )}
            {buildings.map((b) => (
              <Link key={b.id} href={`/buildings/${b.id}`} className="card" style={{ padding: "1rem 1.1rem", display: "block" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div>
                    <strong style={{ color: "var(--ink)" }}>{b.name}</strong>
                    {b.address && <div className="muted" style={{ fontSize: "0.82rem" }}>{b.address}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className={`badge badge-${b.tier}`}>{TIER_LABELS[b.tier]}</span>
                    {b.requires_audit && <span className="badge badge-audit">Audit</span>}
                  </div>
                </div>
              </Link>
            ))}
          </div>

          <form action={formAction} className="card" style={{ padding: "1.2rem" }}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>{t("newBuilding")}</h2>
            <div style={{ marginBottom: "0.8rem" }}>
              <label className="label" htmlFor="name">{t("name")}</label>
              <input className="input" id="name" name="name" required placeholder="Résidence Al Andalous" />
            </div>
            <div style={{ marginBottom: "0.8rem" }}>
              <label className="label" htmlFor="address">{t("address")}</label>
              <input className="input" id="address" name="address" placeholder="Tanger" />
            </div>
            <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.8rem" }}>
              <div style={{ flex: 1 }}>
                <label className="label" htmlFor="tier">{t("tier")}</label>
                <select className="input" id="tier" name="tier" defaultValue="klein">
                  <option value="klein">Klein</option>
                  <option value="midden">Midden</option>
                  <option value="groot">Groot</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label" htmlFor="total_tantiemes">{t("tantiemesTotal")}</label>
                <input className="input" id="total_tantiemes" name="total_tantiemes" type="number" defaultValue={1000} min={1} />
              </div>
            </div>
            <div style={{ marginBottom: "1.1rem" }}>
              <label className="label" htmlFor="default_language">{t("language")}</label>
              <select className="input" id="default_language" name="default_language" defaultValue="fr">
                <option value="fr">Français</option>
                <option value="ar">العربية</option>
                <option value="nl">Nederlands</option>
                <option value="en">English</option>
              </select>
            </div>
            <button className="btn btn-primary" style={{ width: "100%" }} disabled={pending}>
              {pending ? "…" : t("createBtn")}
            </button>
          </form>
        </div>
      </main>
    </>
  );
}

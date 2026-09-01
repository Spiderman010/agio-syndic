import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Testconfiguratie.
 *
 * Alleen de `@/`-alias uit tsconfig wordt hier herhaald; verder niets.
 *
 * De standaardomgeving blijft Node, want het leeuwendeel van wat we testen is
 * pure logica: de Financial Reversal Engine (validatie, foutvertaling,
 * rolpredicaten, bruto/netto) en sinds de app-shell ook het navigatiemodel
 * (actieve staat, gebouwcontext, broodkruimels, geen dode links).
 *
 * De schilcomponenten hebben wel een DOM nodig. Die tests staan in `.test.tsx`
 * en zetten zelf `@vitest-environment jsdom` bovenaan het bestand, zodat we
 * geen tweede projectconfiguratie nodig hebben.
 *
 * De database blijft getest door de SQL-suites onder `supabase/tests`; die zijn
 * de bron van waarheid voor de financiële invarianten en worden hier niet
 * nagebouwd.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // jsdom implementeert showModal()/close() en matchMedia niet; deze setup
    // vult precies dat gat. Zie het bestand voor wat het wel en niet bewijst.
    // Draait ook onder de node-omgeving en doet daar niets (guards op
    // HTMLDialogElement en window).
    setupFiles: ["tests/setup/jsdom-dialog.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Testconfiguratie.
 *
 * Alleen de `@/`-alias uit tsconfig wordt hier herhaald; verder niets. De tests
 * draaien in een Node-omgeving en raken geen DOM: wat hier wordt getest is de
 * pure logica rond de Financial Reversal Engine — validatie, foutvertaling,
 * rolpredicaten en de bruto/netto-berekening. De database blijft getest door de
 * SQL-suites onder `supabase/tests`; die zijn de bron van waarheid voor de
 * financiële invarianten en worden hier niet nagebouwd.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

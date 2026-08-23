import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["fr", "ar", "nl"],
  defaultLocale: "fr",
  localePrefix: "always",
});

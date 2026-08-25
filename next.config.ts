import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
const base = withNextIntl({});

// next-intl v3 registreert zijn Turbopack-alias onder `experimental.turbo`.
// Next 16 kent die sleutel niet meer en negeert hem ("Unrecognized key(s)"),
// waardoor de module `next-intl/config` in Turbopack-builds niet resolvet en
// elke prerender faalt met "Couldn't find next-intl config file".
// Verplaats de alias naar de stabiele `turbopack`-sleutel en laat de
// verouderde experimental-sleutel weg.
const { experimental, ...rest } = base;
const { turbo } = (experimental ?? {}) as {
  turbo?: { resolveAlias?: Record<string, string> };
};

const config: NextConfig = {
  ...rest,
  turbopack: {
    ...rest.turbopack,
    resolveAlias: {
      ...rest.turbopack?.resolveAlias,
      ...turbo?.resolveAlias,
    },
  },
};

export default config;

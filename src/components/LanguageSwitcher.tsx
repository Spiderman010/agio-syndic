"use client";

import { useLocale } from "next-intl";
import { useRouter, usePathname } from "@/navigation";
import { routing } from "@/i18n/routing";

const LANG_LABELS: Record<string, string> = {
  fr: "FR",
  ar: "ع",
  nl: "NL",
};

export default function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  function handleChange(next: string) {
    router.replace(pathname, { locale: next as "fr" | "ar" | "nl" });
  }

  return (
    <div style={{ display: "flex", gap: 4 }}>
      {routing.locales.map((l) => (
        <button
          key={l}
          onClick={() => handleChange(l)}
          style={{
            padding: "0.2rem 0.5rem",
            borderRadius: 6,
            border: "1px solid",
            borderColor: l === locale ? "var(--primary)" : "var(--line)",
            background: l === locale ? "var(--primary)" : "transparent",
            color: l === locale ? "#fff" : "var(--ink-faint)",
            fontSize: "0.75rem",
            fontWeight: 600,
            cursor: "pointer",
            lineHeight: 1.3,
          }}
        >
          {LANG_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

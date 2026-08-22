import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agio Syndic",
  description: "Syndic-software voor de Marokkaanse markt — conform Décret 2.23.700.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}

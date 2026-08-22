# Agio Syndic — M1-prototype

Syndic-software voor de Marokkaanse markt (Décret 2.23.700). Next.js 16 + Supabase.
Dit is het **M1-skelet**: authenticatie, organisatie-onboarding, en het beheer van
gebouwen → units (tantièmes) → eigenaars, met tier-weergave.

## Stack
- Next.js 16 (App Router) + React 19 + TypeScript
- Supabase (Auth + Postgres + RLS) — project **Syndiq** (`abrqdyichaiadfiuprpp`, eu-west-3)
- Eigen lichte UI-kit (Tailwind 4 + Agio-huisstijl); shadcn/ui kan later

## Aan de slag (lokaal)
1. **Node 22 + pnpm** vereist.
2. Kopieer `.env.local.example` → `.env.local` en vul in:
   - `NEXT_PUBLIC_SUPABASE_URL` — Supabase → Project Settings → API → Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — dezelfde pagina → anon/public key
   (Sleutels **nooit** in de repository of in de chat.)
3. `pnpm install`
4. `pnpm dev` → http://localhost:3000

## Belangrijk: e-mailbevestiging
Standaard vraagt Supabase Auth om e-mailbevestiging. Voor snel testen kun je in
Supabase → Authentication → Providers → Email **"Confirm email" tijdelijk uit**
zetten, zodat een nieuw account direct kan inloggen. Zet dit weer aan vóór productie.

## Wat werkt (M1)
- Inloggen / account aanmaken (Supabase Auth)
- Organisatie aanmaken (atomisch via `create_organization`-functie, RLS-veilig)
- Gebouwen aanmaken met tier (klein/midden/groot) → toont verplichte bijlagen
- Units toevoegen met tantièmes; controle som tantièmes vs. totaal
- Eigenaars toevoegen (incl. MRE-vlag) en koppelen aan een unit

## Database
Het volledige schema (M1–M5, 27 tabellen) staat al in het Syndiq-project, aangebracht
via Supabase-migraties. Dit prototype gebruikt de tabellen `organizations, memberships,
buildings, units, owners, ownership`.

## Deploy (Vercel)
1. Push naar een (nieuwe) GitHub-repo.
2. Importeer in Vercel.
3. Zet dezelfde twee env-variabelen in Vercel (Project → Settings → Environment Variables).
4. Deploy.

## Volgende stappen
- Deterministische logica: tier-auto-afleiding, FIFO, journaal-balanscontrole (triggers/code)
- Lasten & betalingen (M2-schermen), boekhouding (M3), documenten/bijlagen (M4)
- AI-hooks (bon-scan, categorisatie) via de Vercel AI SDK + Claude

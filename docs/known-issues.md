# Bekende problemen en handmatige stappen

Bijgewerkt: 24-08-2026, na de security-herstelronde (`m8` t/m `m11`).

---

## 1. BLOCKER — `pnpm-lock.yaml` is verouderd, de build faalt

**Status: niet opgelost, vereist pnpm dat in de werkomgeving ontbreekt.**

`package.json` declareert negen dependencies die niet in de `importers`-sectie
van `pnpm-lock.yaml` staan:

```
@hookform/resolvers   class-variance-authority   clsx
lucide-react          next-intl                  react-hook-form
sonner                tailwind-merge             zod
```

De lockfile dateert van 22-08 en is sinds de i18n-sprint niet meer bijgewerkt.
Vercel draait `pnpm install --frozen-lockfile`, wat hierop afbreekt met
`ERR_PNPM_OUTDATED_LOCKFILE`.

Dit is niet door de herstelronde geïntroduceerd — het stond al in `main` sinds
commit `0caaba1` — maar het blokkeert elke deploy, inclusief de verificatie van
deze ronde.

De enige `zod` in de boom is bovendien **4.4.3**, transitief binnengekomen via
`eslint-plugin-react-hooks`, terwijl `package.json` `^3.24.1` pint.
`src/lib/validation.ts` compileert tegen beide versies, maar de resolutie moet
kloppen.

**Herstel** (op een machine met pnpm):

```bash
pnpm install
```

Daarna `pnpm-lock.yaml` committen. Controleer vervolgens:

```bash
pnpm exec tsc --noEmit
pnpm run lint
pnpm run build
```

Zolang dit niet is gebeurd, is de applicatiekant van de herstelronde
**niet geverifieerd door een compiler**. De databasekant is dat wél: die is
live toegepast en met 18 integratietests bewezen.

---

## 2. Handmatige Supabase-instelling: leaked password protection

De Security Advisor meldt `auth_leaked_password_protection` als uitgeschakeld.
Dit is een dashboardinstelling, niet via SQL te zetten.

Supabase Dashboard → Authentication → Policies → *Leaked password protection*
inschakelen. Aanbevolen: ook een minimale wachtwoordlengte en rate limiting op
`signUp`, omdat registratie open staat (zie punt 5).

---

## 3. Migratiedrift: 7 historische migraties ontbreken in Git

Zie `docs/migration-drift.md`. De herstelprocedure is uitgeschreven maar
**bewust niet uitgevoerd** — die vereist de Supabase CLI en expliciete
toestemming.

---

## 4. Helperfuncties staan in het geëxposeerde `public`-schema

De RLS-helpers (`can_write`, `is_org_member`, …) moeten door `authenticated`
aanroepbaar zijn, anders breken alle policies. Daardoor publiceert PostgREST ze
als RPC-endpoint en waarschuwt de linter.

De blootstelling is beoordeeld en aanvaard: elke functie geeft uitsluitend
informatie over het eigen lidmaatschap van de aanroeper. `anon` heeft nergens
meer EXECUTE.

Structureel schoner is de helpers naar een niet-geëxposeerd schema
(`app_private`) te verplaatsen. Dat raakt alle 96 policies en viel buiten deze
ronde.

---

## 5. Open registratie

`signUp` staat open voor iedereen, zonder uitnodiging of domeinrestrictie. Op
zichzelf een productkeuze, maar het betekent dat elke bezoeker een
geauthenticeerde sessie kan verkrijgen. De tenant-isolatie is daar sinds `m8`
tegen bestand (bewezen door tests T1 t/m T6), maar een uitnodigingsflow blijft
aan te bevelen.

---

## 6. Foutmeldingen uit server actions zijn Nederlands, de UI is Frans

De teksten in `src/lib/validation.ts`, `src/lib/guard.ts` en de guard-triggers
zijn Nederlands, terwijl de UI standaard Frans is. Dit volgt het bestaande
patroon in de codebase (de oude actions deden hetzelfde), maar het hoort via
`getTranslations()` uit `next-intl/server` te lopen.

Niet meegenomen omdat het geen security- of integriteitsprobleem is.

---

## 7. Openstaande functionele punten uit de review

Gevonden tijdens de adversariële review, **buiten de scope** van deze
herstelronde en dus niet aangepakt:

- Een tegoed op 4419 wordt niet automatisch verrekend met een latere
  lastenoproep (gedocumenteerd in `docs/accounting-rules.md`).
- Een uitgave zonder boekjaar krijgt geen journaalpost en kan er achteraf niet
  alsnog aan gekoppeld worden.
- Het wijzigen of verwijderen van een `charge_call` in een open boekjaar laat de
  bijbehorende allocaties en journaalpost staan.
- `funds.balance` wordt alleen bij INSERT bijgewerkt, niet bij UPDATE/DELETE van
  een fondsmutatie.
- Er is geen controle dat `journal_entries.entry_date` binnen de periode van het
  boekjaar valt.
- De tantième-verdeling waarschuwt niet wanneer de som van `units.tantiemes`
  afwijkt van `buildings.total_tantiemes`.
- `charge_allocations.unit_id` is de enige org-gescopete relatie zonder
  samengestelde foreign key (`units` heeft geen `organization_id`). Het risico
  is beperkt omdat de kolom uitsluitend door de allocatietrigger wordt gevuld.
- Er is geen audit trail van financiële mutaties (wie boekte wat, wanneer).

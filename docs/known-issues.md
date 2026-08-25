# Bekende problemen en handmatige stappen

Bijgewerkt: 25-08-2026, na de security-herstelronde (`m8` t/m `m11`) en de release-gate op commit `d31f191`.

---

## 1. Handmatige Supabase-instelling: leaked password protection

De Security Advisor meldt `auth_leaked_password_protection` als uitgeschakeld.
Dit is een dashboardinstelling, niet via SQL te zetten.

Supabase Dashboard → Authentication → Policies → *Leaked password protection*
inschakelen. Aanbevolen: ook een minimale wachtwoordlengte en rate limiting op
`signUp`, omdat registratie open staat (zie punt 4).

---

## 2. Migratiedrift: 7 historische migraties ontbreken in Git

Zie `docs/migration-drift.md`. De herstelprocedure is uitgeschreven maar
**bewust niet uitgevoerd** — die vereist de Supabase CLI en expliciete
toestemming.

---

## 3. Helperfuncties staan in het geëxposeerde `public`-schema

De RLS-helpers (`can_write`, `is_org_member`, …) moeten door `authenticated`
aanroepbaar zijn, anders breken de policies. Daardoor publiceert PostgREST ze
als RPC-endpoint en waarschuwt de linter.

De blootstelling is beoordeeld en aanvaard: elke functie geeft uitsluitend
informatie over het eigen lidmaatschap van de aanroeper. `anon` heeft nergens
meer EXECUTE.

Structureel schoner is de helpers naar een niet-geëxposeerd schema
(`app_private`) te verplaatsen. Dat raakt de bestaande policies en viel buiten
deze ronde.

---

## 4. Open registratie

`signUp` staat open voor iedereen, zonder uitnodiging of domeinrestrictie. Op
zichzelf een productkeuze, maar het betekent dat elke bezoeker een
geauthenticeerde sessie kan verkrijgen. De tenant-isolatie is daar sinds `m8`
tegen bestand (bewezen door tests T1 t/m T6), maar een uitnodigingsflow blijft
aan te bevelen.

---

## 5. Foutmeldingen uit server actions zijn Nederlands, de UI is Frans

De teksten in `src/lib/validation.ts`, `src/lib/guard.ts` en de guard-triggers
zijn Nederlands, terwijl de UI standaard Frans is. Dit volgt het bestaande
patroon in de codebase (de oude actions deden hetzelfde), maar het hoort via
`getTranslations()` uit `next-intl/server` te lopen.

Niet meegenomen omdat het geen security- of integriteitsprobleem is.

---

## 6. Openstaande functionele punten uit de review

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

---

## Release-gate status

De eerdere lockfile/build-blocker is opgelost in commit `d31f191`:

- `pnpm install --frozen-lockfile`: groen;
- `pnpm exec tsc --noEmit`: groen;
- `pnpm run lint`: groen, 0 errors / 0 warnings;
- `pnpm run build`: groen;
- Vercel-statuscheck op `d31f191`: groen;
- Supabase security-integratietests: 18/18 groen met rollback.

Dit is daarom geen openstaand known issue meer.

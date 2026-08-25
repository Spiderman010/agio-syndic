# Migratiedrift — status en herstelprocedure

Bijgewerkt: 25-08-2026, na de flexible allocation engine (m12–m20).

> **Status: migration history reconciled; full baseline rebuild still pending.**
>
> De live migratiegeschiedenis en de bestandsnamen in de repository zijn
> gereconcilieerd, met zeven historische migraties als bewust lege
> plaatshouders. De volledige baseline voor een rebuild-from-empty is nog
> **niet gegenereerd en niet gevalideerd**; een lege database volledig
> reconstrueren vanuit Git is dus nog niet bewezen.

Migraties vanaf `m12` volgen het normale proces: elke wijziging heeft een eigen
bestand in `supabase/migrations/` met exact de naam waaronder hij is
geregistreerd.

## Huidige stand

| # | Live `schema_migrations` | Bestand in Git | Status |
|---|---|---|---|
| 1 | `20260822175325_m1_foundation_vastgoedstructuur` | ✅ plaatshouder | uitgelijnd |
| 2 | `20260822180053_m2_boekjaar_lasten_incasso` | ✅ plaatshouder | uitgelijnd |
| 3 | `20260822193646_m3_uitgaven_bank_boekhoudkern_pcsi` | ✅ plaatshouder | uitgelijnd |
| 4 | `20260822203405_m4_documenten_compliance` | ✅ plaatshouder | uitgelijnd |
| 5 | `20260822203552_m5_fondsen_jaarafsluiting` | ✅ plaatshouder | uitgelijnd |
| 6 | `20260822204127_util_create_organization_fn` | ✅ plaatshouder | uitgelijnd |
| 7 | `20260822223602_m6_deterministic_logic` | ✅ exact | in orde |
| 8 | `20260822224243_m7_pcsi_seed` | ✅ exact | in orde |
| 9 | `20260824161924_create_receipts_bucket_rls` | ✅ plaatshouder | uitgelijnd |
| 10 | `20260824190417_m8_security_tenant_isolation` | ✅ exact | in orde |
| 11 | `20260824190547_m9_financial_integrity` | ✅ exact | in orde |
| 12 | `20260824195222_m10_function_exposure_hardening` | ✅ exact | in orde |
| 13 | `20260824202502_m11_integrity_gaps` | ✅ exact | in orde |

**Elke live geregistreerde versie heeft nu een bestand met exact dezelfde naam.**
De CLI beschouwt geen enkele migratie meer als "nog toe te passen", en
`supabase migration list` is sluitend voor alle voorwaartse operaties.

## Wat een plaatshouder is, en wat niet

De zeven plaatshouders zijn **bewust leeg**. Ze bevatten één `DO`-blok met een
`RAISE NOTICE` en hebben geen effect. Ze bestaan om de lokale geschiedenis te
laten aansluiten op de live registratie — niet om het schema op te bouwen.

### Waarom de oorspronkelijke DDL niet is gereconstrueerd

Een reconstructie zou moeten weergeven hoe het schema er ná m5 uitzag. Die
toestand bestaat niet meer: `m8` heeft alle RLS-policies vervangen, unieke
constraints toegevoegd en 27 samengestelde foreign keys aangebracht. Uit de
huidige catalogus is niet af te leiden wat er vóór m8 stond.

Een met de hand geschreven reconstructie zou er plausibel uitzien maar op
detailniveau afwijken. Bij een replay op een schone database zou m8 vervolgens
struikelen over constraints die de reconstructie al had aangebracht. Dat is
gevaarlijker dan een gedocumenteerd gat, en daarom is die weg bewust niet
bewandeld.

## Wat hiermee is opgelost, en wat niet

**Opgelost.** Voorwaartse operaties. Nieuwe migraties (m12 en verder) kunnen
zonder risico worden toegevoegd en toegepast; de CLI zal nooit een reeds
toegepaste migratie opnieuw willen uitvoeren.

**Niet opgelost.** Een lege database opbouwen door alle migraties op volgorde te
draaien. Dat werkt niet en zal nooit werken. De rebuildroute loopt via de
schema-baseline — zie `supabase/baseline/README.md`. Het maken van die baseline
vereist de Supabase CLI plus het databasewachtwoord en is daarom niet in deze
ronde uitgevoerd; `supabase/baseline/generate_baseline.sql` levert intussen een
verifieerbare inventaris via de SQL-editor of de MCP-connector.

## Werkwijze vanaf nu

Elke schemawijziging gaat via een eigen migratiebestand in
`supabase/migrations/`, het bestand gaat mee in de PR, en pas na review naar
productie. Wijzigingen rechtstreeks via de SQL-editor of een MCP-connector
zónder bijbehorend bestand in Git zijn precies wat deze drift heeft veroorzaakt.

### Absolute regel

Voer **nooit** `supabase db push` uit tegen productie zolang
`supabase migration list` niet volledig sluitend is. Gebruik voor het toepassen
van een nieuwe migratie `apply_migration` (MCP) of `supabase migration up`, met
een bestand dat woordelijk identiek in Git staat.

# Migratiedrift — status en herstelprocedure

Bijgewerkt: 24-08-2026, na `m9_financial_integrity`.

## Huidige stand

| # | Live `schema_migrations` | Bestand in Git | Status |
|---|---|---|---|
| 1 | `20260822175325_m1_foundation_vastgoedstructuur` | — | **ontbreekt** |
| 2 | `20260822180053_m2_boekjaar_lasten_incasso` | — | **ontbreekt** |
| 3 | `20260822193646_m3_uitgaven_bank_boekhoudkern_pcsi` | — | **ontbreekt** |
| 4 | `20260822203405_m4_documenten_compliance` | — | **ontbreekt** |
| 5 | `20260822203552_m5_fondsen_jaarafsluiting` | — | **ontbreekt** |
| 6 | `20260822204127_util_create_organization_fn` | — | **ontbreekt** |
| 7 | `20260822223602_m6_deterministic_logic` | ✅ zelfde naam | in orde |
| 8 | `20260822224243_m7_pcsi_seed` | ✅ zelfde naam | in orde |
| 9 | `20260824161924_create_receipts_bucket_rls` | — | **ontbreekt** (inhoud grotendeels vervangen door m8) |
| 10 | `20260824190417_m8_security_tenant_isolation` | ✅ exact | in orde |
| 11 | `20260824190547_m9_financial_integrity` | ✅ exact | in orde |

**Opgelost in deze ronde**

- `m6` en `m7` droegen in Git het prefix `20260823_`, terwijl live
  `20260822223602` en `20260822224243` geregistreerd staan. De bestanden zijn
  hernoemd naar de live versies. Zonder die correctie zou de CLI ze als nieuwe,
  nog niet toegepaste migraties beschouwen en opnieuw tegen productie willen
  uitvoeren.
- `m8` en `m9` staan exact zoals toegepast in Git.

**Nog open: 7 ontbrekende bestanden.**

## Waarom m1–m5 niet betrouwbaar te reconstrueren zijn

Een reconstructie zou moeten weergeven hoe het schema er ná m5 uitzag. Die
toestand bestaat niet meer: `m8` heeft alle RLS-policies vervangen, unieke
constraints toegevoegd en 27 samengestelde foreign keys aangebracht. Uit de
huidige catalogus is niet af te leiden wat er vóór m8 stond.

Een met de hand geschreven "reconstructie" zou er plausibel uitzien maar op
detailniveau afwijken. Bij een replay op een schone database zou m8 vervolgens
struikelen over constraints die de reconstructie al had aangebracht. Dat is
gevaarlijker dan het gedocumenteerde gat, en daarom is die weg hier bewust niet
bewandeld.

## Herstelprocedure — NIET UITGEVOERD

Deze stappen vereisen de Supabase CLI en een `DATABASE_URL`. Beide zijn in de
huidige werkomgeving niet beschikbaar. **Uitvoeren pas na expliciete
toestemming.**

### Stap 1 — baseline uit de live database trekken

```bash
supabase link --project-ref abrqdyichaiadfiuprpp
supabase db pull --schema public,storage
```

`db pull` schrijft één migratiebestand met het volledige huidige schema en
registreert dat lokaal. Dit is een **lees**operatie op productie; er wordt niets
gewijzigd.

### Stap 2 — historie als toegepast markeren

Zodat de CLI de al toegepaste migraties nooit opnieuw uitvoert:

```bash
supabase migration repair --status applied 20260822175325
supabase migration repair --status applied 20260822180053
supabase migration repair --status applied 20260822193646
supabase migration repair --status applied 20260822203405
supabase migration repair --status applied 20260822203552
supabase migration repair --status applied 20260822204127
supabase migration repair --status applied 20260824161924
```

`m6`, `m7`, `m8` en `m9` hoeven niet gerepareerd te worden: hun bestandsnamen
komen na de hernoeming exact overeen met de live versies.

### Stap 3 — controleren

```bash
supabase migration list
```

Elke regel moet zowel een lokale als een remote versie tonen. Verschijnt er nog
een migratie zonder remote-tegenhanger, dan is stap 2 onvolledig geweest.

### Absolute regel

**Voer nooit `supabase db push` uit tegen productie zolang `migration list` niet
volledig sluitend is.** Een push zou de reeds toegepaste DDL opnieuw proberen
uit te voeren.

## Werkwijze vanaf nu

Elke schemawijziging gaat via `supabase migration new <naam>`, het bestand gaat
mee in de PR, en pas na review naar productie. Wijzigingen rechtstreeks via de
SQL-editor of een MCP-connector zonder bijbehorend bestand in Git zijn wat deze
drift heeft veroorzaakt.

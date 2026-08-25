# Schema-baseline

De migratiegeschiedenis van dit project bevat zeven historische plaatshouders
(m1–m5, `util_create_organization_fn`, `create_receipts_bucket_rls`). Die zijn
destijds rechtstreeks toegepast en hun oorspronkelijke DDL is niet betrouwbaar te
reconstrueren — zie `docs/migration-drift.md` voor de motivering.

**Gevolg:** een lege database opbouwen door alle migraties op volgorde te draaien
werkt niet. Dat gebeurt vanuit een baseline.

## Een baseline maken

Vereist de Supabase CLI en het databasewachtwoord (Dashboard → Settings →
Database). Beide zijn geen onderdeel van de repo.

```bash
supabase link --project-ref abrqdyichaiadfiuprpp
supabase db dump --schema public,storage -f supabase/baseline/schema.sql
supabase db dump --schema public --data-only -f supabase/baseline/seed.sql
```

`db dump` is een leesoperatie; er wordt niets op productie gewijzigd.

Werkt de CLI niet, dan levert `generate_baseline.sql` dezelfde inventaris via de
SQL-editor of de MCP-connector. Die variant is bedoeld voor verificatie en
review, niet als vervanging van een echte `pg_dump`.

## Een lege database opbouwen

```bash
psql "$DATABASE_URL" -f supabase/baseline/schema.sql
supabase migration repair --status applied 20260822175325
supabase migration repair --status applied 20260822180053
supabase migration repair --status applied 20260822193646
supabase migration repair --status applied 20260822203405
supabase migration repair --status applied 20260822203552
supabase migration repair --status applied 20260822204127
supabase migration repair --status applied 20260824161924
```

Daarna is `supabase migration list` sluitend en gelden vanaf `m12` de gewone
regels: elke schemawijziging krijgt een eigen migratiebestand dat meegaat in de
PR.

## Absolute regel

Voer **nooit** `supabase db push` uit zolang `supabase migration list` niet
volledig sluitend is.

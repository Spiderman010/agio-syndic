-- ============================================================================
-- Baseline-inventaris — verificatiehulpmiddel
-- ============================================================================
--
-- Levert een leesbaar overzicht van alles wat er in `public` en `storage` leeft:
-- enums, tabellen, constraints, indexen, functies, triggers en RLS-policies.
--
-- Bedoeld om (a) een review van een migratie te kunnen afzetten tegen de
-- werkelijke toestand, en (b) drift op te sporen. Dit is GEEN vervanging van
-- `supabase db dump` / `pg_dump`; het produceert geen herspeelbare DDL voor
-- tabeldefinities.
--
-- Uitvoeren: psql "$DATABASE_URL" -f supabase/baseline/generate_baseline.sql
-- of plakken in de SQL-editor.
-- ============================================================================

\echo '-- ENUMS'
SELECT 'CREATE TYPE public.' || t.typname || ' AS ENUM ('
     || string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) || ');' AS ddl
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
 GROUP BY t.typname
 ORDER BY t.typname;

\echo '-- TABELLEN EN KOLOMMEN'
SELECT c.table_name, c.ordinal_position, c.column_name, c.data_type,
       c.is_nullable, c.column_default
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
 WHERE c.table_schema = 'public'
 ORDER BY c.table_name, c.ordinal_position;

\echo '-- CONSTRAINTS'
SELECT conrelid::regclass::text AS tabel, conname, contype,
       pg_get_constraintdef(oid) AS definitie
  FROM pg_constraint
 WHERE connamespace = 'public'::regnamespace
 ORDER BY conrelid::regclass::text, contype, conname;

\echo '-- INDEXEN (niet door een constraint gedekt)'
SELECT i.indexdef || ';' AS ddl
  FROM pg_indexes i
 WHERE i.schemaname = 'public'
   AND NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = i.indexname
                      AND c.connamespace = 'public'::regnamespace)
 ORDER BY i.tablename, i.indexname;

\echo '-- FUNCTIES'
SELECT pg_get_functiondef(p.oid) || ';' AS ddl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 ORDER BY p.proname;

\echo '-- TRIGGERS'
SELECT pg_get_triggerdef(t.oid) || ';' AS ddl
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
 WHERE NOT t.tgisinternal
 ORDER BY c.relname, t.tgname;

\echo '-- RLS-POLICIES'
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname IN ('public', 'storage')
 ORDER BY schemaname, tablename, policyname;

\echo '-- FUNCTIERECHTEN (wie mag wat aanroepen)'
SELECT p.proname, p.prosecdef AS security_definer,
       coalesce(array_to_string(p.proacl, E'\n'), '(standaard)') AS grants
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 ORDER BY p.proname;

\echo '-- GEREGISTREERDE MIGRATIES'
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;

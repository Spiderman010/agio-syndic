-- ============================================================================
-- m2 — boekjaren, lastenoproepen, allocaties, betalingen
-- ============================================================================
--
-- HISTORISCHE PLAATSHOUDER — BEWUST LEEG.
--
-- Deze migratie is op 22/24-08-2026 rechtstreeks op het project toegepast
-- (zie supabase_migrations.schema_migrations, versie 20260822180053),
-- zonder dat het bestand in Git terechtkwam. Dit bestand bestaat zodat de
-- lokale migratiegeschiedenis exact overeenkomt met de live registratie en de
-- CLI de migratie nooit als "nog toe te passen" beschouwt.
--
-- De oorspronkelijke DDL is NIET gereconstrueerd, en dat is een bewuste keuze:
-- m8_security_tenant_isolation heeft alle RLS-policies vervangen, unieke
-- constraints toegevoegd en 27 samengestelde foreign keys aangebracht. De
-- toestand van vlak na deze migratie bestaat niet meer en is uit de huidige
-- catalogus niet af te leiden. Een plausibel ogende reconstructie zou op
-- detailniveau afwijken en bij een replay op een schone database m8 laten
-- struikelen over constraints die de reconstructie al had aangebracht.
--
-- Het opbouwen van een lege database gebeurt daarom NIET door deze migraties
-- te herhalen, maar vanuit de schema-baseline. Zie supabase/baseline/README.md.
--
-- Deze migratie is idempotent en heeft geen effect.
-- ============================================================================

DO $m$ BEGIN
  RAISE NOTICE 'Historische plaatshouder 20260822180053 — geen effect.';
END $m$;
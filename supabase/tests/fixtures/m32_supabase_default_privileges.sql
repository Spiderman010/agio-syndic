-- ============================================================================
-- Testfixture — Supabase' default privileges op schema `public`
-- ============================================================================
--
-- UITSLUITEND VOOR TESTS. Nooit in een productiemigratie.
--
-- Dit bestand wordt VOOR m31 toegepast en reproduceert niet alleen de
-- uitkomst maar het MECHANISME: functies die daarna worden aangemaakt krijgen
-- automatisch EXECUTE voor de drie Supabase-rollen. Zo bewijst de suite dat
-- m31 op een echt Supabase-schema inderdaad met `service_role`-EXECUTE
-- eindigt, zonder dat een test dat recht er zelf bij hand heeft ingezet.
--
-- `ALTER DEFAULT PRIVILEGES` geldt per toekennende rol; deze fixture en de
-- migraties draaien in de suite onder dezelfde rol, zodat de default ook
-- werkelijk aanslaat.
-- ============================================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

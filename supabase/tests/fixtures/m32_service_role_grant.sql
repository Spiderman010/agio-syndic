-- ============================================================================
-- Testfixture — modelleert Supabase' productie-default privileges
-- ============================================================================
--
-- UITSLUITEND VOOR TESTS. Deze GRANT hoort NOOIT in een productiemigratie.
--
-- Waarom dit bestand bestaat: `pre_m31_baseline.sql` bootste Supabase op dit
-- punt onvoldoende na. In een echt Supabase-project staan default privileges
-- op schema `public` die EXECUTE op NIEUWE functies automatisch toekennen aan
-- `anon`, `authenticated` en `service_role`. De REVOKE-conventie in deze
-- repository luidt `FROM PUBLIC, anon, authenticated` en noemt `service_role`
-- niet, dus die derde grant bleef op productie staan.
--
-- Lokaal viel dat niet op: zonder die default privileges was er niets te
-- revoken en stond de controle ten onrechte op groen. Dat is precies hoe een
-- fixture een productieafwijking kan verbergen.
--
-- Dit bestand reproduceert de UITKOMST (service_role heeft EXECUTE) door het
-- recht expliciet toe te kennen nadat m31 is toegepast. Voor het reproduceren
-- van het MECHANISME zelf is er `m32_supabase_default_privileges.sql`.
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.fn_guard_cc_date_in_fy()          TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_fy_period_covers_calls() TO service_role;

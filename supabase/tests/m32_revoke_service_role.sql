-- ============================================================================
-- m32 — integratietest: service_role verliest EXECUTE, alles anders blijft heel
-- ============================================================================
--
-- Draait tegen een database waarop achtereenvolgens zijn toegepast:
--   1. `pre_m31_baseline.sql`
--   2. m31
--   3. een fixture die `service_role` EXECUTE geeft (model van Supabase)
--   4. m32
--
-- De suite bewijst twee dingen tegelijk, en dat is de kern: het privilege is
-- weg EN de triggers werken onverminderd. Een reparatie die het recht intrekt
-- maar de bewaking sloopt, zou hier omvallen.
--
-- De hele suite loopt in een transactie die eindigt met een opzettelijke
-- rapport-exceptie, zodat er nul residu achterblijft.
-- ============================================================================

\set ON_ERROR_STOP off
BEGIN;

CREATE TEMP TABLE _uitslag (label text, geslaagd boolean, detail text);
-- De rolgebonden tests schrijven hun uitslag onder een andere rol weg.
GRANT ALL ON _uitslag TO PUBLIC;

CREATE OR REPLACE FUNCTION pg_temp.noteer(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO _uitslag VALUES (p_label, p_ok, p_detail);
$$;

-- Geeft terug WAT er gebeurde, nooit de mensentekst: een stabiele code.
CREATE OR REPLACE FUNCTION pg_temp.probeer(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  v_msg := SQLERRM;
  IF v_msg LIKE 'ALLOC_CALL_DATE_OUTSIDE_FY%' THEN RETURN 'ALLOC_CALL_DATE_OUTSIDE_FY'; END IF;
  IF v_msg LIKE 'ALLOC_CALL_IMMUTABLE%'       THEN RETURN 'ALLOC_CALL_IMMUTABLE'; END IF;
  IF v_msg LIKE 'Boekjaar is afgesloten%'     THEN RETURN 'FY_CLOSED'; END IF;
  IF SQLSTATE = '42501' THEN RETURN 'DENIED'; END IF;
  -- 0A000 = "trigger functions can only be called as triggers": de ACL-poort is
  -- dan gepasseerd en pas de plpgsql-handler weigert. Dat onderscheid is het
  -- bewijs dat de REVOKE effectief is en niet cosmetisch.
  IF SQLSTATE = '0A000' THEN RETURN 'ALLEEN_ALS_TRIGGER'; END IF;
  RETURN 'ANDERS:' || SQLSTATE;
END $$;

-- ── vaste testdata ─────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('11111111-0000-0000-0000-000000000001', 'syndic@example.test');

INSERT INTO public.organizations (id, name) VALUES
  ('22222222-0000-0000-0000-000000000001', 'Org A');

INSERT INTO public.memberships (organization_id, user_id, role) VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'manager');

INSERT INTO public.buildings (id, organization_id, name) VALUES
  ('33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 'Résidence Atlas');

-- Bewust geen kalenderjaar: een test die stiekem op het jaartal zou toetsen
-- valt dan meteen om.
INSERT INTO public.fiscal_years (id, organization_id, building_id, year, start_date, end_date, status) VALUES
  ('44444444-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001', 2026, '2026-04-01', '2026-09-30', 'open'),
  ('44444444-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001', 2027, '2027-04-01', '2027-09-30', 'open');

CREATE OR REPLACE FUNCTION pg_temp.oproep_sql(p_id text, p_datum text,
                                              p_fy text DEFAULT '44444444-0000-0000-0000-000000000001')
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    $q$INSERT INTO public.charge_calls
        (id, organization_id, building_id, fiscal_year_id, type, total_amount, call_date,
         alloc_method, alloc_scope, alloc_weight_source, alloc_total_cents,
         alloc_denominator, alloc_unit_count, alloc_remainder_cents, alloc_tie_breaker, alloc_algo_version)
       VALUES (%L, '22222222-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', %L,
         'regulier', 1200.00, %L,
         'tantieme', 'whole_building', 'unit_tantiemes', 120000, 100, 2, 0,
         'remainder_desc_unit_id_asc', 1)$q$,
    p_id, p_fy, p_datum);
$$;

-- ═══════════════════════════════════ P. het privilege is werkelijk weg ═════
SELECT pg_temp.noteer('P1',
       NOT has_function_privilege('service_role', 'public.fn_guard_cc_date_in_fy()', 'EXECUTE'),
       'service_role heeft geen EXECUTE op de kindfunctie');

SELECT pg_temp.noteer('P2',
       NOT has_function_privilege('service_role', 'public.fn_guard_fy_period_covers_calls()', 'EXECUTE'),
       'service_role heeft geen EXECUTE op de ouderfunctie');

-- PUBLIC via de ACL zelf: `proacl IS NULL` zou betekenen dat de default-grant
-- aan PUBLIC nog geldt, en dat is net zo goed een gat.
SELECT pg_temp.noteer('P3',
       (SELECT bool_and(p.proacl IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                                    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('fn_guard_cc_date_in_fy','fn_guard_fy_period_covers_calls')),
       'PUBLIC heeft op geen van beide functies EXECUTE');

SELECT pg_temp.noteer('P4',
       NOT has_function_privilege('anon', 'public.fn_guard_cc_date_in_fy()', 'EXECUTE')
   AND NOT has_function_privilege('anon', 'public.fn_guard_fy_period_covers_calls()', 'EXECUTE'),
       'anon kreeg door m32 geen nieuw privilege en heeft er nog steeds geen');

SELECT pg_temp.noteer('P5',
       NOT has_function_privilege('authenticated', 'public.fn_guard_cc_date_in_fy()', 'EXECUTE')
   AND NOT has_function_privilege('authenticated', 'public.fn_guard_fy_period_covers_calls()', 'EXECUTE'),
       'authenticated kreeg door m32 geen nieuw privilege');

-- Geen rol waarvan service_role lid is, geeft het recht alsnog door.
SELECT pg_temp.noteer('P6',
       NOT EXISTS (
         SELECT 1 FROM pg_roles r
          WHERE r.rolname <> 'service_role'
            AND pg_has_role('service_role', r.oid, 'USAGE')
            AND (has_function_privilege(r.oid, 'public.fn_guard_cc_date_in_fy()'::regprocedure, 'EXECUTE')
              OR has_function_privilege(r.oid, 'public.fn_guard_fy_period_covers_calls()'::regprocedure, 'EXECUTE'))),
       'geen rolmembership waarlangs service_role het recht alsnog krijgt');

-- ═══════════════════════════ O. de aannames ONDER de REVOKE ════════════════
-- Een REVOKE zegt niets zolang deze drie niet vaststaan. Zonder O1 is de hele
-- suite groen te krijgen in een toestand die materieel zwakker is: een rol die
-- de functie BEZIT leest na de REVOKE weliswaar `false`, maar kan zichzelf het
-- recht met een enkel GRANT teruggeven. Dat is empirisch nagegaan.
SELECT pg_temp.noteer('O1',
       (SELECT bool_and(pg_get_userbyid(p.proowner) <> 'service_role')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('fn_guard_cc_date_in_fy','fn_guard_fy_period_covers_calls')),
       'geen van beide functies is eigendom van service_role');

-- Een superuser leest altijd `true` bij has_function_privilege. Stond die vlag
-- aan, dan zou P1/P2 falen in plaats van vals groen worden — maar de aanname
-- hoort expliciet te staan, niet impliciet.
SELECT pg_temp.noteer('O2',
       NOT (SELECT rolsuper FROM pg_roles WHERE rolname = 'service_role'),
       'service_role is NOSUPERUSER, zoals het Supabase-model');

-- BYPASSRLS is dragend voor S1-S3: zonder die vlag zou RLS de insert al tegen-
-- houden en meet S1 niet meer de TRIGGER maar de policy.
SELECT pg_temp.noteer('O3',
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role'),
       'service_role heeft BYPASSRLS, dus S1-S3 meten de trigger en niet RLS');

-- ═══════════════════════════ E/T. de constructie van m31 is ongeschonden ═══
SELECT pg_temp.noteer('E1',
       (SELECT count(*) = 2 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('fn_guard_cc_date_in_fy','fn_guard_fy_period_covers_calls')),
       'beide m31-functies bestaan nog');

SELECT pg_temp.noteer('E2',
       (SELECT bool_and(p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('fn_guard_cc_date_in_fy','fn_guard_fy_period_covers_calls')),
       'beide functies zijn nog SECURITY DEFINER');

SELECT pg_temp.noteer('E3',
       (SELECT bool_and(array_to_string(p.proconfig, ',') = 'search_path=public, pg_temp')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('fn_guard_cc_date_in_fy','fn_guard_fy_period_covers_calls')),
       'beide vaste search_path-instellingen zijn intact');

SELECT pg_temp.noteer('T1',
       (SELECT count(*) = 2 FROM pg_trigger
         WHERE tgname IN ('trig_01_cc_date_in_fy','trig_01_fy_period_covers_calls')
           AND tgenabled = 'O'),
       'beide m31-triggers bestaan en zijn enabled');

SELECT pg_temp.noteer('T2',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE t.tgname = 'trig_01_cc_date_in_fy'
                  AND t.tgrelid = 'public.charge_calls'::regclass
                  AND p.proname = 'fn_guard_cc_date_in_fy'),
       'kindtrigger hangt aan de juiste tabel en functie');

SELECT pg_temp.noteer('T3',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE t.tgname = 'trig_01_fy_period_covers_calls'
                  AND t.tgrelid = 'public.fiscal_years'::regclass
                  AND p.proname = 'fn_guard_fy_period_covers_calls'),
       'oudertrigger hangt aan de juiste tabel en functie');

SELECT pg_temp.noteer('T4',
       (SELECT array_agg(tgname ORDER BY tgname) =
               ARRAY['trig_00_cc_closed_fy','trig_00_cc_immutable','trig_01_cc_date_in_fy']::name[]
          FROM pg_trigger WHERE tgrelid = 'public.charge_calls'::regclass AND NOT tgisinternal),
       'de triggervolgorde tegenover de trig_00_-poorten is onveranderd');

-- ═══════════════════════════════ G. het gedrag, via echte DML ══════════════
SELECT pg_temp.noteer('G1',
       pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000001','2026-10-01'))
       = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'een oproep buiten het boekjaar wordt na m32 nog steeds geweigerd');

SELECT pg_temp.noteer('G2',
       pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000002','2026-06-15')) = 'OK',
       'een geldige oproep blijft slagen');

-- De oproep van G2 ligt op 2026-06-15; het boekjaar naar juli laten beginnen
-- zou hem buiten de periode plaatsen.
SELECT pg_temp.noteer('G3',
       pg_temp.probeer(
         $$UPDATE public.fiscal_years SET start_date = '2026-07-01'
            WHERE id = '44444444-0000-0000-0000-000000000001'$$)
       = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'een periodewijziging die een bestaande oproep buiten het boekjaar plaatst, wordt geweigerd');

SELECT pg_temp.noteer('G4',
       pg_temp.probeer(
         $$UPDATE public.fiscal_years SET start_date = '2026-05-01'
            WHERE id = '44444444-0000-0000-0000-000000000001'$$) = 'OK',
       'een geldige periodewijziging blijft slagen');

-- ═══════════════ S. dezelfde bescherming onder service_role (BYPASSRLS) ════
-- Juist hier moet de trigger het werk doen: RLS geldt niet voor deze rol.
SET LOCAL ROLE service_role;

SELECT pg_temp.noteer('S1',
       pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000003','2026-01-01'))
       = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'service_role wordt ondanks BYPASSRLS door de trigger tegengehouden');

SELECT pg_temp.noteer('S2',
       pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000004','2026-06-20')) = 'OK',
       'een geldige oproep onder service_role slaagt — de trigger blijft uitvoeren');

SELECT pg_temp.noteer('S3',
       pg_temp.probeer(
         $$UPDATE public.fiscal_years SET end_date = '2026-06-10'
            WHERE id = '44444444-0000-0000-0000-000000000001'$$)
       = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'ook de oudertrigger blijft onder service_role werken');

-- Het scherpste bewijs dat de REVOKE effectief is en niet cosmetisch: MET het
-- privilege komt de aanroep tot de plpgsql-handler ('alleen als trigger'),
-- ZONDER het privilege strandt hij al op de ACL-poort.
SELECT pg_temp.noteer('S4',
       pg_temp.probeer($$SELECT public.fn_guard_cc_date_in_fy()$$) = 'DENIED',
       'een rechtstreekse aanroep onder service_role strandt op permission denied');

RESET ROLE;

-- ═══════════════════════════════════════════════ rapport ═══════════════════
DO $rapport$
DECLARE
  r record; v_ok int; v_fout int;
BEGIN
  RAISE NOTICE '=== m32 service_role zonder EXECUTE ===';
  FOR r IN SELECT label, geslaagd, detail FROM _uitslag ORDER BY ctid LOOP
    RAISE NOTICE '%  %  %', CASE WHEN r.geslaagd THEN 'PASS' ELSE 'FAIL' END, r.label, r.detail;
  END LOOP;
  SELECT count(*) FILTER (WHERE geslaagd), count(*) FILTER (WHERE NOT geslaagd)
    INTO v_ok, v_fout FROM _uitslag;
  RAISE EXCEPTION '% geslaagd, % gefaald', v_ok, v_fout;
END
$rapport$;

ROLLBACK;

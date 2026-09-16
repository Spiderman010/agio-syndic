-- ============================================================================
-- m31 — integratietest: call_date binnen de periode van het boekjaar
-- ============================================================================
--
-- Draait tegen een database waarop `pre_m31_baseline.sql` en daarna m31 zijn
-- toegepast. De hele suite loopt in een transactie die aan het eind met een
-- opzettelijke rapport-exceptie wordt teruggedraaid: zo laat de test nul
-- residu achter en is dat meteen toetsbaar (Z1).
-- ============================================================================

\set ON_ERROR_STOP off
BEGIN;

CREATE TEMP TABLE _uitslag (label text, geslaagd boolean, detail text);
-- De rolgebonden tests (S1-S3) schrijven hun uitslag onder een ANDERE rol weg.
-- Zonder dit recht zou de suite daar op een rechtenfout stranden in plaats van
-- op het gedrag dat zij wil meten.
GRANT ALL ON _uitslag TO PUBLIC;

CREATE OR REPLACE FUNCTION pg_temp.noteer(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO _uitslag VALUES (p_label, p_ok, p_detail);
$$;

-- Voert SQL uit en geeft terug wat er gebeurde: 'OK' of de domeincode uit de
-- foutmelding. Zo toetsen we op de STABIELE code, nooit op de mensentekst.
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
  IF SQLSTATE = '23503'                        THEN RETURN 'FK_VIOLATION'; END IF;
  IF SQLSTATE = '42501'                        THEN RETURN 'DENIED'; END IF;
  RETURN 'ANDERS:' || SQLSTATE;
END $$;

-- ── vaste testdata ─────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('11111111-0000-0000-0000-000000000001', 'syndic@example.test');

INSERT INTO public.organizations (id, name) VALUES
  ('22222222-0000-0000-0000-000000000001', 'Org A'),
  ('22222222-0000-0000-0000-000000000002', 'Org B');

INSERT INTO public.memberships (organization_id, user_id, role) VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'manager');

INSERT INTO public.buildings (id, organization_id, name) VALUES
  ('33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 'Résidence Atlas'),
  ('33333333-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'Ander gebouw');

-- Boekjaar 2026: 1 april t/m 30 september. Bewust GEEN kalenderjaar, zodat een
-- test die per ongeluk op het jaartal zou toetsen meteen omvalt.
INSERT INTO public.fiscal_years (id, organization_id, building_id, year, start_date, end_date, status) VALUES
  ('44444444-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001', 2026, '2026-04-01', '2026-09-30', 'open'),
  ('44444444-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001', 2025, '2025-04-01', '2025-09-30', 'closed'),
  ('44444444-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002',
   '33333333-0000-0000-0000-000000000002', 2026, '2026-04-01', '2026-09-30', 'open'),
  -- OPEN boekjaar met een andere periode, in dezelfde organisatie en hetzelfde
  -- gebouw. Nodig voor U2: een gesloten boekjaar zou al op `FY_CLOSED` stuiten
  -- en dan meet de test de volgorde van de triggers niet meer.
  ('44444444-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001', 2027, '2027-04-01', '2027-09-30', 'open');

-- Eén sjabloon voor een oproep; alleen id en datum verschillen per test.
CREATE OR REPLACE FUNCTION pg_temp.oproep_sql(p_id text, p_datum text, p_fy text DEFAULT '44444444-0000-0000-0000-000000000001',
                                              p_org text DEFAULT '22222222-0000-0000-0000-000000000001',
                                              p_bld text DEFAULT '33333333-0000-0000-0000-000000000001')
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format(
    $q$INSERT INTO public.charge_calls
        (id, organization_id, building_id, fiscal_year_id, type, total_amount, call_date,
         alloc_method, alloc_scope, alloc_weight_source, alloc_total_cents,
         alloc_denominator, alloc_unit_count, alloc_remainder_cents, alloc_tie_breaker, alloc_algo_version)
       VALUES (%L, %L, %L, %L, 'regulier', 1200.00, %L,
         'tantieme', 'whole_building', 'unit_tantiemes', 120000, 100, 2, 0,
         'remainder_desc_unit_id_asc', 1)$q$,
    p_id, p_org, p_bld, p_fy, p_datum);
$$;

-- ═══════════════════════════════════════════ 1-7. INSERT-grenzen ═══════════
SELECT pg_temp.noteer('B1', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000001','2026-06-15')) = 'OK',
       'geldige datum midden in het boekjaar');

SELECT pg_temp.noteer('B2', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000002','2026-04-01')) = 'OK',
       'exact op start_date — inclusieve ondergrens');

SELECT pg_temp.noteer('B3', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000003','2026-09-30')) = 'OK',
       'exact op end_date — inclusieve bovengrens');

SELECT pg_temp.noteer('B4', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000004','2026-03-31')) = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'een dag voor start_date');

SELECT pg_temp.noteer('B5', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000005','2026-10-01')) = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'een dag na end_date');

SELECT pg_temp.noteer('B6', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000006','1999-01-01')) = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'extreem oude datum');

SELECT pg_temp.noteer('B7', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000007','2099-12-31')) = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'extreem toekomstige datum');

-- ═══════════════════════════════════════ 8-9. UPDATE van de oproep ═════════
SELECT pg_temp.noteer('U1', pg_temp.probeer(
         $$UPDATE public.charge_calls SET call_date = '2027-01-01'
            WHERE id = '55555555-0000-0000-0000-000000000001'$$) = 'ALLOC_CALL_IMMUTABLE',
       'call_date naar buiten de periode blijft op ALLOC_CALL_IMMUTABLE stuiten');

-- Het doelboekjaar is OPEN maar dekt 2026-06-15 niet. Zowel de immutable-poort
-- als de nieuwe datumpoort zou hier aanslaan; dat ALLOC_CALL_IMMUTABLE wint
-- bewijst dat m31 de bestaande volgorde niet heeft verstoord.
SELECT pg_temp.noteer('U2', pg_temp.probeer(
         $$UPDATE public.charge_calls SET fiscal_year_id = '44444444-0000-0000-0000-000000000004'
            WHERE id = '55555555-0000-0000-0000-000000000001'$$) = 'ALLOC_CALL_IMMUTABLE',
       'fiscal_year_id naar een open maar niet-passend boekjaar blijft geweigerd');

-- De oproep is na beide pogingen ongewijzigd.
SELECT pg_temp.noteer('U3',
       (SELECT call_date = '2026-06-15' AND fiscal_year_id = '44444444-0000-0000-0000-000000000001'
          FROM public.charge_calls WHERE id = '55555555-0000-0000-0000-000000000001'),
       'de rij is werkelijk onveranderd gebleven');

-- ═════════════════════════════════ 10-11. Periodewijziging van het boekjaar ═
SELECT pg_temp.noteer('P1', pg_temp.probeer(
         $$UPDATE public.fiscal_years SET start_date = '2026-07-01'
            WHERE id = '44444444-0000-0000-0000-000000000001'$$) = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'versmallen dat een bestaande oproep buiten de periode zou plaatsen');

SELECT pg_temp.noteer('P2', pg_temp.probeer(
         $$UPDATE public.fiscal_years SET start_date = '2026-03-01', end_date = '2026-10-31'
            WHERE id = '44444444-0000-0000-0000-000000000001'$$) = 'OK',
       'verruimen dat alle oproepen blijft omvatten');

-- Na P2 gelden de RUIMERE grenzen: 31 maart mag nu wel.
SELECT pg_temp.noteer('P3', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000008','2026-03-01')) = 'OK',
       'de nieuwe ondergrens werkt meteen door');

SELECT pg_temp.noteer('P4', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-000000000009','2026-02-28')) = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'en een dag daarvoor blijft geweigerd');

-- Terug naar de oorspronkelijke periode voor de rest van de suite.
SELECT pg_temp.probeer(
  $$DELETE FROM public.charge_calls WHERE id = '55555555-0000-0000-0000-000000000008'$$);
SELECT pg_temp.probeer(
  $$UPDATE public.fiscal_years SET start_date = '2026-04-01', end_date = '2026-09-30'
     WHERE id = '44444444-0000-0000-0000-000000000001'$$);

-- ══════════════════════════════════════════ 12-14. Regressies ══════════════
SELECT pg_temp.noteer('R1', pg_temp.probeer(
         pg_temp.oproep_sql('55555555-0000-0000-0000-00000000000a','2025-06-15',
                            '44444444-0000-0000-0000-000000000002')) = 'FY_CLOSED',
       'gesloten boekjaar weigert nog steeds, en met zijn eigen melding');

SELECT pg_temp.noteer('R2', pg_temp.probeer(
         pg_temp.oproep_sql('55555555-0000-0000-0000-00000000000b','2026-06-15',
                            '44444444-0000-0000-0000-000000000003')) = 'FK_VIOLATION',
       'boekjaar van een andere tenant blijft op de FK stuiten');

SELECT pg_temp.noteer('R3', pg_temp.probeer(
         $$UPDATE public.charge_calls SET total_amount = 999.00
            WHERE id = '55555555-0000-0000-0000-000000000001'$$) = 'ALLOC_CALL_IMMUTABLE',
       'ALLOC_CALL_IMMUTABLE op een andere kolom is ongewijzigd');

SELECT pg_temp.noteer('R4', pg_temp.probeer(
         $$UPDATE public.charge_calls SET label = 'nieuw label'
            WHERE id = '55555555-0000-0000-0000-000000000001'$$) = 'OK',
       'een toegestane UPDATE blijft toegestaan, de datumtrigger blokkeert niet alles');

-- ════════════════════════════════════ 15. Rollen en schrijfpaden ═══════════
-- `authenticated` komt niet eens langs RLS.
SET LOCAL request.jwt.claim.sub = '11111111-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.noteer('S1', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-00000000000c','2026-06-15')) = 'DENIED',
       'directe INSERT door authenticated blijft door RLS geblokkeerd');
RESET ROLE;

-- `service_role` heeft BYPASSRLS. Juist daar moet de TRIGGER het overnemen:
-- dit is het schrijfpad dat een controle binnen create_charge_call zou missen.
SET LOCAL ROLE service_role;
SELECT pg_temp.noteer('S2', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-00000000000d','2026-01-01')) = 'ALLOC_CALL_DATE_OUTSIDE_FY',
       'een BYPASSRLS-rol wordt wel degelijk door de trigger tegengehouden');
SELECT pg_temp.noteer('S3', pg_temp.probeer(pg_temp.oproep_sql('55555555-0000-0000-0000-00000000000e','2026-06-15')) = 'OK',
       'diezelfde rol mag binnen de periode wel schrijven');
RESET ROLE;

-- ════════════════════════════════════════ minimale privileges ══════════════
SELECT pg_temp.noteer('G1',
       NOT has_function_privilege('authenticated', 'public.fn_guard_cc_date_in_fy()', 'EXECUTE'),
       'authenticated mag de triggerfunctie niet uitvoeren');
SELECT pg_temp.noteer('G2',
       NOT has_function_privilege('anon', 'public.fn_guard_fy_period_covers_calls()', 'EXECUTE'),
       'anon mag de boekjaartriggerfunctie niet uitvoeren');

-- ═══════════════════════════════════════════════ rapport ═══════════════════
DO $rapport$
DECLARE
  r record; v_ok int; v_fout int;
BEGIN
  RAISE NOTICE '=== m31 call_date binnen boekjaar ===';
  FOR r IN SELECT label, geslaagd, detail FROM _uitslag ORDER BY ctid LOOP
    RAISE NOTICE '%  %  %', CASE WHEN r.geslaagd THEN 'PASS' ELSE 'FAIL' END, r.label, r.detail;
  END LOOP;
  SELECT count(*) FILTER (WHERE geslaagd), count(*) FILTER (WHERE NOT geslaagd)
    INTO v_ok, v_fout FROM _uitslag;
  RAISE EXCEPTION '% geslaagd, % gefaald', v_ok, v_fout;
END
$rapport$;

ROLLBACK;

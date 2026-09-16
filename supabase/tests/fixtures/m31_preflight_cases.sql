-- ============================================================================
-- TESTFIXTURE — preflightgevallen voor m31
-- ============================================================================
--
-- Twee datasets die BESTAANDE data modelleren zoals die er vóór m31 uitziet.
-- Ze worden geladen op een database met `pre_m31_baseline.sql` maar ZONDER
-- m31, want juist dan kan een oproep buiten zijn boekjaar bestaan.
--
-- Hoort niet in supabase/migrations/ en wordt nooit op een project toegepast.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.m31_preflight_basis()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('11111111-0000-0000-0000-0000000000f1', 'pf@example.test')
    ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (id, name) VALUES
    ('22222222-0000-0000-0000-0000000000f1', 'Org PF') ON CONFLICT DO NOTHING;
  INSERT INTO public.buildings (id, organization_id, name) VALUES
    ('33333333-0000-0000-0000-0000000000f1', '22222222-0000-0000-0000-0000000000f1', 'PF gebouw')
    ON CONFLICT DO NOTHING;
  INSERT INTO public.fiscal_years (id, organization_id, building_id, year, start_date, end_date, status)
  VALUES ('44444444-0000-0000-0000-0000000000f1', '22222222-0000-0000-0000-0000000000f1',
          '33333333-0000-0000-0000-0000000000f1', 2026, '2026-04-01', '2026-09-30', 'open')
    ON CONFLICT DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION public.m31_oproep(p_id uuid, p_datum date)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.charge_calls
    (id, organization_id, building_id, fiscal_year_id, type, total_amount, call_date,
     alloc_method, alloc_scope, alloc_weight_source, alloc_total_cents,
     alloc_denominator, alloc_unit_count, alloc_remainder_cents, alloc_tie_breaker, alloc_algo_version)
  VALUES (p_id, '22222222-0000-0000-0000-0000000000f1', '33333333-0000-0000-0000-0000000000f1',
          '44444444-0000-0000-0000-0000000000f1', 'regulier', 1200.00, p_datum,
          'tantieme', 'whole_building', 'unit_tantiemes', 120000, 100, 2, 0,
          'remainder_desc_unit_id_asc', 1);
END $$;

-- GEVAL 1 — bestaande data die de invariant schendt. m31 MOET afbreken.
CREATE OR REPLACE FUNCTION public.m31_preflight_case_1_ongeldig()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.m31_preflight_basis();
  PERFORM public.m31_oproep('55555555-0000-0000-0000-0000000000f1', '2026-06-15'); -- geldig
  PERFORM public.m31_oproep('55555555-0000-0000-0000-0000000000f2', '2025-12-31'); -- VOOR de periode
END $$;

-- GEVAL 2 — geldige, NIET-LEGE bestaande data. m31 MOET slagen.
-- Niet-leeg is essentieel: op een lege tabel slaagt elke preflight triviaal.
CREATE OR REPLACE FUNCTION public.m31_preflight_case_2_geldig_nietleeg()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.m31_preflight_basis();
  PERFORM public.m31_oproep('55555555-0000-0000-0000-0000000000f3', '2026-04-01'); -- exact op de ondergrens
  PERFORM public.m31_oproep('55555555-0000-0000-0000-0000000000f4', '2026-09-30'); -- exact op de bovengrens
  PERFORM public.m31_oproep('55555555-0000-0000-0000-0000000000f5', '2026-06-15'); -- ertussenin
END $$;

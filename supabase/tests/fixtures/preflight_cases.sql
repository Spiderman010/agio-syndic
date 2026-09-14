-- ============================================================================
-- TESTFIXTURE — preflightscenario's voor m30
-- ============================================================================
--
-- GEEN MIGRATIE. Wordt uitsluitend lokaal geladen door
-- `scripts/test-m30-local.mjs`, bovenop `pre_m30_baseline.sql`.
--
-- m30 begint met een preflight die weigert te migreren zolang er ongeldige
-- eigendomsdata bestaat. Op een lege database telt die preflight drie keer nul
-- en bewijst hij niets. Deze fixture levert de datasets waarmee elk van die
-- drie invarianten wel echt wordt getest, plus een geldige dataset waarop m30
-- juist moet slagen.
--
-- Elk scenario zit in een eigen functie, zodat de runner er precies een kiest en
-- ze elkaar niet kunnen beinvloeden. De rijen worden als tabeleigenaar
-- ingevoegd; RLS is hier niet het onderwerp.
--
--   preflight_case_1_overlappend_primair  -> M30_PREFLIGHT_FAILED verwacht
--   preflight_case_2_dubbele_eigenaar     -> M30_PREFLIGHT_FAILED verwacht
--   preflight_case_3_toekomstgedateerd    -> M30_PREFLIGHT_FAILED verwacht
--   preflight_case_4_geldig_nietleeg      -> m30 moet SLAGEN
-- ============================================================================

\set ON_ERROR_STOP on

-- Gedeelde opbouw: een organisatie met gebouw, lot en twee eigenaars.
CREATE OR REPLACE FUNCTION public.tf_preflight_basis(
  p_naam text, OUT org uuid, OUT gebouw uuid, OUT lot uuid, OUT eig1 uuid, OUT eig2 uuid)
LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public.organizations(name) VALUES (p_naam) RETURNING id INTO org;
  INSERT INTO public.buildings(organization_id, name, total_tantiemes)
       VALUES (org, p_naam || ' gebouw', 1000) RETURNING id INTO gebouw;
  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
       VALUES (gebouw, 'P1', 'appartement', 100) RETURNING id INTO lot;
  INSERT INTO public.owners(organization_id, full_name)
       VALUES (org, p_naam || ' eigenaar 1') RETURNING id INTO eig1;
  INSERT INTO public.owners(organization_id, full_name)
       VALUES (org, p_naam || ' eigenaar 2') RETURNING id INTO eig2;
END $fn$;


-- CASE 1 — twee overlappende PRIMAIRE perioden op hetzelfde lot.
-- Beide perioden zijn gesloten, want de bestaande index
-- `ownership_primary_active_idx` verbiedt al twee open primaire perioden. Juist
-- de gesloten-gesloten overlap is wat m30 als eerste extra dichttimmert.
CREATE OR REPLACE FUNCTION public.preflight_case_1_overlappend_primair()
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM public.tf_preflight_basis('PF1');
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, end_date, is_primary_debtor)
  VALUES (b.lot, b.eig1, 1, CURRENT_DATE - 100, CURRENT_DATE - 50, true),
         (b.lot, b.eig2, 1, CURRENT_DATE -  60, CURRENT_DATE - 20, true);
END $fn$;


-- CASE 2 — dezelfde eigenaar twee keer met overlappende perioden op een lot.
-- Niet-primair, zodat case 1 hier niet meelift en de assertie precies deze
-- invariant meet. Verschillende startdatums, zodat de bestaande UNIQUE
-- `ownership_unit_owner_start_key` niet al eerder blokkeert.
CREATE OR REPLACE FUNCTION public.preflight_case_2_dubbele_eigenaar()
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM public.tf_preflight_basis('PF2');
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, end_date, is_primary_debtor)
  VALUES (b.lot, b.eig1, 0.5, CURRENT_DATE - 100, CURRENT_DATE - 50, false),
         (b.lot, b.eig1, 0.5, CURRENT_DATE -  60, CURRENT_DATE - 20, false);
END $fn$;


-- CASE 3 — toekomstgedateerd eigendom.
-- Pre-m30 bestaat er geen enkele guard die dit tegenhoudt; dat is precies de
-- reden dat m30 de preflight nodig heeft.
CREATE OR REPLACE FUNCTION public.preflight_case_3_toekomstgedateerd()
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM public.tf_preflight_basis('PF3');
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, end_date, is_primary_debtor)
  VALUES (b.lot, b.eig1, 1, CURRENT_DATE + 10, NULL, true);
END $fn$;


-- CASE 4 — geldige, NIET-LEGE dataset waarop m30 wel moet slagen.
-- Twee organisaties, een afgesloten en een lopende periode, mede-eigendom met
-- exact een aangewezen debiteur, plus financiele rijen. Zo bewijst de run dat de
-- preflight geen valse positieven geeft en dat de backfill van
-- `organization_id` op echte data klopt.
CREATE OR REPLACE FUNCTION public.preflight_case_4_geldig_nietleeg()
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE b record; c record;
BEGIN
  SELECT * INTO b FROM public.tf_preflight_basis('PF4a');
  SELECT * INTO c FROM public.tf_preflight_basis('PF4b');

  -- Opeenvolgende, niet-overlappende historie op hetzelfde lot.
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, end_date, is_primary_debtor)
  VALUES (b.lot, b.eig1, 1, CURRENT_DATE - 400, CURRENT_DATE - 201, true),
         (b.lot, b.eig2, 1, CURRENT_DATE - 200, NULL,               true);

  -- Geldige mede-eigendom in de tweede organisatie: twee actieve eigenaars,
  -- exact een primaire debiteur.
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, end_date, is_primary_debtor)
  VALUES (c.lot, c.eig1, 0.6, CURRENT_DATE - 90, NULL, true),
         (c.lot, c.eig2, 0.4, CURRENT_DATE - 90, NULL, false);

  INSERT INTO public.charge_allocations(organization_id, unit_id, owner_id, amount_cents, label)
  VALUES (b.org, b.lot, b.eig2, 250000, 'PF4 allocatie');
  INSERT INTO public.payments(organization_id, owner_id, amount_cents, paid_on, reference)
  VALUES (b.org, b.eig2, 250000, CURRENT_DATE - 30, 'PF4-BET-0001');
  INSERT INTO public.journal_entries(organization_id, entry_date, description, amount_cents)
  VALUES (b.org, CURRENT_DATE - 30, 'PF4 journaalpost', 250000);
END $fn$;

-- m21 — fiscal year delete guard
--
-- PROBLEEM
-- Een OPEN boekjaar met financiele historie kon direct worden verwijderd. Via cascade verdwenen
-- lastenoproepen, allocaties, betalingskoppelingen en journaalposten; uitgaven en documenten bleven
-- achter met fiscal_year_id = NULL. Gemeten: 1 oproep, 2 allocaties, 1 betaalkoppeling en
-- 3 journaalposten verdwenen geruisloos.
--
-- TWEEDE, TEGENGESTELD PROBLEEM (bestaande deadlock)
-- fn_guard_fiscal_year_immutable blokkeerde DELETE van een GESLOTEN boekjaar zonder
-- parent-cascade escape. Daardoor was elk gebouw en elke organisatie die ooit een boekjaar afsloot
-- permanent onverwijderbaar. Gemeten: DELETE FROM buildings en DELETE FROM organizations faalden
-- beide met 'Een afgesloten boekjaar kan niet worden verwijderd'.
--
-- WAAROM DIT SAMEN MOET
-- Alleen de escape toevoegen zou een NETTO VERSLECHTERING zijn: de deadlock verdwijnt, maar
-- daarmee ook de toevallige bescherming die een gesloten boekjaar vandaag aan het gebouw geeft.
-- Een verdediging die je omzeilt door het gebouw te verwijderen is geen verdediging. Daarom krijgt
-- `buildings` een spiegelguard. `organizations` verwijderen blijft de bewuste, volledige uitgang
-- (offboarding) en is voorbehouden aan de owner (RLS: is_org_owner).
--
-- ROLMODEL
-- Dit is een FINANCIELE INVARIANT, geen autorisatiekeuze. De guards draaien voor iedereen:
-- reader, manager, accountant, admin, owner en service_role. Er is bewust GEEN rol-shortcut en
-- GEEN auth.uid()-escape. Een echte correctie hoort via intrekken/heropenen te lopen, niet via
-- cascade delete.
--
-- GRENZEN, eerlijk benoemd
--  * Dit is een TOESTANDScontrole ("heeft nu historie"), geen "heeft ooit historie gehad".
--  * Met databaseeigenaarsrechten (session_replication_role = replica) is elke trigger te omzeilen;
--    dat valt buiten het dreigingsmodel, net als bij de bestaande guards.
--  * Zet NOOIT FORCE ROW LEVEL SECURITY op buildings, organizations of fiscal_years: de guards
--    lezen SECURITY DEFINER en RLS-blind. Met FORCE zou de escape-SELECT stil leeg teruggeven en
--    de guard ten onrechte doorlaten.

-- ============================ gedeelde telling ==============================
-- Een definitie van "financiele historie", gebruikt door alle drie de guards, zodat er geen drift
-- tussen guards kan ontstaan. VOLATILE en niet STABLE: een STABLE-functie hergebruikt de snapshot
-- van de aanroeper, en dat is precies waar cascade-afhankelijk gedrag misgaat.
CREATE OR REPLACE FUNCTION public.fn_fy_history_summary(p_fy_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_fy       public.fiscal_years%ROWTYPE;
  n_calls    bigint; n_allocs bigint; n_payall bigint;
  n_journal  bigint; n_exp    bigint; n_closing bigint;
  n_doc      bigint; n_fundmv bigint;
  onderdelen text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_fy FROM public.fiscal_years WHERE id = p_fy_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*) INTO n_calls FROM public.charge_calls WHERE fiscal_year_id = p_fy_id;

  -- Allocaties en betalingskoppelingen kunnen niet bestaan zonder een lastenoproep; ze worden
  -- geteld voor de MELDING, niet voor de dekking.
  SELECT count(*) INTO n_allocs
    FROM public.charge_allocations ca
    JOIN public.charge_calls cc ON cc.id = ca.charge_call_id
   WHERE cc.fiscal_year_id = p_fy_id;

  SELECT count(*) INTO n_payall
    FROM public.payment_allocations pa
    JOIN public.charge_allocations ca ON ca.id = pa.charge_allocation_id
    JOIN public.charge_calls cc ON cc.id = ca.charge_call_id
   WHERE cc.fiscal_year_id = p_fy_id;

  SELECT count(*) INTO n_journal FROM public.journal_entries      WHERE fiscal_year_id = p_fy_id;
  SELECT count(*) INTO n_exp     FROM public.expenses             WHERE fiscal_year_id = p_fy_id;
  SELECT count(*) INTO n_closing FROM public.fiscal_year_closings WHERE fiscal_year_id = p_fy_id;

  -- Documenten zijn WEL financieel bewijsmateriaal: het documenttypeschema kent balans,
  -- resultatenrekening, grootboek, journaal, kwitantie en appel_de_fonds, en
  -- verification_number is NOT NULL (externe verifieerbaarheid). Concepten tellen niet mee.
  SELECT count(*) INTO n_doc
    FROM public.documents WHERE fiscal_year_id = p_fy_id AND status <> 'concept';

  -- Fondsmutaties hebben geen fiscal_year_id. Het jaar wordt afgeleid met exact dezelfde regel als
  -- fn_guard_closed_fy_fund_movements gebruikt, zodat twee guards niet twee definities hanteren.
  SELECT count(*) INTO n_fundmv
    FROM public.fund_movements fm
    JOIN public.funds f ON f.id = fm.fund_id
   WHERE f.building_id = v_fy.building_id
     AND fm.movement_date BETWEEN v_fy.start_date AND v_fy.end_date;

  IF n_calls   > 0 THEN onderdelen := onderdelen || format('%s lastenoproep(en)',      n_calls);   END IF;
  IF n_allocs  > 0 THEN onderdelen := onderdelen || format('%s allocatie(s)',          n_allocs);  END IF;
  IF n_payall  > 0 THEN onderdelen := onderdelen || format('%s betalingskoppeling(en)',n_payall);  END IF;
  IF n_journal > 0 THEN onderdelen := onderdelen || format('%s journaalpost(en)',      n_journal); END IF;
  IF n_exp     > 0 THEN onderdelen := onderdelen || format('%s uitgave(n)',            n_exp);     END IF;
  IF n_closing > 0 THEN onderdelen := onderdelen || format('%s jaarafsluiting(en)',    n_closing); END IF;
  IF n_doc     > 0 THEN onderdelen := onderdelen || format('%s document(en)',          n_doc);     END IF;
  IF n_fundmv  > 0 THEN onderdelen := onderdelen || format('%s fondsmutatie(s)',       n_fundmv);  END IF;

  IF array_length(onderdelen, 1) IS NULL THEN RETURN NULL; END IF;
  RETURN array_to_string(onderdelen, ', ');
END $fn$;

COMMENT ON FUNCTION public.fn_fy_history_summary(uuid) IS
  'Retourneert NULL wanneer een boekjaar geen financiele historie heeft, anders een leesbare opsomming. Een definitie voor alle delete-guards. Bewust NIET geteld: compliance_deadlines (administratieve termijn zonder bedragen), charge_call_lines en journal_lines (kunnen niet bestaan zonder een geteld ouderrecord).';

-- ==================== correctie: bestaande boekjaarguard ====================
-- Twee wijzigingen: (1) parent-cascade escape op de DELETE-tak, zodat een gebouw of organisatie
-- met een GESLOTEN boekjaar niet langer permanent onverwijderbaar is; (2) een boekjaar MET historie
-- kan niet meer naar een ander gebouw verhuizen. Zonder (2) blijft er een omweg: verhuis het jaar
-- naar een leeg gebouw en sloop dat gebouw. De UPDATE-takken zijn verder woordelijk ongewijzigd.
CREATE OR REPLACE FUNCTION public.fn_guard_fiscal_year_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.status = 'closed' THEN
      RAISE EXCEPTION 'Een afgesloten boekjaar kan niet worden verwijderd'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'closed' AND (
       NEW.year            IS DISTINCT FROM OLD.year
    OR NEW.start_date      IS DISTINCT FROM OLD.start_date
    OR NEW.end_date        IS DISTINCT FROM OLD.end_date
    OR NEW.building_id     IS DISTINCT FROM OLD.building_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
  ) THEN
    RAISE EXCEPTION
      'Periode en jaartal van een afgesloten boekjaar liggen vast; heropen het boekjaar eerst'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.building_id IS DISTINCT FROM OLD.building_id
     AND public.fn_fy_history_summary(OLD.id) IS NOT NULL THEN
    RAISE EXCEPTION
      'FY_HAS_FINANCIAL_HISTORY: boekjaar % heeft financiele historie en kan niet naar een ander gebouw worden verplaatst',
      OLD.year USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'closed' AND NEW.status = 'open'
     AND auth.uid() IS NOT NULL
     AND NOT public.can_manage_members(NEW.organization_id) THEN
    RAISE EXCEPTION
      'Alleen een owner of admin mag een afgesloten boekjaar heropenen'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $fn$;

-- ==================== nieuw: boekjaar met historie ==========================
-- Vuurt NA trig_00_fy_immutable (alfabetisch), zodat een GESLOTEN boekjaar de duidelijke
-- gesloten-melding krijgt en een OPEN boekjaar met historie deze.
CREATE OR REPLACE FUNCTION public.fn_guard_fy_delete_history()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_hist text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
  OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  v_hist := public.fn_fy_history_summary(OLD.id);
  IF v_hist IS NOT NULL THEN
    RAISE EXCEPTION
      'FY_HAS_FINANCIAL_HISTORY: boekjaar % heeft financiele historie (%) en kan niet worden verwijderd. Trek de onderliggende posten eerst in, of sluit het boekjaar af.',
      OLD.year, v_hist USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

CREATE TRIGGER trig_01_fy_delete_history BEFORE DELETE ON public.fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fy_delete_history();

-- ==================== nieuw: gebouw met historie ============================
-- Spiegelguard. Zonder deze guard is de boekjaarguard triviaal te omzeilen door het gebouw te
-- verwijderen. De organisatie-cascade blijft bewust doorlopen: offboarding is de expliciete,
-- volledige uitgang en is via RLS voorbehouden aan de owner.
CREATE OR REPLACE FUNCTION public.fn_guard_building_delete_history()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_jaar int; v_hist text; v_closed boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  SELECT fy.year, (fy.status = 'closed'), public.fn_fy_history_summary(fy.id)
    INTO v_jaar, v_closed, v_hist
    FROM public.fiscal_years fy
   WHERE fy.building_id = OLD.id
     AND (fy.status = 'closed' OR public.fn_fy_history_summary(fy.id) IS NOT NULL)
   ORDER BY fy.year
   LIMIT 1;

  IF FOUND THEN
    IF v_closed THEN
      RAISE EXCEPTION
        'BUILDING_HAS_FINANCIAL_HISTORY: dit gebouw heeft een afgesloten boekjaar (%) en kan niet worden verwijderd.',
        v_jaar USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION
      'BUILDING_HAS_FINANCIAL_HISTORY: dit gebouw heeft financiele historie in boekjaar % (%) en kan niet worden verwijderd.',
      v_jaar, v_hist USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

CREATE TRIGGER trig_00_building_delete_history BEFORE DELETE ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_building_delete_history();

-- ============ correctie: ontbrekende parent-escapes elders ==================
-- Zonder deze escapes blijft er een deadlock bestaan wanneer een uitgave of journaalpost van
-- gebouw A verwijst naar een GESLOTEN boekjaar van gebouw B binnen dezelfde organisatie: het
-- verwijderen van gebouw A liep dan stuk op fn_assert_fy_open. Het schema staat die kruislingse
-- toewijzing toe (expenses en journal_entries hebben alleen een org-brede composiet-FK naar
-- fiscal_years, geen gebouw-brede).
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_expenses()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'verwijderen van een uitgave');
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'wijzigen van een uitgave');
  END IF;
  PERFORM public.fn_assert_fy_open(NEW.fiscal_year_id, 'aanmaken of wijzigen van een uitgave');
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_journal_entries()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'verwijderen van een journaalpost');
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'wijzigen van een journaalpost');
  END IF;
  PERFORM public.fn_assert_fy_open(NEW.fiscal_year_id, 'aanmaken of wijzigen van een journaalpost');
  RETURN NEW;
END $fn$;

-- ============================== rechten =====================================
REVOKE ALL ON FUNCTION public.fn_fy_history_summary(uuid)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_fy_delete_history()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_building_delete_history()   FROM PUBLIC, anon, authenticated;

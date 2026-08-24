-- ============================================================================
-- m9_financial_integrity
-- Herstelt: P1-3 (stille journaalposten zonder regels),
--           P1-4 (gesloten boekjaar muteerbaar),
--           P1-8 (overbetaling verdwijnt)
--
-- BOEKHOUDKUNDIGE REGEL (zie docs/accounting-rules.md):
--   Een afgesloten boekjaar is onwijzigbaar voor alles wat het VASTGESTELDE
--   cijfer bepaalt: lastenoproepen, de verdeling (amount), uitgaven, journaal-
--   posten en journaalregels. Het veld charge_allocations.settled_amount is
--   géén vastgesteld cijfer maar de actuele stand van de open post in de
--   subadministratie (PCSI 4111, een doorlopende balansrekening). Betalingen in
--   een NIEUW boekjaar mogen die stand blijven afboeken; hun journaalpost landt
--   altijd in het huidige OPEN boekjaar. Daarmee blijven resultaat en
--   vastgestelde balans van het gesloten boekjaar ongewijzigd.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PCSI: rekening voor vooruitontvangen bedragen  (P1-8)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.seed_pcsi(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.accounts(organization_id, code, name, class, type, is_postable)
  VALUES
    (p_org_id, '4111', 'Copropriétaires - charges communes',           4, 'actief',  true),
    (p_org_id, '4419', 'Copropriétaires - avances et acomptes reçus',  4, 'passief', true),
    (p_org_id, '4411', 'Fournisseurs',                                 4, 'passief', true),
    (p_org_id, '5141', 'Banques - comptes courants',                   5, 'actief',  true),
    (p_org_id, '6110', 'Charges générales de copropriété',             6, 'charge',  true),
    (p_org_id, '7011', 'Appels de charges communes',                   7, 'produit', true)
  ON CONFLICT (organization_id, code) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_pcsi(uuid) FROM PUBLIC, anon, authenticated;

-- Backfill: bestaande organisaties krijgen de nieuwe rekening alsnog.
INSERT INTO public.accounts(organization_id, code, name, class, type, is_postable)
SELECT o.id, '4419', 'Copropriétaires - avances et acomptes reçus', 4, 'passief', true
  FROM public.organizations o
ON CONFLICT (organization_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. JOURNAALPOSTEN: FAIL HARD i.p.v. stille gedeeltelijke verwerking  (P1-3)
-- ---------------------------------------------------------------------------

-- Vangnet dat een journaalpost zónder (sluitende) regels onmogelijk maakt.
-- DEFERRABLE INITIALLY DEFERRED: de controle draait bij commit, zodat de kop
-- eerst geschreven mag worden en de regels daarna volgen.
CREATE OR REPLACE FUNCTION public.fn_journal_entry_complete()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $$
DECLARE
  v_lines  int;
  v_debit  numeric;
  v_credit numeric;
BEGIN
  SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO v_lines, v_debit, v_credit
    FROM public.journal_lines
   WHERE journal_entry_id = NEW.id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION
      'Journaalpost % heeft % regel(s); minimaal 2 vereist. Controleer het rekeningschema (PCSI).',
      NEW.id, v_lines USING ERRCODE = '23514';
  END IF;

  IF round(v_debit, 2) <> round(v_credit, 2) THEN
    RAISE EXCEPTION
      'Journaalpost % is ongebalanceerd: debet % <> credit %',
      NEW.id, v_debit, v_credit USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_journal_entry_complete ON public.journal_entries;
CREATE CONSTRAINT TRIGGER trig_journal_entry_complete
  AFTER INSERT ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_journal_entry_complete();

-- Gedeelde, hard falende rekeningopzoeking.
CREATE OR REPLACE FUNCTION public.require_account_id(p_org_id uuid, p_code text)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v
    FROM public.accounts
   WHERE organization_id = p_org_id AND code = p_code;

  IF v IS NULL THEN
    RAISE EXCEPTION
      'Rekening % ontbreekt in het schema van organisatie %. Journaalpost kan niet worden aangemaakt.',
      p_code, p_org_id USING ERRCODE = '23514';
  END IF;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.require_account_id(uuid, text) FROM PUBLIC, anon, authenticated;

-- ---- Lastenoproep -> journaal -------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_journal_from_charge()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_building_id uuid;
  v_org_id      uuid;
  v_entry_id    uuid;
  v_acc_deb     uuid;
  v_acc_cred    uuid;
BEGIN
  SELECT fy.building_id, fy.organization_id
    INTO v_building_id, v_org_id
    FROM public.fiscal_years fy
   WHERE fy.id = NEW.fiscal_year_id;

  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Boekjaar % bestaat niet', NEW.fiscal_year_id USING ERRCODE = '23503';
  END IF;

  -- Fail hard vóór de kop: geen halve journaalpost bij ontbrekend schema.
  v_acc_deb  := public.require_account_id(v_org_id, '4111');
  v_acc_cred := public.require_account_id(v_org_id, '7011');

  INSERT INTO public.journal_entries(
    organization_id, building_id, fiscal_year_id,
    entry_date, source, source_id, description
  ) VALUES (
    v_org_id, v_building_id, NEW.fiscal_year_id,
    NEW.call_date, 'charge', NEW.id,
    COALESCE(NEW.label, 'Lastenoproep ' || to_char(NEW.call_date, 'DD-MM-YYYY'))
  ) RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_lines(
    organization_id, journal_entry_id, account_id, debit, credit, description
  ) VALUES
    (v_org_id, v_entry_id, v_acc_deb,  NEW.total_amount, 0, 'Vordering copropriétaires'),
    (v_org_id, v_entry_id, v_acc_cred, 0, NEW.total_amount,
      'Lastenoproep' || CASE WHEN NEW.period IS NOT NULL THEN ' ' || NEW.period ELSE '' END);

  RETURN NEW;
END;
$$;

-- ---- Betaling -> journaal, inclusief overbetaling  (P1-8) ----------------
CREATE OR REPLACE FUNCTION public.fn_journal_from_payment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_fy_id     uuid;
  v_entry_id  uuid;
  v_acc_bank  uuid;
  v_acc_recv  uuid;
  v_acc_adv   uuid;
  v_allocated numeric;
  v_excess    numeric;
BEGIN
  -- Betalingen worden altijd in het huidige OPEN boekjaar geboekt, ook wanneer
  -- zij een vordering uit een afgesloten boekjaar afboeken.
  SELECT id INTO v_fy_id
    FROM public.fiscal_years
   WHERE building_id = NEW.building_id AND status = 'open'
   ORDER BY year DESC
   LIMIT 1;

  IF v_fy_id IS NULL THEN
    RAISE EXCEPTION
      'Geen open boekjaar voor gebouw %. Open eerst een boekjaar voordat betalingen worden geboekt.',
      NEW.building_id USING ERRCODE = '23514';
  END IF;

  v_acc_bank := public.require_account_id(NEW.organization_id, '5141');
  v_acc_recv := public.require_account_id(NEW.organization_id, '4111');

  -- trig_01_payment_fifo draait eerder en heeft de toewijzingen al geschreven.
  SELECT COALESCE(sum(amount), 0) INTO v_allocated
    FROM public.payment_allocations
   WHERE payment_id = NEW.id;

  v_excess := round(NEW.amount - v_allocated, 2);

  IF v_excess > 0 THEN
    v_acc_adv := public.require_account_id(NEW.organization_id, '4419');
  END IF;

  INSERT INTO public.journal_entries(
    organization_id, building_id, fiscal_year_id,
    entry_date, source, source_id, description
  ) VALUES (
    NEW.organization_id, NEW.building_id, v_fy_id,
    NEW.value_date, 'payment', NEW.id,
    'Betaling ontvangen (' || NEW.method || ')'
    || CASE WHEN NEW.reference IS NOT NULL THEN ' ref: ' || NEW.reference ELSE '' END
  ) RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_lines(
    organization_id, journal_entry_id, account_id, debit, credit, description
  ) VALUES (NEW.organization_id, v_entry_id, v_acc_bank, NEW.amount, 0, 'Bank ontvangst');

  IF v_allocated > 0 THEN
    INSERT INTO public.journal_lines(
      organization_id, journal_entry_id, account_id, debit, credit, description
    ) VALUES (NEW.organization_id, v_entry_id, v_acc_recv, 0, v_allocated,
              'Afboeking vordering eigenaar');
  END IF;

  IF v_excess > 0 THEN
    INSERT INTO public.journal_lines(
      organization_id, journal_entry_id, account_id, debit, credit, description
    ) VALUES (NEW.organization_id, v_entry_id, v_acc_adv, 0, v_excess,
              'Vooruitontvangen van eigenaar (overbetaling)');
  END IF;

  RETURN NEW;
END;
$$;

-- ---- Uitgave -> journaal -------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_journal_from_expense()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_entry_id   uuid;
  v_acc_charge uuid;
  v_acc_cred   uuid;
BEGIN
  -- Een uitgave zonder boekjaar is (nog) niet toegerekend; geen journaalpost.
  IF NEW.fiscal_year_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_acc_charge := NEW.account_id;

  IF v_acc_charge IS NULL AND NEW.category_id IS NOT NULL THEN
    SELECT default_account_id INTO v_acc_charge
      FROM public.expense_categories
     WHERE id = NEW.category_id;
  END IF;

  -- Terugval op de algemene lastenrekening in plaats van stil overslaan.
  IF v_acc_charge IS NULL THEN
    v_acc_charge := public.require_account_id(NEW.organization_id, '6110');
  END IF;

  v_acc_cred := public.require_account_id(NEW.organization_id, '4411');

  INSERT INTO public.journal_entries(
    organization_id, building_id, fiscal_year_id,
    entry_date, source, source_id, description
  ) VALUES (
    NEW.organization_id, NEW.building_id, NEW.fiscal_year_id,
    NEW.expense_date, 'expense', NEW.id,
    COALESCE(NEW.description, 'Uitgave ' || to_char(NEW.expense_date, 'DD-MM-YYYY'))
  ) RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_lines(
    organization_id, journal_entry_id, account_id, debit, credit, description
  ) VALUES
    (NEW.organization_id, v_entry_id, v_acc_charge, NEW.amount, 0,
      COALESCE(NEW.description, 'Uitgave')),
    (NEW.organization_id, v_entry_id, v_acc_cred, 0, NEW.amount,
      COALESCE(NEW.supplier, 'Leverancier'));

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. GESLOTEN BOEKJAAR IMMUTABLE  (P1-4)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_assert_fy_open(p_fy uuid, p_wat text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF p_fy IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fiscal_years WHERE id = p_fy AND status = 'closed') THEN
    RAISE EXCEPTION 'Boekjaar is afgesloten: % is niet toegestaan', p_wat
      USING ERRCODE = '23514';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_assert_fy_open(uuid, text) FROM PUBLIC, anon, authenticated;

-- ---- charge_calls --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_charge_calls()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'verwijderen van een lastenoproep');
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'wijzigen van een lastenoproep');
  END IF;
  PERFORM public.fn_assert_fy_open(NEW.fiscal_year_id, 'aanmaken of wijzigen van een lastenoproep');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_cc_closed_fy ON public.charge_calls;
CREATE TRIGGER trig_00_cc_closed_fy
  BEFORE INSERT OR UPDATE OR DELETE ON public.charge_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_closed_fy_charge_calls();

-- ---- charge_allocations --------------------------------------------------
-- amount = vastgesteld cijfer (onwijzigbaar); settled_amount = open post (mag).
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_charge_allocations()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_fy uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT cc.fiscal_year_id INTO v_fy FROM public.charge_calls cc WHERE cc.id = OLD.charge_call_id;
    PERFORM public.fn_assert_fy_open(v_fy, 'verwijderen van een vastgestelde verdeelregel');
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT cc.fiscal_year_id INTO v_fy FROM public.charge_calls cc WHERE cc.id = NEW.charge_call_id;
    PERFORM public.fn_assert_fy_open(v_fy, 'toevoegen van een verdeelregel');
    RETURN NEW;
  END IF;

  IF NEW.amount          IS DISTINCT FROM OLD.amount
  OR NEW.charge_call_id  IS DISTINCT FROM OLD.charge_call_id
  OR NEW.unit_id         IS DISTINCT FROM OLD.unit_id
  OR NEW.owner_id        IS DISTINCT FROM OLD.owner_id
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    SELECT cc.fiscal_year_id INTO v_fy FROM public.charge_calls cc WHERE cc.id = NEW.charge_call_id;
    PERFORM public.fn_assert_fy_open(v_fy, 'wijzigen van een vastgestelde verdeelregel');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_ca_closed_fy ON public.charge_allocations;
CREATE TRIGGER trig_00_ca_closed_fy
  BEFORE INSERT OR UPDATE OR DELETE ON public.charge_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_closed_fy_charge_allocations();

-- ---- expenses ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_expenses()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'verwijderen van een uitgave');
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'wijzigen van een uitgave');
  END IF;
  PERFORM public.fn_assert_fy_open(NEW.fiscal_year_id, 'aanmaken of wijzigen van een uitgave');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_exp_closed_fy ON public.expenses;
CREATE TRIGGER trig_00_exp_closed_fy
  BEFORE INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_closed_fy_expenses();

-- ---- journal_entries -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_journal_entries()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'verwijderen van een journaalpost');
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'wijzigen van een journaalpost');
  END IF;
  PERFORM public.fn_assert_fy_open(NEW.fiscal_year_id, 'aanmaken of wijzigen van een journaalpost');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_je_closed_fy ON public.journal_entries;
CREATE TRIGGER trig_00_je_closed_fy
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_closed_fy_journal_entries();

-- ---- journal_lines -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_journal_lines()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_fy uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT je.fiscal_year_id INTO v_fy FROM public.journal_entries je WHERE je.id = OLD.journal_entry_id;
    PERFORM public.fn_assert_fy_open(v_fy, 'verwijderen van een journaalregel');
    RETURN OLD;
  END IF;
  SELECT je.fiscal_year_id INTO v_fy FROM public.journal_entries je WHERE je.id = NEW.journal_entry_id;
  PERFORM public.fn_assert_fy_open(v_fy, 'aanmaken of wijzigen van een journaalregel');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_jl_closed_fy ON public.journal_lines;
CREATE TRIGGER trig_00_jl_closed_fy
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_closed_fy_journal_lines();

-- ---- payment_allocations -------------------------------------------------
-- INSERT is toegestaan: dat is het afboeken van een doorlopende vordering.
-- UPDATE/DELETE op een afgeboekte regel in een gesloten jaar niet.
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_payment_allocations()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_fy uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  SELECT cc.fiscal_year_id INTO v_fy
    FROM public.charge_allocations ca
    JOIN public.charge_calls cc ON cc.id = ca.charge_call_id
   WHERE ca.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.charge_allocation_id
                      ELSE NEW.charge_allocation_id END;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_assert_fy_open(v_fy, 'terugdraaien van een betalingstoewijzing');
    RETURN OLD;
  END IF;

  PERFORM public.fn_assert_fy_open(v_fy, 'wijzigen van een betalingstoewijzing');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_payal_closed_fy ON public.payment_allocations;
CREATE TRIGGER trig_00_payal_closed_fy
  BEFORE INSERT OR UPDATE OR DELETE ON public.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_closed_fy_payment_allocations();

-- ---- fund_movements ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_fund_movements()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_fund uuid;
  v_date date;
  v_fy   uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_fund := OLD.fund_id; v_date := OLD.movement_date;
  ELSE
    v_fund := NEW.fund_id; v_date := NEW.movement_date;
  END IF;

  SELECT fy.id INTO v_fy
    FROM public.funds f
    JOIN public.fiscal_years fy ON fy.building_id = f.building_id
   WHERE f.id = v_fund
     AND v_date BETWEEN fy.start_date AND fy.end_date
   LIMIT 1;

  PERFORM public.fn_assert_fy_open(v_fy, 'boeken of wijzigen van een fondsmutatie');

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_fundmov_closed_fy ON public.fund_movements;
CREATE TRIGGER trig_00_fundmov_closed_fy
  BEFORE INSERT OR UPDATE OR DELETE ON public.fund_movements
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_closed_fy_fund_movements();

-- ---- fiscal_years zelf ---------------------------------------------------
-- Periode en jaartal liggen vast zodra het boekjaar gesloten is. Alleen de
-- status mag nog wijzigen (heropenen), en dat is via RLS aan owner/admin
-- voorbehouden.
CREATE OR REPLACE FUNCTION public.fn_guard_fiscal_year_immutable()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_fy_immutable ON public.fiscal_years;
CREATE TRIGGER trig_00_fy_immutable
  BEFORE UPDATE OR DELETE ON public.fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fiscal_year_immutable();

-- ---- fiscal_year_closings ------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_guard_fy_closing_immutable()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION
    'Een vastgelegde jaarafsluiting is onwijzigbaar (audit trail)'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trig_00_fyc_immutable ON public.fiscal_year_closings;
CREATE TRIGGER trig_00_fyc_immutable
  BEFORE UPDATE OR DELETE ON public.fiscal_year_closings
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fy_closing_immutable();

-- Triggerfuncties uit deze migratie eveneens niet rechtstreeks aanroepbaar.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;

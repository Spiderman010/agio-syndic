-- ============================================================
-- M6: Deterministische bedrijfslogica
-- Triggers en functies voor tantième-verdeling, FIFO-incasso,
-- journaalboekingen, fondsbalans en automatische tier-afleiding.
-- Conform Décret 2.23.700 / Loi 18-00.
-- ============================================================

-- ============================================================
-- HULPFUNCTIE: PCSI-rekening opzoeken per code
-- Geeft NULL terug als de rekening nog niet geseed is.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_account_id(p_org_id uuid, p_code text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT id FROM public.accounts
   WHERE organization_id = p_org_id AND code = p_code
   LIMIT 1;
$$;

-- ============================================================
-- 1. TANTIÈME-VERDELING BIJ NIEUWE LASTENOPROEP
--
-- Largest-remainder method (Hamilton): elke eenheid krijgt
-- floor(tantiemes/total * totaal_centen) centen, daarna gaan
-- de resterende centen naar de eenheden met de hoogste breuk.
-- Garantie: som van allocaties = total_amount exact.
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_charge_call_allocate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_building_id     uuid;
  v_org_id          uuid;
  v_total_tantiemes integer;
  v_total_cents     bigint;
BEGIN
  SELECT fy.building_id, fy.organization_id, b.total_tantiemes
    INTO v_building_id, v_org_id, v_total_tantiemes
    FROM public.fiscal_years fy
    JOIN public.buildings b ON b.id = fy.building_id
   WHERE fy.id = NEW.fiscal_year_id;

  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Boekjaar % heeft geen geldig gebouw', NEW.fiscal_year_id;
  END IF;
  IF COALESCE(v_total_tantiemes, 0) = 0 THEN
    RAISE EXCEPTION 'Gebouw % heeft total_tantiemes = 0 — stel tantièmes in vóór lastenoproep', v_building_id;
  END IF;

  v_total_cents := round(NEW.total_amount * 100)::bigint;

  -- Largest-remainder verdeling (one INSERT via CTE)
  WITH
  unit_list AS (
    SELECT
      u.id,
      u.tantiemes,
      (SELECT ow.owner_id
         FROM public.ownership ow
        WHERE ow.unit_id = u.id AND ow.end_date IS NULL
        LIMIT 1) AS owner_id,
      floor(u.tantiemes::numeric / v_total_tantiemes * v_total_cents)::bigint AS base_cents,
      (u.tantiemes::numeric / v_total_tantiemes * v_total_cents)
        - floor(u.tantiemes::numeric / v_total_tantiemes * v_total_cents) AS frac
    FROM public.units u
    WHERE u.building_id = v_building_id
  ),
  base_sum AS (
    SELECT COALESCE(sum(base_cents), 0)::bigint AS s FROM unit_list
  ),
  ranked AS (
    SELECT
      ul.id,
      ul.owner_id,
      ul.base_cents,
      bs.s,
      ROW_NUMBER() OVER (ORDER BY ul.frac DESC, ul.id ASC) AS rn
    FROM unit_list ul CROSS JOIN base_sum bs
  ),
  allocated AS (
    SELECT
      id,
      owner_id,
      base_cents + CASE WHEN rn <= GREATEST(0, v_total_cents - s) THEN 1 ELSE 0 END AS alloc_cents
    FROM ranked
  )
  INSERT INTO public.charge_allocations(
    organization_id, charge_call_id, unit_id, owner_id, amount, settled_amount
  )
  SELECT
    v_org_id, NEW.id, a.id, a.owner_id,
    (a.alloc_cents::numeric / 100),
    0
  FROM allocated a
  WHERE a.alloc_cents > 0;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_01_charge_call_allocate ON public.charge_calls;
CREATE TRIGGER trig_01_charge_call_allocate
  AFTER INSERT ON public.charge_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_charge_call_allocate();


-- ============================================================
-- 2. FIFO-INCASSO BIJ BETALING
--
-- Loopt oudste openstaande charge_allocations voor eigenaar+gebouw
-- af (gesorteerd op due_date ASC, call_date ASC, created_at ASC).
-- Maakt payment_allocations aan en werkt settled_amount bij.
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_payment_fifo()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_remaining numeric := NEW.amount;
  v_alloc     RECORD;
  v_apply     numeric;
BEGIN
  FOR v_alloc IN
    SELECT
      ca.id,
      ca.organization_id,
      (ca.amount - ca.settled_amount) AS open_amount
    FROM public.charge_allocations ca
    JOIN public.charge_calls       cc ON cc.id  = ca.charge_call_id
    JOIN public.fiscal_years       fy ON fy.id  = cc.fiscal_year_id
    WHERE ca.owner_id        = NEW.owner_id
      AND fy.building_id     = NEW.building_id
      AND ca.amount          > ca.settled_amount
    ORDER BY cc.due_date ASC NULLS LAST, cc.call_date ASC, ca.created_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_apply := LEAST(v_remaining, v_alloc.open_amount);

    INSERT INTO public.payment_allocations(
      organization_id, payment_id, charge_allocation_id, amount
    ) VALUES (
      v_alloc.organization_id, NEW.id, v_alloc.id, v_apply
    );

    UPDATE public.charge_allocations
       SET settled_amount = settled_amount + v_apply
     WHERE id = v_alloc.id;

    v_remaining := v_remaining - v_apply;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_01_payment_fifo ON public.payments;
CREATE TRIGGER trig_01_payment_fifo
  AFTER INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.fn_payment_fifo();


-- ============================================================
-- 3. JOURNAALBOEKING BIJ LASTENOPROEP
--
-- Maakt altijd een journal_entry header aan.
-- Journal_lines worden ALLEEN aangemaakt als PCSI-rekeningen
-- 4111 (Vorderingen) en 7011 (Appels charges) bestaan.
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_journal_from_charge()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_building_id uuid;
  v_org_id      uuid;
  v_entry_id    uuid;
  v_acc_deb     uuid;   -- 4111 Copropriétaires
  v_acc_cred    uuid;   -- 7011 Appels de charges
BEGIN
  SELECT fy.building_id, fy.organization_id
    INTO v_building_id, v_org_id
    FROM public.fiscal_years fy
   WHERE fy.id = NEW.fiscal_year_id;

  INSERT INTO public.journal_entries(
    organization_id, building_id, fiscal_year_id,
    entry_date, source, source_id, description
  ) VALUES (
    v_org_id, v_building_id, NEW.fiscal_year_id,
    NEW.call_date, 'charge', NEW.id,
    COALESCE(NEW.label, 'Lastenoproep ' || to_char(NEW.call_date, 'DD-MM-YYYY'))
  ) RETURNING id INTO v_entry_id;

  v_acc_deb  := public.get_account_id(v_org_id, '4111');
  v_acc_cred := public.get_account_id(v_org_id, '7011');

  IF v_acc_deb IS NOT NULL AND v_acc_cred IS NOT NULL THEN
    INSERT INTO public.journal_lines(
      organization_id, journal_entry_id, account_id, debit, credit, description
    ) VALUES
      (v_org_id, v_entry_id, v_acc_deb,  NEW.total_amount, 0,                'Vordering copropriétaires'),
      (v_org_id, v_entry_id, v_acc_cred, 0,                NEW.total_amount,
        'Lastenoproep' || CASE WHEN NEW.period IS NOT NULL THEN ' ' || NEW.period ELSE '' END);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_02_charge_call_journal ON public.charge_calls;
CREATE TRIGGER trig_02_charge_call_journal
  AFTER INSERT ON public.charge_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_journal_from_charge();


-- ============================================================
-- 4. JOURNAALBOEKING BIJ BETALING
--
-- Boekt op het meest recente open boekjaar van het gebouw.
-- Rekeningen: 5141 Bank (debet) / 4111 Vorderingen (credit).
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_journal_from_payment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_fy_id    uuid;
  v_entry_id uuid;
  v_acc_deb  uuid;   -- 5141 Banque
  v_acc_cred uuid;   -- 4111 Vorderingen eigenaars
BEGIN
  SELECT id INTO v_fy_id
    FROM public.fiscal_years
   WHERE building_id = NEW.building_id AND status = 'open'
   ORDER BY year DESC
   LIMIT 1;

  IF v_fy_id IS NULL THEN
    RETURN NEW;  -- geen open boekjaar, geen journaalboeking
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

  v_acc_deb  := public.get_account_id(NEW.organization_id, '5141');
  v_acc_cred := public.get_account_id(NEW.organization_id, '4111');

  IF v_acc_deb IS NOT NULL AND v_acc_cred IS NOT NULL THEN
    INSERT INTO public.journal_lines(
      organization_id, journal_entry_id, account_id, debit, credit, description
    ) VALUES
      (NEW.organization_id, v_entry_id, v_acc_deb,  NEW.amount, 0,          'Bank ontvangst'),
      (NEW.organization_id, v_entry_id, v_acc_cred, 0,          NEW.amount, 'Afboeking vordering eigenaar');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_02_payment_journal ON public.payments;
CREATE TRIGGER trig_02_payment_journal
  AFTER INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.fn_journal_from_payment();


-- ============================================================
-- 5. JOURNAALBOEKING BIJ UITGAVE
--
-- Kostenrekening: expense.account_id > categorie.default_account_id.
-- Tegenrekening: 4411 Leveranciers.
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_journal_from_expense()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_entry_id   uuid;
  v_acc_charge uuid;   -- Kostenrekening (6xxx)
  v_acc_cred   uuid;   -- 4411 Leveranciers
BEGIN
  IF NEW.fiscal_year_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.journal_entries(
    organization_id, building_id, fiscal_year_id,
    entry_date, source, source_id, description
  ) VALUES (
    NEW.organization_id, NEW.building_id, NEW.fiscal_year_id,
    NEW.expense_date, 'expense', NEW.id,
    COALESCE(NEW.description, 'Uitgave ' || to_char(NEW.expense_date, 'DD-MM-YYYY'))
  ) RETURNING id INTO v_entry_id;

  -- Kostenrekening: voorkeur expense.account_id, daarna categorie.default_account_id
  v_acc_charge := NEW.account_id;
  IF v_acc_charge IS NULL AND NEW.category_id IS NOT NULL THEN
    SELECT default_account_id INTO v_acc_charge
      FROM public.expense_categories
     WHERE id = NEW.category_id;
  END IF;

  v_acc_cred := public.get_account_id(NEW.organization_id, '4411');

  IF v_acc_charge IS NOT NULL AND v_acc_cred IS NOT NULL THEN
    INSERT INTO public.journal_lines(
      organization_id, journal_entry_id, account_id, debit, credit, description
    ) VALUES
      (NEW.organization_id, v_entry_id, v_acc_charge, NEW.amount, 0,          COALESCE(NEW.description, 'Uitgave')),
      (NEW.organization_id, v_entry_id, v_acc_cred,   0,          NEW.amount, COALESCE(NEW.supplier,    'Leverancier'));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_01_expense_journal ON public.expenses;
CREATE TRIGGER trig_01_expense_journal
  AFTER INSERT ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.fn_journal_from_expense();


-- ============================================================
-- 6. FONDSSALDO BIJHOUDEN BIJ FUND_MOVEMENTS
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_fund_movement_balance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF NEW.movement_type = 'apport' THEN
    UPDATE public.funds SET balance = balance + NEW.amount WHERE id = NEW.fund_id;
  ELSIF NEW.movement_type = 'prelevement' THEN
    UPDATE public.funds SET balance = balance - NEW.amount WHERE id = NEW.fund_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_01_fund_movement_balance ON public.fund_movements;
CREATE TRIGGER trig_01_fund_movement_balance
  AFTER INSERT ON public.fund_movements
  FOR EACH ROW EXECUTE FUNCTION public.fn_fund_movement_balance();


-- ============================================================
-- 7. AUTOMATISCHE TIER-AFLEIDING BIJ LASTENOPROEPEN
--
-- Herberekent tier en requires_audit van het gebouw telkens als
-- een lastenoproep wordt ingevoegd, bijgewerkt of verwijderd,
-- maar alleen als buildings.tier_auto = true.
-- Conform Décret 2.23.700: groot >= 500.000, midden > 200.000.
-- Auditplicht boven 1.000.000 MAD.
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_tier_auto_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_fy_id        uuid;
  v_building_id  uuid;
  v_total_called numeric;
  v_new_tier     public.syndic_tier;
  v_new_audit    boolean;
BEGIN
  v_fy_id := COALESCE(NEW.fiscal_year_id, OLD.fiscal_year_id);

  SELECT fy.building_id INTO v_building_id
    FROM public.fiscal_years fy
   WHERE fy.id = v_fy_id;

  -- Sla over als tier_auto = false
  IF NOT EXISTS (
    SELECT 1 FROM public.buildings WHERE id = v_building_id AND tier_auto = true
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Som na de triggerende operatie (AFTER trigger: DB-staat is al bijgewerkt)
  SELECT COALESCE(sum(total_amount), 0)
    INTO v_total_called
    FROM public.charge_calls
   WHERE fiscal_year_id = v_fy_id;

  -- Tier afleiden conform Décret 2.23.700
  IF v_total_called >= 500000 THEN
    v_new_tier := 'groot';
  ELSIF v_total_called >  200000 THEN
    v_new_tier := 'midden';
  ELSE
    v_new_tier := 'klein';
  END IF;

  v_new_audit := v_total_called > 1000000;

  UPDATE public.buildings
     SET tier         = v_new_tier,
         requires_audit = v_new_audit
   WHERE id = v_building_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trig_03_tier_auto_update ON public.charge_calls;
CREATE TRIGGER trig_03_tier_auto_update
  AFTER INSERT OR UPDATE OF total_amount OR DELETE ON public.charge_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_tier_auto_update();


-- ============================================================
-- 8. BALANSCONTROLE OP JOURNAALREGELS (UITGESTELD)
--
-- DEFERRABLE INITIALLY DEFERRED: de controle loopt aan het einde
-- van de transactie. Hierdoor kunnen debet- en creditregel in
-- dezelfde transactie worden ingevoegd zonder tussentijdse fout.
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_journal_balance_check()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public AS $$
DECLARE
  v_debit  numeric;
  v_credit numeric;
BEGIN
  SELECT
    COALESCE(sum(debit),  0),
    COALESCE(sum(credit), 0)
  INTO v_debit, v_credit
  FROM public.journal_lines
  WHERE journal_entry_id = NEW.journal_entry_id;

  IF round(v_debit, 2) <> round(v_credit, 2) THEN
    RAISE EXCEPTION
      'Journaalboeking ongebalanceerd (entry_id: %): debet % ≠ credit %',
      NEW.journal_entry_id, v_debit, v_credit;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_journal_balance_check ON public.journal_lines;
CREATE CONSTRAINT TRIGGER trig_journal_balance_check
  AFTER INSERT OR UPDATE ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_journal_balance_check();

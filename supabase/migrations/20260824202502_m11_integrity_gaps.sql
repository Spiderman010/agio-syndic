-- ============================================================================
-- m11_integrity_gaps
--
-- Nazorg op m8/m9 na adversariële review. Sluit zeven bevestigde gaten die de
-- eerdere fixes onvolledig maakten.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Journaalbalans dekte DELETE niet  (P1-3 onvolledig)
-- ---------------------------------------------------------------------------
-- trig_journal_balance_check stond op AFTER INSERT OR UPDATE. Een schrijver kon
-- daardoor in een OPEN boekjaar één regel van een tweeregelige post verwijderen
-- en zo een ongebalanceerde post achterlaten, die na afsluiting bevroor.

CREATE OR REPLACE FUNCTION public.fn_journal_balance_check()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_entry  uuid;
  v_lines  int;
  v_debit  numeric;
  v_credit numeric;
BEGIN
  v_entry := CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_entry_id
                  ELSE NEW.journal_entry_id END;

  -- Kop is zelf verwijderd (cascade): er valt niets meer te controleren.
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE id = v_entry) THEN
    RETURN NULL;
  END IF;

  SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO v_lines, v_debit, v_credit
    FROM public.journal_lines
   WHERE journal_entry_id = v_entry;

  IF v_lines < 2 THEN
    RAISE EXCEPTION
      'Journaalpost % zou % regel(s) overhouden; minimaal 2 vereist',
      v_entry, v_lines USING ERRCODE = '23514';
  END IF;

  IF round(v_debit, 2) <> round(v_credit, 2) THEN
    RAISE EXCEPTION
      'Journaalboeking ongebalanceerd (entry_id: %): debet % <> credit %',
      v_entry, v_debit, v_credit USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trig_journal_balance_check ON public.journal_lines;
CREATE CONSTRAINT TRIGGER trig_journal_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_journal_balance_check();

-- ---------------------------------------------------------------------------
-- 2. Afgeleide tabellen zijn niet rechtstreeks beschrijfbaar  (P1-3/P1-4)
-- ---------------------------------------------------------------------------
-- charge_allocations, payment_allocations, journal_entries en journal_lines
-- worden UITSLUITEND door triggers onderhouden (deterministische kern). Directe
-- DML door de applicatie is nooit legitiem en was de resterende route om
-- settled_amount, toewijzingen of het grootboek met de hand te verdraaien.
-- De triggerfuncties zijn SECURITY DEFINER en omzeilen RLS, dus zij blijven
-- gewoon werken.

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['charge_allocations','payment_allocations',
                           'journal_entries','journal_lines']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (false)',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (false) WITH CHECK (false)',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (false)',
      t || '_delete', t);
  END LOOP;
END $do$;

-- ---------------------------------------------------------------------------
-- 3. organization_id onveranderlijk  (P1-6 onvolledig)
-- ---------------------------------------------------------------------------
-- De UPDATE-policies toetsten can_write(organization_id) op zowel de oude als
-- de nieuwe waarde. Een manager die daarnaast een eigen organisatie bezit kon
-- daardoor een record naar die eigen organisatie verplaatsen en zo meenemen.
-- Dat ondermijnt alle 27 samengestelde foreign keys.

CREATE OR REPLACE FUNCTION public.fn_guard_org_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION
      'De organisatie van een bestaand record kan niet worden gewijzigd'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'accounts','bank_accounts','bank_transactions','buildings',
    'charge_allocations','charge_calls','compliance_deadlines','documents',
    'expense_categories','expenses','fiscal_year_closings','fiscal_years',
    'fund_movements','funds','journal_entries','journal_lines','owners',
    'payment_allocations','payments','memberships'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trig_00_org_immutable ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trig_00_org_immutable BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.fn_guard_org_immutable()', t);
  END LOOP;
END $do$;

-- units hebben geen organization_id; daar is building_id de tenant-sleutel.
CREATE OR REPLACE FUNCTION public.fn_guard_unit_building_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.building_id IS DISTINCT FROM OLD.building_id THEN
    RAISE EXCEPTION
      'Een unit kan niet naar een ander gebouw worden verplaatst'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trig_00_unit_building_immutable ON public.units;
CREATE TRIGGER trig_00_unit_building_immutable
  BEFORE UPDATE ON public.units
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_unit_building_immutable();

-- memberships: user_id ligt eveneens vast (anders is de last-owner-guard
-- te omzeilen door de rij naar een andere gebruiker te herschrijven).
CREATE OR REPLACE FUNCTION public.fn_guard_membership_user_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION
      'De gebruiker van een bestaand lidmaatschap kan niet worden gewijzigd'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trig_00_mbr_user_immutable ON public.memberships;
CREATE TRIGGER trig_00_mbr_user_immutable
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_membership_user_immutable();

-- ---------------------------------------------------------------------------
-- 4. Heropenen van een boekjaar is voorbehouden aan owner/admin  (P1-4/P1-5)
-- ---------------------------------------------------------------------------
-- De UPDATE-policy op fiscal_years staat op can_write, waardoor ook manager en
-- accountant een afgesloten boekjaar konden heropenen en daarmee elke guard uit
-- m9 konden omzeilen. docs/accounting-rules.md beloofde owner/admin.

CREATE OR REPLACE FUNCTION public.fn_guard_fiscal_year_immutable()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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

  -- Heropenen: alleen owner/admin. auth.uid() is NULL bij beheer buiten de
  -- applicatie om (SQL-editor, service_role); die route blijft mogelijk.
  IF OLD.status = 'closed' AND NEW.status = 'open'
     AND auth.uid() IS NOT NULL
     AND NOT public.can_manage_members(NEW.organization_id) THEN
    RAISE EXCEPTION
      'Alleen een owner of admin mag een afgesloten boekjaar heropenen'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Jaarafsluiting: UPDATE blijft verboden, DELETE via cascade weer mogelijk
-- ---------------------------------------------------------------------------
-- De vorige versie blokkeerde ook DELETE, waardoor het verwijderen van een
-- organisatie of gebouw permanent onmogelijk werd (ON DELETE CASCADE liep dood).

CREATE OR REPLACE FUNCTION public.fn_guard_fy_closing_immutable()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION
    'Een vastgelegde jaarafsluiting is onwijzigbaar (audit trail)'
    USING ERRCODE = '23514';
END;
$fn$;

DROP TRIGGER IF EXISTS trig_00_fyc_immutable ON public.fiscal_year_closings;
CREATE TRIGGER trig_00_fyc_immutable
  BEFORE UPDATE ON public.fiscal_year_closings
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fy_closing_immutable();

-- ---------------------------------------------------------------------------
-- 6. Kernrekeningen van het PCSI beschermen  (P1-3 afhankelijkheid)
-- ---------------------------------------------------------------------------
-- m9 faalt hard wanneer 4111/4419/4411/5141/6110/7011 ontbreken. Zonder deze
-- guard kon elke schrijver ze verwijderen of hernoemen en daarmee alle
-- lastenoproepen, betalingen en uitgaven blokkeren.

CREATE OR REPLACE FUNCTION public.fn_guard_core_accounts()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_core text[] := ARRAY['4111','4419','4411','5141','6110','7011'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.code = ANY(v_core) THEN
      RAISE EXCEPTION
        'Kernrekening % van het PCSI-schema kan niet worden verwijderd', OLD.code
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.code = ANY(v_core) AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION
      'De code van kernrekening % kan niet worden gewijzigd', OLD.code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trig_00_core_accounts ON public.accounts;
CREATE TRIGGER trig_00_core_accounts
  BEFORE UPDATE OR DELETE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_core_accounts();

-- ---------------------------------------------------------------------------
-- 7. FIFO neemt nu een rijvergrendeling  (P1-8 raakvlak)
-- ---------------------------------------------------------------------------
-- Zonder FOR UPDATE konden twee gelijktijdige betalingen dezelfde openstaande
-- post afboeken; het teveel belandde dan niet op 4419 maar verdween alsnog.

CREATE OR REPLACE FUNCTION public.fn_payment_fifo()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_remaining numeric := NEW.amount;
  v_alloc     RECORD;
  v_apply     numeric;
BEGIN
  FOR v_alloc IN
    SELECT ca.id, ca.organization_id, (ca.amount - ca.settled_amount) AS open_amount
      FROM public.charge_allocations ca
      JOIN public.charge_calls       cc ON cc.id = ca.charge_call_id
      JOIN public.fiscal_years       fy ON fy.id = cc.fiscal_year_id
     WHERE ca.owner_id    = NEW.owner_id
       AND fy.building_id = NEW.building_id
       AND ca.amount      > ca.settled_amount
     ORDER BY cc.due_date ASC NULLS LAST, cc.call_date ASC, ca.created_at ASC
       FOR UPDATE OF ca
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_apply := LEAST(v_remaining, v_alloc.open_amount);

    INSERT INTO public.payment_allocations(
      organization_id, payment_id, charge_allocation_id, amount
    ) VALUES (v_alloc.organization_id, NEW.id, v_alloc.id, v_apply);

    UPDATE public.charge_allocations
       SET settled_amount = settled_amount + v_apply
     WHERE id = v_alloc.id;

    v_remaining := v_remaining - v_apply;
  END LOOP;

  RETURN NEW;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. receipts_update kende geen uploader-beperking  (P0-2 raakvlak)
-- ---------------------------------------------------------------------------
-- Zonder die beperking kon een schrijver het object van een collega naar zich
-- toe schrijven en daarna verwijderen, waarmee de beperking op DELETE zinloos was.

DROP POLICY IF EXISTS receipts_update ON storage.objects;
CREATE POLICY receipts_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'receipts'
    AND public.can_write(public.receipt_path_org(name))
    AND (owner = auth.uid()
         OR public.can_manage_members(public.receipt_path_org(name)))
  )
  WITH CHECK (
    bucket_id = 'receipts'
    AND public.can_write(public.receipt_path_org(name))
    AND public.receipt_path_building_ok(name)
  );

-- ---------------------------------------------------------------------------
-- 9. Oude signed URL's opruimen  (P0-3 afronding)
-- ---------------------------------------------------------------------------
-- Waar het pad succesvol is overgenomen heeft de langlevende URL geen functie
-- meer en vormt hij alleen nog risico.

UPDATE public.expenses
   SET receipt_url = NULL
 WHERE receipt_path IS NOT NULL
   AND receipt_url  IS NOT NULL;

-- Rechten opnieuw dichtzetten voor alles wat in deze migratie is aangemaakt.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname <> 'create_organization'
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;
END $do$;

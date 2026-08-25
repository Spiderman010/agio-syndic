-- m16 — Flexible allocation engine, deel 5: invarianten en bewaking

-- ============================ de harde businessregel ========================
-- Sigma charge_allocations.amount_cents = charge_calls.alloc_total_cents, altijd.
--
-- Een gewone CHECK kan dit niet: die ziet een rij, nooit een som over rijen.
-- Daarom twee DEFERRABLE INITIALLY DEFERRED constraint triggers, TWEEZIJDIG
-- opgehangen:
--   kant A op charge_calls        -> vuurt gegarandeerd, want er wordt altijd
--                                    precies een rij ingevoegd. Dit is de kant
--                                    die het LEGE geval vangt; kant B zou nul
--                                    allocatierijen nooit zien.
--   kant B op charge_allocations  -> vangt latere mutaties, inclusief DELETE.
--
-- SET CONSTRAINTS ALL DEFERRED kan een deferred check alleen uitstellen tot
-- commit, nooit overslaan.
CREATE OR REPLACE FUNCTION public.fn_charge_alloc_total_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_call   uuid;
  v_cc     RECORD;
  v_n      int;
  v_sum    bigint;
  v_wsum   bigint;
  v_badrnk int;
BEGIN
  v_call := CASE TG_OP WHEN 'DELETE' THEN OLD.charge_call_id
                       ELSE coalesce(NEW.charge_call_id, NEW.id) END;

  SELECT * INTO v_cc FROM public.charge_calls WHERE id = v_call;
  -- Ouderrij is weg (cascade van gebouw of organisatie): niets te controleren.
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*), coalesce(sum(amount_cents),0), coalesce(sum(weight_micro),0)
    INTO v_n, v_sum, v_wsum
    FROM public.charge_allocations WHERE charge_call_id = v_call;

  IF v_sum <> v_cc.alloc_total_cents THEN
    RAISE EXCEPTION
      'ALLOC_SUM_MISMATCH: de verdeling van lastenoproep % telt op tot % centen in plaats van %.',
      v_call, v_sum, v_cc.alloc_total_cents USING ERRCODE = '23514';
  END IF;
  IF v_n <> v_cc.alloc_unit_count THEN
    RAISE EXCEPTION
      'ALLOC_COUNT_MISMATCH: lastenoproep % heeft % allocatieregels terwijl de snapshot % deelnemers vastlegt.',
      v_call, v_n, v_cc.alloc_unit_count USING ERRCODE = '23514';
  END IF;
  IF v_wsum <> v_cc.alloc_denominator THEN
    RAISE EXCEPTION
      'ALLOC_DENOM_MISMATCH: de som van de gewichten van lastenoproep % is % in plaats van %.',
      v_call, v_wsum, v_cc.alloc_denominator USING ERRCODE = '23514';
  END IF;

  -- De rang moet exact de gedeclareerde tie-breaker volgen. Zonder deze toets
  -- zou een permutatie van de rangen alle constraints passeren en de restcenten
  -- naar andere eigenaars verplaatsen, terwijl de som blijft kloppen.
  SELECT count(*) INTO v_badrnk FROM (
    SELECT remainder_rank,
           row_number() OVER (ORDER BY remainder DESC, unit_id ASC) AS rn
      FROM public.charge_allocations WHERE charge_call_id = v_call) q
   WHERE q.remainder_rank <> q.rn;
  IF v_badrnk > 0 THEN
    RAISE EXCEPTION
      'ALLOC_RANK_MISMATCH: de afrondingsvolgorde van lastenoproep % volgt niet de vastgelegde tie-breaker.',
      v_call USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER trig_zz_cc_alloc_total
  AFTER INSERT OR UPDATE ON public.charge_calls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_charge_alloc_total_check();

CREATE CONSTRAINT TRIGGER trig_zz_ca_alloc_total
  AFTER INSERT OR UPDATE OR DELETE ON public.charge_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_charge_alloc_total_check();

-- ============================ onveranderlijkheid ============================
-- settled_amount MAG muteren: dat is een lopend saldo dat FIFO bijwerkt.
-- Alle snapshot- en bedragvelden niet.
CREATE OR REPLACE FUNCTION public.fn_guard_ca_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
BEGIN
  IF NEW.charge_call_id       IS DISTINCT FROM OLD.charge_call_id
  OR NEW.unit_id              IS DISTINCT FROM OLD.unit_id
  OR NEW.owner_id             IS DISTINCT FROM OLD.owner_id
  OR NEW.building_id          IS DISTINCT FROM OLD.building_id
  OR NEW.amount               IS DISTINCT FROM OLD.amount
  OR NEW.amount_cents         IS DISTINCT FROM OLD.amount_cents
  OR NEW.weight_micro         IS DISTINCT FROM OLD.weight_micro
  OR NEW.base_cents           IS DISTINCT FROM OLD.base_cents
  OR NEW.remainder            IS DISTINCT FROM OLD.remainder
  OR NEW.remainder_rank       IS DISTINCT FROM OLD.remainder_rank
  OR NEW.extra_cent           IS DISTINCT FROM OLD.extra_cent
  OR NEW.call_total_cents     IS DISTINCT FROM OLD.call_total_cents
  OR NEW.call_denominator     IS DISTINCT FROM OLD.call_denominator
  OR NEW.call_remainder_cents IS DISTINCT FROM OLD.call_remainder_cents
  OR NEW.ownership_id         IS DISTINCT FROM OLD.ownership_id
  OR NEW.ownership_share_ppm  IS DISTINCT FROM OLD.ownership_share_ppm THEN
    RAISE EXCEPTION
      'ALLOC_SNAPSHOT_IMMUTABLE: de verdeling van een vastgelegde lastenoproep kan niet worden gewijzigd. Trek de oproep in en leg hem opnieuw vast.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER trig_00_ca_snapshot_immutable BEFORE UPDATE ON public.charge_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_ca_snapshot_immutable();

CREATE OR REPLACE FUNCTION public.fn_guard_cc_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
BEGIN
  IF NEW.total_amount       IS DISTINCT FROM OLD.total_amount
  OR NEW.fiscal_year_id     IS DISTINCT FROM OLD.fiscal_year_id
  OR NEW.building_id        IS DISTINCT FROM OLD.building_id
  OR NEW.allocation_rule_id IS DISTINCT FROM OLD.allocation_rule_id
  OR NEW.alloc_method       IS DISTINCT FROM OLD.alloc_method
  OR NEW.alloc_scope        IS DISTINCT FROM OLD.alloc_scope
  OR NEW.alloc_weight_source IS DISTINCT FROM OLD.alloc_weight_source
  OR NEW.alloc_total_cents  IS DISTINCT FROM OLD.alloc_total_cents
  OR NEW.alloc_denominator  IS DISTINCT FROM OLD.alloc_denominator
  OR NEW.alloc_unit_count   IS DISTINCT FROM OLD.alloc_unit_count
  OR NEW.alloc_remainder_cents IS DISTINCT FROM OLD.alloc_remainder_cents
  OR NEW.call_date          IS DISTINCT FROM OLD.call_date THEN
    RAISE EXCEPTION
      'ALLOC_CALL_IMMUTABLE: een vastgelegde lastenoproep kan niet worden gewijzigd. Trek hem in en leg hem opnieuw vast.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER trig_00_cc_immutable BEFORE UPDATE ON public.charge_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_cc_immutable();

-- ===================== correctieroute: intrekken ============================
-- Een oproep met betalingskoppelingen mag niet verdwijnen: payment_allocations
-- cascadeert weg en 4111 zou stil uiteenlopen met exact het betaalde bedrag.
--
-- De NOT FOUND-escape is load-bearing: bij DELETE FROM buildings of
-- organizations cascadeert PostgreSQL van ouder naar kind, en zonder deze
-- escape zou de guard de hele verwijdering laten doodlopen. Dat is exact de
-- fout die m11 punt 5 eerder moest terugdraaien.
CREATE OR REPLACE FUNCTION public.fn_guard_cc_delete_paid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fiscal_years WHERE id = OLD.fiscal_year_id) THEN
    RETURN OLD;   -- ouder is al weg: cascade doorlaten
  END IF;

  SELECT count(*) INTO n
    FROM public.payment_allocations pa
    JOIN public.charge_allocations ca ON ca.id = pa.charge_allocation_id
   WHERE ca.charge_call_id = OLD.id;
  IF n > 0 THEN
    RAISE EXCEPTION
      'ALLOC_CALL_PAID: deze lastenoproep heeft % betalingskoppeling(en) en kan niet worden ingetrokken.', n
      USING ERRCODE = '23514';
  END IF;

  -- journal_entries.source_id heeft geen FK; zonder deze opruiming blijft de
  -- journaalpost achter terwijl de oproep verdwijnt.
  DELETE FROM public.journal_entries
   WHERE source = 'charge' AND source_id = OLD.id;
  RETURN OLD;
END $fn$;

CREATE TRIGGER trig_00_cc_delete_paid BEFORE DELETE ON public.charge_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_cc_delete_paid();

-- ================== volledigheid van een percentageregel ====================
CREATE OR REPLACE FUNCTION public.fn_rule_complete_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_rule uuid;
  v_r    RECORD;
  v_sum  numeric;
BEGIN
  v_rule := CASE TG_OP WHEN 'DELETE' THEN OLD.rule_id ELSE NEW.rule_id END;

  SELECT * INTO v_r FROM public.allocation_rules WHERE id = v_rule;
  IF NOT FOUND THEN RETURN NULL; END IF;          -- zelfde escape als hierboven
  IF v_r.method <> 'percentage' THEN RETURN NULL; END IF;
  IF v_r.status <> 'active' THEN RETURN NULL; END IF;

  SELECT coalesce(sum(weight),0) INTO v_sum
    FROM public.allocation_rule_weights WHERE rule_id = v_rule;
  IF v_sum <> 100 THEN
    RAISE EXCEPTION
      'ALLOC_PCT_SUM: de percentages van verdeelregel "%" tellen op tot %%%, niet tot 100%%.',
      v_r.label, to_char(v_sum, 'FM999990.000000') USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER trig_zz_rule_complete_w
  AFTER INSERT OR UPDATE OR DELETE ON public.allocation_rule_weights
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_rule_complete_check();

-- ===================== FIFO: totale ordening ================================
-- Alle allocaties van een oproep worden door EEN insert geschreven en delen dus
-- dezelfde created_at (now() is transactietijd). Zonder eindtiebreaker was het
-- planafhankelijk welk lot werd afgeboekt. Dit ontwerp schrijft bovendien
-- gegarandeerd een rij per lot, dus die kans is structureel groter geworden.
CREATE OR REPLACE FUNCTION public.fn_payment_fifo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
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
     ORDER BY cc.due_date ASC NULLS LAST, cc.call_date ASC, ca.created_at ASC,
              ca.unit_id ASC, ca.id ASC
       FOR UPDATE OF ca
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_apply := LEAST(v_remaining, v_alloc.open_amount);
    INSERT INTO public.payment_allocations(organization_id, payment_id, charge_allocation_id, amount)
    VALUES (v_alloc.organization_id, NEW.id, v_alloc.id, v_apply);
    UPDATE public.charge_allocations SET settled_amount = settled_amount + v_apply
     WHERE id = v_alloc.id;
    v_remaining := v_remaining - v_apply;
  END LOOP;
  RETURN NEW;
END $fn$;

-- ============================ TRUNCATE-slot =================================
CREATE OR REPLACE FUNCTION public.fn_guard_no_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
BEGIN
  RAISE EXCEPTION 'ALLOC_TRUNCATE_BLOCKED: TRUNCATE is op deze tabel niet toegestaan'
    USING ERRCODE = '23514';
END $fn$;

CREATE TRIGGER trig_zz_no_truncate BEFORE TRUNCATE ON public.charge_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_guard_no_truncate();
CREATE TRIGGER trig_zz_no_truncate BEFORE TRUNCATE ON public.charge_calls
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_guard_no_truncate();
CREATE TRIGGER trig_zz_no_truncate BEFORE TRUNCATE ON public.charge_call_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_guard_no_truncate();

REVOKE TRUNCATE ON public.charge_allocations FROM anon, authenticated;
REVOKE TRUNCATE ON public.charge_calls       FROM anon, authenticated;
REVOKE TRUNCATE ON public.journal_lines      FROM anon, authenticated;
REVOKE TRUNCATE ON public.journal_entries    FROM anon, authenticated;

-- ============================ meetbaarheid ==================================
-- Preventie is exact en lokaal (een oproep) en zit in constraints. Detectie is
-- breed en cumulatief (het grootboek over alle boekjaren) en zit in een view:
-- een constraint die te breed is wordt op een dag uitgezet, en dan heb je geen
-- constraint EN geen meting.
CREATE VIEW public.v_allocation_integrity
WITH (security_invoker = true) AS
SELECT cc.id AS charge_call_id, cc.organization_id, cc.building_id,
       cc.fiscal_year_id, cc.call_date, cc.label,
       cc.alloc_total_cents, coalesce(sum(ca.amount_cents), 0) AS toegewezen_cents,
       cc.alloc_unit_count, count(ca.id) AS allocatieregels,
       (cc.alloc_total_cents = coalesce(sum(ca.amount_cents), 0)
        AND cc.alloc_unit_count = count(ca.id)) AS ok
  FROM public.charge_calls cc
  LEFT JOIN public.charge_allocations ca ON ca.charge_call_id = cc.id
 GROUP BY cc.id;

CREATE VIEW public.v_reconciliation_4111
WITH (security_invoker = true) AS
SELECT je.organization_id, je.building_id, je.fiscal_year_id,
       sum(jl.debit - jl.credit) AS grootboek_4111,
       (SELECT coalesce(sum(ca.amount), 0)
          FROM public.charge_allocations ca
          JOIN public.charge_calls cc ON cc.id = ca.charge_call_id
         WHERE cc.fiscal_year_id = je.fiscal_year_id) AS subadministratie,
       sum(jl.debit - jl.credit) -
       (SELECT coalesce(sum(ca.amount), 0)
          FROM public.charge_allocations ca
          JOIN public.charge_calls cc ON cc.id = ca.charge_call_id
         WHERE cc.fiscal_year_id = je.fiscal_year_id) AS verschil
  FROM public.journal_entries je
  JOIN public.journal_lines jl ON jl.journal_entry_id = je.id
  JOIN public.accounts a ON a.id = jl.account_id AND a.code = '4111'
 WHERE je.source = 'charge'
 GROUP BY je.organization_id, je.building_id, je.fiscal_year_id;

GRANT SELECT ON public.v_allocation_integrity TO authenticated;
GRANT SELECT ON public.v_reconciliation_4111  TO authenticated;
REVOKE ALL ON public.v_allocation_integrity FROM anon;
REVOKE ALL ON public.v_reconciliation_4111  FROM anon;

REVOKE ALL ON FUNCTION public.fn_charge_alloc_total_check()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_ca_snapshot_immutable()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_cc_immutable()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_cc_delete_paid()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rule_complete_check()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_no_truncate()             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_payment_fifo()                  FROM PUBLIC, anon, authenticated;

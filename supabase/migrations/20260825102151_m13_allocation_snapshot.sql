-- m13 — Flexible allocation engine, deel 2: snapshot en FK-reparaties

-- ---------------------------------------------------------- charge_calls ----
ALTER TABLE public.charge_calls
  ADD COLUMN building_id            uuid,
  ADD COLUMN allocation_rule_id     uuid,
  ADD COLUMN alloc_method           public.allocation_method,
  ADD COLUMN alloc_scope            public.allocation_scope,
  ADD COLUMN alloc_weight_source    public.allocation_weight_source,
  ADD COLUMN alloc_rule_code        text,
  ADD COLUMN alloc_rule_label       text,
  ADD COLUMN alloc_rule_revision    int,
  ADD COLUMN alloc_block_id         uuid,
  ADD COLUMN alloc_block_code       text,
  ADD COLUMN alloc_total_cents      bigint,
  ADD COLUMN alloc_denominator      bigint,
  ADD COLUMN alloc_unit_count       int,
  ADD COLUMN alloc_remainder_cents  int,
  ADD COLUMN alloc_tie_breaker      text,
  ADD COLUMN alloc_algo_version     int,
  ADD COLUMN alloc_partial_denominator boolean NOT NULL DEFAULT false;

-- Er bestaan nul lastenoproepen, dus NOT NULL kan meteen.
ALTER TABLE public.charge_calls
  ALTER COLUMN building_id           SET NOT NULL,
  ALTER COLUMN allocation_rule_id    SET NOT NULL,
  ALTER COLUMN alloc_method          SET NOT NULL,
  ALTER COLUMN alloc_scope           SET NOT NULL,
  ALTER COLUMN alloc_weight_source   SET NOT NULL,
  ALTER COLUMN alloc_rule_code       SET NOT NULL,
  ALTER COLUMN alloc_rule_label      SET NOT NULL,
  ALTER COLUMN alloc_rule_revision   SET NOT NULL,
  ALTER COLUMN alloc_total_cents     SET NOT NULL,
  ALTER COLUMN alloc_denominator     SET NOT NULL,
  ALTER COLUMN alloc_unit_count      SET NOT NULL,
  ALTER COLUMN alloc_remainder_cents SET NOT NULL,
  ALTER COLUMN alloc_tie_breaker     SET NOT NULL,
  ALTER COLUMN alloc_algo_version    SET NOT NULL;

ALTER TABLE public.charge_calls
  ADD CONSTRAINT cc_fy_building_fk
    FOREIGN KEY (fiscal_year_id, building_id)
    REFERENCES public.fiscal_years(id, building_id) ON DELETE CASCADE,
  ADD CONSTRAINT cc_rule_building_fk
    FOREIGN KEY (allocation_rule_id, building_id)
    REFERENCES public.allocation_rules(id, building_id),
  ADD CONSTRAINT cc_block_building_fk
    FOREIGN KEY (alloc_block_id, building_id)
    REFERENCES public.blocks(id, building_id),
  ADD CONSTRAINT cc_id_building_key UNIQUE (id, building_id),
  -- FK-doel voor de declaratieve rekencontrole op charge_allocations.
  ADD CONSTRAINT cc_alloc_params_key
    UNIQUE (id, alloc_total_cents, alloc_denominator, alloc_remainder_cents);

-- NaN passeert `> 0` (NaN > 0 is true) en klapt daarna op een niet-vertaalbare
-- 0A000 bij de cast naar bigint. `NaN < Infinity` is false, dus deze ene
-- conjunct sluit NaN uit.
ALTER TABLE public.charge_calls DROP CONSTRAINT charge_calls_total_amount_check;
ALTER TABLE public.charge_calls
  ADD CONSTRAINT cc_total_amount_ck
    CHECK (total_amount > 0 AND total_amount < 'Infinity'::numeric),
  ADD CONSTRAINT cc_total_cents_ck
    CHECK (alloc_total_cents = round(total_amount * 100)::bigint),
  ADD CONSTRAINT cc_denominator_ck  CHECK (alloc_denominator > 0),
  ADD CONSTRAINT cc_unit_count_ck   CHECK (alloc_unit_count > 0),
  ADD CONSTRAINT cc_remainder_ck
    CHECK (alloc_remainder_cents >= 0 AND alloc_remainder_cents < alloc_unit_count),
  ADD CONSTRAINT cc_algo_ck         CHECK (alloc_algo_version >= 1),
  ADD CONSTRAINT cc_tie_breaker_ck  CHECK (alloc_tie_breaker = 'remainder_desc_unit_id_asc'),
  ADD CONSTRAINT cc_block_scope_ck  CHECK ((alloc_scope = 'block') = (alloc_block_id IS NOT NULL)),
  -- Noemer-identiteiten per methode; overleven DISABLE TRIGGER ALL.
  ADD CONSTRAINT cc_equal_denom_ck
    CHECK (alloc_method <> 'equal'      OR alloc_denominator = alloc_unit_count::bigint * 1000000),
  ADD CONSTRAINT cc_pct_denom_ck
    CHECK (alloc_method <> 'percentage' OR alloc_denominator = 100000000),
  ADD CONSTRAINT cc_manual_denom_ck
    CHECK (alloc_method <> 'manual'     OR alloc_denominator = alloc_total_cents);

-- Een netwerkretry mag geen tweede oproep en dus geen tweede 4111-boeking geven.
CREATE UNIQUE INDEX cc_fy_type_period_idx
  ON public.charge_calls (fiscal_year_id, type, period) WHERE period IS NOT NULL;

-- ---------------------------------------------------- charge_allocations ----
ALTER TABLE public.charge_allocations
  ADD COLUMN building_id          uuid,
  ADD COLUMN weight_micro         bigint,
  ADD COLUMN base_cents           bigint,
  ADD COLUMN remainder            bigint,
  ADD COLUMN remainder_rank       int,
  ADD COLUMN extra_cent           smallint,
  ADD COLUMN amount_cents         bigint,
  ADD COLUMN call_total_cents     bigint,
  ADD COLUMN call_denominator     bigint,
  ADD COLUMN call_remainder_cents int,
  ADD COLUMN ownership_id         uuid,
  ADD COLUMN ownership_share_ppm  int;

ALTER TABLE public.charge_allocations
  ALTER COLUMN building_id          SET NOT NULL,
  ALTER COLUMN weight_micro         SET NOT NULL,
  ALTER COLUMN base_cents           SET NOT NULL,
  ALTER COLUMN remainder            SET NOT NULL,
  ALTER COLUMN remainder_rank       SET NOT NULL,
  ALTER COLUMN extra_cent           SET NOT NULL,
  ALTER COLUMN amount_cents         SET NOT NULL,
  ALTER COLUMN call_total_cents     SET NOT NULL,
  ALTER COLUMN call_denominator     SET NOT NULL,
  ALTER COLUMN call_remainder_cents SET NOT NULL;

-- FK-reparaties. SET NULL wiste het bewijs wie wat verschuldigd was; CASCADE op
-- unit_id wiste historische allocaties terwijl 4111 bleef staan.
ALTER TABLE public.charge_allocations
  DROP CONSTRAINT charge_allocations_owner_id_fkey,
  DROP CONSTRAINT charge_allocations_unit_id_fkey,
  DROP CONSTRAINT charge_allocations_charge_call_id_fkey;

ALTER TABLE public.charge_allocations
  ADD CONSTRAINT ca_owner_org_fk
    FOREIGN KEY (owner_id, organization_id)
    REFERENCES public.owners(id, organization_id),
  ADD CONSTRAINT ca_unit_building_fk
    FOREIGN KEY (unit_id, building_id)
    REFERENCES public.units(id, building_id),
  ADD CONSTRAINT ca_call_building_fk
    FOREIGN KEY (charge_call_id, building_id)
    REFERENCES public.charge_calls(id, building_id) ON DELETE CASCADE,
  ADD CONSTRAINT ca_ownership_fk
    FOREIGN KEY (ownership_id) REFERENCES public.ownership(id),
  -- Bindt elke allocatierij aan exact de rekenparameters van haar oproep.
  ADD CONSTRAINT ca_call_params_fk
    FOREIGN KEY (charge_call_id, call_total_cents, call_denominator, call_remainder_cents)
    REFERENCES public.charge_calls(id, alloc_total_cents, alloc_denominator, alloc_remainder_cents)
    ON DELETE CASCADE;

-- Declaratieve rekencontrole. div() en mod() op numeric zijn IMMUTABLE en dus
-- toegestaan in een kale CHECK. Hiermee is niet alleen het TOTAAL maar ook de
-- VERDELING natrekbaar uit de snapshot alleen: base, restwaarde, rang en de
-- extra cent liggen alle vier declaratief vast.
ALTER TABLE public.charge_allocations
  ADD CONSTRAINT ca_weight_ck    CHECK (weight_micro >= 0),
  ADD CONSTRAINT ca_base_ck      CHECK (base_cents >= 0 AND remainder >= 0),
  ADD CONSTRAINT ca_extra_ck     CHECK (extra_cent IN (0,1)),
  ADD CONSTRAINT ca_rank_ck      CHECK (remainder_rank >= 1),
  ADD CONSTRAINT ca_cents_ck     CHECK (amount_cents = base_cents + extra_cent),
  ADD CONSTRAINT ca_money_ck     CHECK (amount = amount_cents::numeric / 100),
  ADD CONSTRAINT ca_div_ck
    CHECK (base_cents = div(weight_micro::numeric * call_total_cents, call_denominator::numeric)::bigint),
  ADD CONSTRAINT ca_mod_ck
    CHECK (remainder  = mod(weight_micro::numeric * call_total_cents, call_denominator::numeric)::bigint),
  ADD CONSTRAINT ca_extra_rank_ck
    CHECK (extra_cent = CASE WHEN remainder_rank <= call_remainder_cents THEN 1 ELSE 0 END),
  ADD CONSTRAINT ca_share_ck
    CHECK (ownership_share_ppm IS NULL OR (ownership_share_ppm BETWEEN 1 AND 1000000)),
  ADD CONSTRAINT ca_call_rank_key UNIQUE (charge_call_id, remainder_rank);

CREATE INDEX ca_unit_idx  ON public.charge_allocations (unit_id);
CREATE INDEX ca_owner_idx ON public.charge_allocations (owner_id);

-- ------------------------------------------------------ charge_call_lines ---
-- Brondocument voor `manual`. Wordt uitsluitend door de RPC geschreven, in
-- dezelfde transactie en ná de oproep, zodat de volgorde vaststaat.
CREATE TABLE public.charge_call_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id     uuid NOT NULL,
  charge_call_id  uuid NOT NULL,
  unit_id         uuid NOT NULL,
  amount_cents    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ccl_amount_ck CHECK (amount_cents >= 0),
  CONSTRAINT ccl_call_fk
    FOREIGN KEY (charge_call_id, building_id)
    REFERENCES public.charge_calls(id, building_id) ON DELETE CASCADE,
  CONSTRAINT ccl_unit_fk
    FOREIGN KEY (unit_id, building_id)
    REFERENCES public.units(id, building_id),
  CONSTRAINT ccl_building_org_fk
    FOREIGN KEY (building_id, organization_id)
    REFERENCES public.buildings(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT ccl_call_unit_key UNIQUE (charge_call_id, unit_id)
);
CREATE INDEX ccl_call_idx ON public.charge_call_lines (charge_call_id);

ALTER TABLE public.charge_call_lines ENABLE ROW LEVEL SECURITY;

-- Lezen mag; schrijven loopt uitsluitend via de RPC.
CREATE POLICY charge_call_lines_select ON public.charge_call_lines FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));
CREATE POLICY charge_call_lines_insert ON public.charge_call_lines FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY charge_call_lines_update ON public.charge_call_lines FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY charge_call_lines_delete ON public.charge_call_lines FOR DELETE TO authenticated
  USING (false);

REVOKE ALL ON public.charge_call_lines FROM anon;
GRANT SELECT ON public.charge_call_lines TO authenticated;

-- Dezelfde gesloten-boekjaarring als elke andere boekjaargebonden tabel.
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_charge_call_lines()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_fy uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT fiscal_year_id INTO v_fy FROM public.charge_calls WHERE id = OLD.charge_call_id;
    IF NOT FOUND THEN RETURN OLD; END IF;   -- ouder is al weg: cascade doorlaten
    PERFORM public.fn_assert_fy_open(v_fy, 'verwijderen van een handmatige verdeelregel');
    RETURN OLD;
  END IF;
  SELECT fiscal_year_id INTO v_fy FROM public.charge_calls WHERE id = NEW.charge_call_id;
  IF FOUND THEN
    PERFORM public.fn_assert_fy_open(v_fy, 'wijzigen van een handmatige verdeelregel');
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER trig_00_ccl_closed_fy
  BEFORE INSERT OR UPDATE OR DELETE ON public.charge_call_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_closed_fy_charge_call_lines();
CREATE TRIGGER trig_00_org_immutable BEFORE UPDATE ON public.charge_call_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_org_immutable();

REVOKE ALL ON FUNCTION public.fn_guard_closed_fy_charge_call_lines() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.charge_call_lines IS
  'Brondocument van een handmatige verdeling. Enige bewijs van de handmatige keuze; onveranderlijk na vastlegging en gebonden aan het gesloten-boekjaarregime.';
COMMENT ON CONSTRAINT ca_div_ck ON public.charge_allocations IS
  'Maakt de VERDELING natrekbaar, niet alleen het totaal: base_cents volgt declaratief uit gewicht, oproeptotaal en noemer.';

-- ============================================================================
-- TESTFIXTURE — pre-m31 basislijn voor lokale integratietests
-- ============================================================================
--
-- DIT IS GEEN MIGRATIE EN GEEN RECONSTRUCTIE VAN PRODUCTIE.
--
-- Dit bestand hoort NIET in `supabase/migrations/`, wordt NOOIT op een
-- Supabase-project toegepast en beschrijft niet het volledige schema van Agio
-- Syndic. Het bouwt uitsluitend de objecten die m31 en
-- `supabase/tests/m31_charge_call_date_within_fy.sql` werkelijk aanraken.
--
-- Aanleiding is dezelfde als bij `pre_m30_baseline.sql`: de migratieketen kan
-- een lege database niet opbouwen, want m1-m5 en twee util-migraties zijn
-- bewust lege plaatshouders (zie docs/migration-drift.md).
--
-- ── WAT DEZE FIXTURE MODELLEERT ────────────────────────────────────────────
--
-- ROLLEN      anon, authenticated, service_role
-- SCHEMAS     auth (users, uid())
-- ENUMS       org_role, charge_call_type
-- TABELLEN    organizations, memberships, buildings, fiscal_years, charge_calls
-- FUNCTIES    auth.uid, current_org_role, can_write, can_manage_members,
--             fn_assert_fy_open, fn_guard_closed_fy_charge_calls,
--             fn_guard_cc_immutable, fn_guard_fiscal_year_immutable
-- TRIGGERS    trig_00_cc_closed_fy, trig_00_cc_immutable, trig_00_fy_immutable
-- POLICIES    charge_calls_select/insert/update (insert+update WITH CHECK false)
--
-- ── WAT DEZE FIXTURE BEWUST NIET MODELLEERT ────────────────────────────────
--
-- `create_charge_call` zelf, `allocation_rules`, `blocks`, `units`,
-- `charge_allocations` en de journaalketen. m31 raakt die niet aan, en het
-- meeslepen ervan zou de fixture een schaduwreconstructie van productie maken.
-- De `alloc_*`-kolommen staan er wel op, omdat `fn_guard_cc_immutable` ze bij
-- naam noemt en de regressietest daarop moet kunnen steunen.
-- ============================================================================

DO $$ BEGIN CREATE ROLE anon         NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role  NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY,
  email text
);

-- `auth.uid()` leest dezelfde GUC als Supabase; de tests zetten die expliciet.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$ BEGIN
  CREATE TYPE public.org_role AS ENUM ('owner','admin','manager','accountant','reader');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.charge_call_type AS ENUM ('regulier','exceptionnel');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.organizations (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            public.org_role NOT NULL,
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.buildings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  CONSTRAINT buildings_id_org_key UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS public.fiscal_years (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  building_id     uuid NOT NULL,
  year            int  NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  CONSTRAINT fy_period_ck   CHECK (end_date >= start_date),
  CONSTRAINT fy_id_org_key  UNIQUE (id, organization_id),
  CONSTRAINT fy_id_bld_key  UNIQUE (id, building_id),
  CONSTRAINT fy_building_org_fk
    FOREIGN KEY (building_id, organization_id)
    REFERENCES public.buildings(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.charge_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  building_id     uuid NOT NULL,
  fiscal_year_id  uuid NOT NULL,
  type            public.charge_call_type NOT NULL DEFAULT 'regulier',
  period          text,
  label           text,
  total_amount    numeric(14,2) NOT NULL,
  call_date       date NOT NULL,
  due_date        date,
  resolution_ref  text,
  -- Snapshotkop. Uitsluitend aanwezig omdat `fn_guard_cc_immutable` deze
  -- kolommen bij naam noemt; m31 raakt er geen enkele van aan.
  allocation_rule_id    uuid,
  alloc_method          text,
  alloc_scope           text,
  alloc_weight_source   text,
  alloc_rule_code       text,
  alloc_rule_label      text,
  alloc_rule_revision   int,
  alloc_block_id        uuid,
  alloc_block_code      text,
  alloc_total_cents     bigint,
  alloc_denominator     bigint,
  alloc_unit_count      int,
  alloc_remainder_cents int,
  alloc_tie_breaker     text,
  alloc_algo_version    int,
  alloc_partial_denominator boolean NOT NULL DEFAULT false,
  CONSTRAINT cc_total_amount_ck CHECK (total_amount > 0 AND total_amount < 'Infinity'::numeric),
  CONSTRAINT charge_calls_fy_org_fk
    FOREIGN KEY (fiscal_year_id, organization_id)
    REFERENCES public.fiscal_years(id, organization_id),
  CONSTRAINT cc_fy_building_fk
    FOREIGN KEY (fiscal_year_id, building_id)
    REFERENCES public.fiscal_years(id, building_id) ON DELETE CASCADE
);

-- ── rolpredicaten ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_org_role(p_org uuid)
RETURNS public.org_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT m.role FROM public.memberships m
   WHERE m.organization_id = p_org AND m.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.can_write(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.current_org_role(p_org) IN ('owner','admin','manager','accountant');
$$;

CREATE OR REPLACE FUNCTION public.can_manage_members(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.current_org_role(p_org) IN ('owner','admin');
$$;

-- ── bestaande poorten die m31 NIET mag breken ──────────────────────────────
-- Woordelijk overgenomen uit m9 (fn_assert_fy_open), m22
-- (fn_guard_closed_fy_charge_calls), m16 (fn_guard_cc_immutable) en m21
-- (fn_guard_fiscal_year_immutable, ingekort tot de periodetak die m31 raakt).

CREATE OR REPLACE FUNCTION public.fn_assert_fy_open(p_fy uuid, p_wat text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF p_fy IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.fiscal_years WHERE id = p_fy AND status = 'closed') THEN
    RAISE EXCEPTION 'Boekjaar is afgesloten: % is niet toegestaan', p_wat
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_charge_calls()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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

DROP TRIGGER IF EXISTS trig_00_cc_immutable ON public.charge_calls;
CREATE TRIGGER trig_00_cc_immutable BEFORE UPDATE ON public.charge_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_cc_immutable();

CREATE OR REPLACE FUNCTION public.fn_guard_fiscal_year_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'closed' THEN
      RAISE EXCEPTION 'Een afgesloten boekjaar kan niet worden verwijderd'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'closed' AND (
       NEW.year       IS DISTINCT FROM OLD.year
    OR NEW.start_date IS DISTINCT FROM OLD.start_date
    OR NEW.end_date   IS DISTINCT FROM OLD.end_date
    OR NEW.building_id IS DISTINCT FROM OLD.building_id
  ) THEN
    RAISE EXCEPTION
      'Periode en jaartal van een afgesloten boekjaar liggen vast; heropen het boekjaar eerst'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trig_00_fy_immutable ON public.fiscal_years;
CREATE TRIGGER trig_00_fy_immutable
  BEFORE UPDATE OR DELETE ON public.fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fiscal_year_immutable();

-- ── RLS: het enige schrijfpad is de RPC, dus directe DML staat dicht ───────
ALTER TABLE public.charge_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS charge_calls_select ON public.charge_calls;
DROP POLICY IF EXISTS charge_calls_insert ON public.charge_calls;
DROP POLICY IF EXISTS charge_calls_update ON public.charge_calls;
CREATE POLICY charge_calls_select ON public.charge_calls FOR SELECT TO authenticated
  USING (public.current_org_role(organization_id) IS NOT NULL);
CREATE POLICY charge_calls_insert ON public.charge_calls FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY charge_calls_update ON public.charge_calls FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

ALTER TABLE public.fiscal_years ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiscal_years_all ON public.fiscal_years;
CREATE POLICY fiscal_years_all ON public.fiscal_years FOR ALL TO authenticated
  USING (public.current_org_role(organization_id) IS NOT NULL)
  WITH CHECK (public.can_write(organization_id));

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.charge_calls TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fiscal_years TO authenticated, service_role;
GRANT SELECT ON public.organizations, public.buildings, public.memberships TO authenticated, service_role;

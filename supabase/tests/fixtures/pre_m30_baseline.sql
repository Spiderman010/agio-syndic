-- ============================================================================
-- TESTFIXTURE — pre-m30 basislijn voor lokale integratietests
-- ============================================================================
--
-- DIT IS GEEN MIGRATIE EN GEEN RECONSTRUCTIE VAN PRODUCTIE.
--
-- Dit bestand hoort NIET in `supabase/migrations/`, wordt NOOIT op een
-- Supabase-project toegepast en beschrijft niet het volledige schema van Agio
-- Syndic. Het bouwt uitsluitend de objecten die m30 en
-- `supabase/tests/m30_ownership_transfer.sql` werkelijk aanraken, zodat die
-- migratie in een verse PostgreSQL 17-container kan worden getest zonder
-- productie-export.
--
-- Aanleiding: de migratieketen bevat zeven bewust lege plaatshouders (m1-m5,
-- util_create_organization_fn, create_receipts_bucket_rls). Een lege database
-- opbouwen door alle migraties af te spelen werkt daardoor niet — zie
-- docs/migration-drift.md. Zonder deze fixture was een productieschema-dump de
-- enige weg naar een testbare pre-m30-database.
--
-- ── WAT DEZE FIXTURE MODELLEERT ────────────────────────────────────────────
--
-- ROLLEN      anon, authenticated, service_role
-- SCHEMAS     auth (users, uid()), extensions
-- ENUMS       org_role, unit_type
-- TABELLEN    organizations, profiles, memberships, buildings, units, owners,
--             ownership, accounts, charge_allocations, payments, journal_entries
-- CONSTRAINTS owners_id_org_key, buildings_id_org_key, units_id_building_key,
--             ownership_unit_owner_start_key, ca_owner_org_fk
-- INDEXEN     ownership_primary_active_idx, ownership_unit_period_idx
-- FUNCTIES    auth.uid, current_org_role, can_write, seed_pcsi,
--             create_organization, fn_alloc_resolve_owner,
--             fn_guard_ownership_tenant, fn_guard_owner_delete_history,
--             fn_guard_unit_delete_history, fn_guard_building_delete_history,
--             fn_guard_last_owner
-- TRIGGERS    trig_00_ownership_tenant_guard, trig_00_owner_delete_history,
--             trig_00_unit_delete_history, trig_00_building_delete_history,
--             trig_guard_last_owner
-- POLICIES    ownership_select/insert/update/delete, owners_delete,
--             units_delete, buildings_delete
-- GRANTS      de pre-m30 toestand die m30 juist dichtzet: anon, authenticated
--             en service_role hebben SELECT/INSERT/UPDATE/DELETE op ownership
--
-- ── WAT DEZE FIXTURE BEWUST NIET MODELLEERT ────────────────────────────────
--
-- allocation_rules en de bijbehorende triggers, charge_calls, fiscal_years,
-- funds, documents, financial_reversals, tier_thresholds, annexe_rules,
-- document_types, storage-buckets, de PCSI-rekeningstructuur voorbij vijf
-- kernrekeningen, fn_guard_core_accounts, en elke policy die niet door de
-- m30-tests wordt geraakt. Raakt m30 of de testsuite zo'n object alsnog, dan
-- faalt de run onmiddellijk met een `does not exist`-fout. Dat is opzet: een
-- stilzwijgend werkende maar onvolledige fixture zou een tweede verborgen
-- waarheid worden.
--
-- Kolomtypen en -namen volgen de contracten zoals ze in m8, m12, m14, m18, m22
-- en m30 zijn vastgelegd. Waar een tabel meer kolommen heeft in productie zijn
-- alleen de kolommen overgenomen die de tests gebruiken.
-- ============================================================================

\set ON_ERROR_STOP on

-- ───────────────────────────────────────────────────────────── 1. rollen ────
-- Supabase levert deze rollen in zijn eigen image; op een kale postgres:17
-- maakt de fixture ze zelf, zodat GRANT/REVOKE en has_table_privilege werken.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $roles$;

GRANT anon, authenticated, service_role TO CURRENT_USER;


-- ──────────────────────────────────────────────────────────── 2. schemas ────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA public     TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth       TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

-- Minimale auth.users: de testsuite voegt alleen een `id` in.
CREATE TABLE IF NOT EXISTS auth.users (
  id         uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Contractgelijk aan de Supabase-implementatie: leest de `sub`-claim uit
-- `request.jwt.claims`. De testsuite stuurt daar volledig op.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid;
$$;


-- ────────────────────────────────────────────────────────────── 3. enums ────
DO $enums$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public' AND t.typname = 'org_role') THEN
    CREATE TYPE public.org_role AS ENUM ('owner','admin','manager','accountant','reader');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public' AND t.typname = 'unit_type') THEN
    CREATE TYPE public.unit_type AS ENUM ('appartement','parking','commercieel','kelder');
  END IF;
END $enums$;


-- ─────────────────────────────────────────────────────────── 4. tabellen ────
CREATE TABLE IF NOT EXISTS public.organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            public.org_role NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.buildings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  total_tantiemes integer NOT NULL DEFAULT 1000,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  label       text NOT NULL,
  unit_type   public.unit_type NOT NULL,
  tantiemes   integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.owners (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  full_name       text NOT NULL,
  is_company      boolean NOT NULL DEFAULT false,
  email           text,
  phone           text,
  language        text NOT NULL DEFAULT 'fr',
  is_mre          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- LET OP: `ownership` staat hier BEWUST ZONDER `organization_id`. Die kolom is
-- precies wat m30 toevoegt; de fixture modelleert de toestand ervoor.
CREATE TABLE IF NOT EXISTS public.ownership (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id           uuid NOT NULL REFERENCES public.units(id)  ON DELETE CASCADE,
  owner_id          uuid NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  share             numeric(10,6) NOT NULL DEFAULT 1,
  start_date        date NOT NULL,
  end_date          date,
  is_primary_debtor boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code            text NOT NULL,
  label           text NOT NULL,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS public.charge_allocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  unit_id         uuid NOT NULL REFERENCES public.units(id)  ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  amount_cents    bigint NOT NULL,
  label           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES public.owners(id) ON DELETE CASCADE,
  amount_cents    bigint NOT NULL,
  paid_on         date NOT NULL,
  reference       text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entry_date      date NOT NULL,
  description     text NOT NULL,
  amount_cents    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);


-- ──────────────────────────────────── 5. constraints en indexen (m8, m12) ───
ALTER TABLE public.owners    DROP CONSTRAINT IF EXISTS owners_id_org_key;
ALTER TABLE public.owners    ADD  CONSTRAINT owners_id_org_key    UNIQUE (id, organization_id);
ALTER TABLE public.buildings DROP CONSTRAINT IF EXISTS buildings_id_org_key;
ALTER TABLE public.buildings ADD  CONSTRAINT buildings_id_org_key UNIQUE (id, organization_id);
ALTER TABLE public.units     DROP CONSTRAINT IF EXISTS units_id_building_key;
ALTER TABLE public.units     ADD  CONSTRAINT units_id_building_key UNIQUE (id, building_id);

ALTER TABLE public.ownership DROP CONSTRAINT IF EXISTS ownership_unit_owner_start_key;
ALTER TABLE public.ownership ADD  CONSTRAINT ownership_unit_owner_start_key
  UNIQUE (unit_id, owner_id, start_date);

CREATE UNIQUE INDEX IF NOT EXISTS ownership_primary_active_idx
  ON public.ownership (unit_id) WHERE is_primary_debtor AND end_date IS NULL;
CREATE INDEX IF NOT EXISTS ownership_unit_period_idx
  ON public.ownership (unit_id, start_date, end_date);

ALTER TABLE public.charge_allocations DROP CONSTRAINT IF EXISTS ca_owner_org_fk;
ALTER TABLE public.charge_allocations ADD  CONSTRAINT ca_owner_org_fk
  FOREIGN KEY (owner_id, organization_id)
  REFERENCES public.owners(id, organization_id) ON DELETE CASCADE;


-- ────────────────────────────────────────────── 6. rolhelpers (m8, m10) ─────
CREATE OR REPLACE FUNCTION public.current_org_role(org uuid)
RETURNS public.org_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT m.role FROM public.memberships m
   WHERE m.organization_id = org AND m.user_id = auth.uid()
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.can_write(org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    public.current_org_role(org) IN ('owner','admin','manager','accountant'),
    false);
$$;

CREATE OR REPLACE FUNCTION public.is_org_member(org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.current_org_role(org) IS NOT NULL;
$$;


-- ───────────────────────────────── 7. organisatie aanmaken (m7, m8, m9) ─────
-- Vijf kernrekeningen met inline literals, precies zoals seed_pcsi in m7/m9:
-- er is geen sjabloontabel, dus een lege database is hier geen beletsel.
CREATE OR REPLACE FUNCTION public.seed_pcsi(p_org uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  INSERT INTO public.accounts(organization_id, code, label) VALUES
    (p_org, '4111', 'Coproprietaires - appels de fonds'),
    (p_org, '7011', 'Produits - charges courantes'),
    (p_org, '5141', 'Banque'),
    (p_org, '4411', 'Fournisseurs'),
    (p_org, '6110', 'Charges courantes')
  ON CONFLICT (organization_id, code) DO NOTHING;
END $fn$;

CREATE OR REPLACE FUNCTION public.create_organization(p_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_uid uuid; v_org uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.profiles(id) VALUES (v_uid) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations(name) VALUES (p_name) RETURNING id INTO v_org;
  INSERT INTO public.memberships(organization_id, user_id, role)
       VALUES (v_org, v_uid, 'owner');
  PERFORM public.seed_pcsi(v_org);

  RETURN v_org;
END $fn$;


-- ──────────────────────────────────────────── 8. verdeelmotor (m14) ─────────
-- Woordelijk het contract uit m14: inclusieve datumgrenzen, plus n_active en
-- n_primary waarop de mede-eigendomssemantiek van m30 steunt.
CREATE OR REPLACE FUNCTION public.fn_alloc_resolve_owner(p_unit uuid, p_call_date date)
RETURNS TABLE (ownership_id uuid, owner_id uuid, share_ppm int, n_active int, n_primary int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  WITH act AS (
    SELECT ow.id, ow.owner_id, ow.share, ow.start_date, ow.is_primary_debtor,
           round(ow.share * 1000000)::int AS ppm
      FROM public.ownership ow
     WHERE ow.unit_id = p_unit
       AND ow.start_date <= p_call_date
       AND (ow.end_date IS NULL OR ow.end_date >= p_call_date)
  )
  SELECT a.id, a.owner_id, a.ppm,
         (SELECT count(*) FROM act)::int,
         (SELECT count(*) FROM act WHERE is_primary_debtor)::int
    FROM act a
   ORDER BY a.is_primary_debtor DESC, a.share DESC, a.start_date DESC, a.id ASC
   LIMIT 1;
$fn$;


-- ────────────────────────────────────── 9. guards (m8, m18, m22) ────────────
-- Tenantguard uit m8: eigenaar en lot moeten in dezelfde organisatie zitten.
CREATE OR REPLACE FUNCTION public.fn_guard_ownership_tenant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_unit_org uuid; v_owner_org uuid;
BEGIN
  SELECT b.organization_id INTO v_unit_org
    FROM public.units u JOIN public.buildings b ON b.id = u.building_id
   WHERE u.id = NEW.unit_id;
  SELECT o.organization_id INTO v_owner_org
    FROM public.owners o WHERE o.id = NEW.owner_id;

  IF v_unit_org IS NULL THEN
    RAISE EXCEPTION 'Unit % bestaat niet', NEW.unit_id USING ERRCODE = '23503';
  END IF;
  IF v_owner_org IS NULL THEN
    RAISE EXCEPTION 'Eigenaar % bestaat niet', NEW.owner_id USING ERRCODE = '23503';
  END IF;
  IF v_unit_org <> v_owner_org THEN
    RAISE EXCEPTION 'Tenant-schending: eigenaar % hoort niet bij unit %',
      NEW.owner_id, NEW.unit_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trig_00_ownership_tenant_guard ON public.ownership;
CREATE TRIGGER trig_00_ownership_tenant_guard
  BEFORE INSERT OR UPDATE ON public.ownership
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_ownership_tenant();

-- Owner-deleteguard uit m18. Merk op dat de organisatie-escape hier al het
-- patroon gebruikt dat m30 sectie 6 overneemt.
CREATE OR REPLACE FUNCTION public.fn_guard_owner_delete_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.charge_allocations WHERE owner_id = OLD.id) THEN
    RAISE EXCEPTION 'ALLOC_OWNER_HAS_HISTORY: deze eigenaar heeft vastgelegde vorderingen.'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments WHERE owner_id = OLD.id) THEN
    RAISE EXCEPTION 'ALLOC_OWNER_HAS_PAYMENTS: deze eigenaar heeft geregistreerde betalingen.'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS trig_00_owner_delete_history ON public.owners;
CREATE TRIGGER trig_00_owner_delete_history BEFORE DELETE ON public.owners
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_owner_delete_history();

-- Unit-deleteguard uit m18.
CREATE OR REPLACE FUNCTION public.fn_guard_unit_delete_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.buildings WHERE id = OLD.building_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.charge_allocations WHERE unit_id = OLD.id) THEN
    RAISE EXCEPTION 'ALLOC_UNIT_HAS_HISTORY: dit lot komt voor in een vastgelegde lastenoproep.'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS trig_00_unit_delete_history ON public.units;
CREATE TRIGGER trig_00_unit_delete_history BEFORE DELETE ON public.units
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_unit_delete_history();

-- Building-deleteguard, contractgelijk aan m22: financiele historie blokkeert
-- een losse gebouwverwijdering, de organisatiecascade blijft door.
CREATE OR REPLACE FUNCTION public.fn_guard_building_delete_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.charge_allocations ca
      JOIN public.units u ON u.id = ca.unit_id
     WHERE u.building_id = OLD.id) THEN
    RAISE EXCEPTION 'BUILDING_HAS_FINANCIAL_HISTORY: dit gebouw heeft vastgelegde lasten.'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS trig_00_building_delete_history ON public.buildings;
CREATE TRIGGER trig_00_building_delete_history BEFORE DELETE ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_building_delete_history();

-- Laatste-ownerguard uit m18, inclusief de organisatie-escape.
CREATE OR REPLACE FUNCTION public.fn_guard_last_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_owners int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.role <> 'owner' THEN
    RETURN OLD;
  END IF;
  SELECT count(*) INTO v_owners FROM public.memberships
   WHERE organization_id = OLD.organization_id AND role = 'owner' AND id <> OLD.id;
  IF v_owners = 0 THEN
    RAISE EXCEPTION 'Organisatie moet minimaal een owner houden' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS trig_guard_last_owner ON public.memberships;
CREATE TRIGGER trig_guard_last_owner BEFORE DELETE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_last_owner();


-- ─────────────────────────────────────────── 10. RLS en policies (m8) ───────
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buildings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owners        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ownership     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_select ON public.organizations;
CREATE POLICY organizations_select ON public.organizations
  FOR SELECT TO authenticated USING (public.is_org_member(id));

DROP POLICY IF EXISTS memberships_select ON public.memberships;
CREATE POLICY memberships_select ON public.memberships
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS buildings_select ON public.buildings;
CREATE POLICY buildings_select ON public.buildings
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP POLICY IF EXISTS buildings_delete ON public.buildings;
CREATE POLICY buildings_delete ON public.buildings
  FOR DELETE TO authenticated USING (public.can_write(organization_id));

DROP POLICY IF EXISTS units_select ON public.units;
CREATE POLICY units_select ON public.units
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.buildings b
     WHERE b.id = units.building_id AND public.is_org_member(b.organization_id)));
DROP POLICY IF EXISTS units_delete ON public.units;
CREATE POLICY units_delete ON public.units
  FOR DELETE TO authenticated USING (EXISTS (
    SELECT 1 FROM public.buildings b
     WHERE b.id = units.building_id AND public.can_write(b.organization_id)));

DROP POLICY IF EXISTS owners_select ON public.owners;
CREATE POLICY owners_select ON public.owners
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP POLICY IF EXISTS owners_delete ON public.owners;
CREATE POLICY owners_delete ON public.owners
  FOR DELETE TO authenticated USING (public.can_write(organization_id));

-- De vier ownership-policies zoals m8 ze achterliet. m30 laat alleen
-- `ownership_select` staan; de postcheck van m30 controleert dat.
DROP POLICY IF EXISTS ownership_select ON public.ownership;
CREATE POLICY ownership_select ON public.ownership
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.units u JOIN public.buildings b ON b.id = u.building_id
     WHERE u.id = ownership.unit_id AND public.is_org_member(b.organization_id)));

DROP POLICY IF EXISTS ownership_insert ON public.ownership;
CREATE POLICY ownership_insert ON public.ownership
  FOR INSERT TO authenticated WITH CHECK (EXISTS (
    SELECT 1 FROM public.units u JOIN public.buildings b ON b.id = u.building_id
     WHERE u.id = ownership.unit_id AND public.can_write(b.organization_id)));

DROP POLICY IF EXISTS ownership_update ON public.ownership;
CREATE POLICY ownership_update ON public.ownership
  FOR UPDATE TO authenticated USING (EXISTS (
    SELECT 1 FROM public.units u JOIN public.buildings b ON b.id = u.building_id
     WHERE u.id = ownership.unit_id AND public.can_write(b.organization_id)));

DROP POLICY IF EXISTS ownership_delete ON public.ownership;
CREATE POLICY ownership_delete ON public.ownership
  FOR DELETE TO authenticated USING (EXISTS (
    SELECT 1 FROM public.units u JOIN public.buildings b ON b.id = u.building_id
     WHERE u.id = ownership.unit_id AND public.can_write(b.organization_id)));


-- ──────────────────────────────────────────────── 11. grants (pre-m30) ──────
-- Dit is de toestand die m30 juist dichtzet. Zonder deze grants zouden D1-D6 en
-- G1 slagen zonder iets te bewijzen.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ownership TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.owners    TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.units     TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buildings TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations, public.memberships,
      public.profiles, public.accounts, public.charge_allocations, public.payments,
      public.journal_entries TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_organization(text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write(uuid)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_org_role(uuid)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_alloc_resolve_owner(uuid,date) TO authenticated;


-- ───────────────────────────────────── 12. zelfcontrole van de fixture ──────
-- Faalt hier iets, dan is de fixture onvolledig en is elke testuitkomst
-- daarna betekenisloos. Fail-closed dus, niet stilzwijgend doorgaan.
DO $selfcheck$
DECLARE ontbreekt text := '';
BEGIN
  IF to_regclass('public.ownership')     IS NULL THEN ontbreekt := ontbreekt || ' ownership'; END IF;
  IF to_regclass('public.owners')        IS NULL THEN ontbreekt := ontbreekt || ' owners'; END IF;
  IF to_regclass('public.units')         IS NULL THEN ontbreekt := ontbreekt || ' units'; END IF;
  IF to_regclass('public.buildings')     IS NULL THEN ontbreekt := ontbreekt || ' buildings'; END IF;
  IF to_regclass('public.organizations') IS NULL THEN ontbreekt := ontbreekt || ' organizations'; END IF;
  IF to_regclass('auth.users')           IS NULL THEN ontbreekt := ontbreekt || ' auth.users'; END IF;
  IF to_regprocedure('auth.uid()')       IS NULL THEN ontbreekt := ontbreekt || ' auth.uid'; END IF;
  IF to_regprocedure('public.create_organization(text)')          IS NULL THEN ontbreekt := ontbreekt || ' create_organization'; END IF;
  IF to_regprocedure('public.can_write(uuid)')                    IS NULL THEN ontbreekt := ontbreekt || ' can_write'; END IF;
  IF to_regprocedure('public.fn_alloc_resolve_owner(uuid,date)')  IS NULL THEN ontbreekt := ontbreekt || ' fn_alloc_resolve_owner'; END IF;

  IF ontbreekt <> '' THEN
    RAISE EXCEPTION 'FIXTURE_INCOMPLEET:%', ontbreekt USING ERRCODE = '23514';
  END IF;

  -- De fixture MOET pre-m30 zijn: geen tenantkolom, geen exclusion constraints.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.ownership'::regclass
                AND attname = 'organization_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'FIXTURE_NIET_PRE_M30: ownership.organization_id bestaat al' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.ownership'::regclass AND contype = 'x') THEN
    RAISE EXCEPTION 'FIXTURE_NIET_PRE_M30: exclusion constraint bestaat al' USING ERRCODE = '23514';
  END IF;

  RAISE NOTICE 'pre-m30 fixture geladen en gecontroleerd.';
END $selfcheck$;

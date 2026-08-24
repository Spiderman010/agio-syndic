-- ============================================================================
-- m8_security_tenant_isolation
-- Herstelt: P0-1 (membership takeover), P0-2 (cross-tenant receipts),
--           P0-3 (receipt_path i.p.v. permanente signed URL),
--           P0-4 (ownership IDOR), P1-5 (rolmodel), P1-6 (cross-tenant FK's)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ROLHELPERS  (P1-5)
-- ---------------------------------------------------------------------------
-- Centrale, expliciete permissielaag. Alle policies verwijzen hiernaar,
-- zodat het rolmodel op één plek gedefinieerd is.
--
--   owner      : volledige rechten, inclusief ledenbeheer en organisatie
--   admin      : volledige rechten, inclusief ledenbeheer
--   manager    : operationeel + financieel muteren
--   accountant : operationeel + financieel muteren
--   reader     : UITSLUITEND lezen
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_org_role(org uuid)
RETURNS public.org_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT m.role
    FROM public.memberships m
   WHERE m.organization_id = org
     AND m.user_id = auth.uid()
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.can_write(org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    public.current_org_role(org) IN ('owner','admin','manager','accountant'),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_members(org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    public.current_org_role(org) IN ('owner','admin'),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.is_org_owner(org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.current_org_role(org) = 'owner', false);
$$;

-- ---------------------------------------------------------------------------
-- 2. FUNCTIE-RECHTEN DICHTZETTEN
-- ---------------------------------------------------------------------------
-- seed_pcsi en get_account_id zijn SECURITY DEFINER zonder eigen auth-guard en
-- waren aanroepbaar door `anon`. Zij worden uitsluitend intern gebruikt.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.seed_pcsi(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_account_id(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_organization(text)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_org_member(uuid)        FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_organization(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_org_role(uuid)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_write(uuid)           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_members(uuid)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_owner(uuid)        TO authenticated, service_role;

-- Triggerfuncties horen nooit rechtstreeks aanroepbaar te zijn.
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

-- ---------------------------------------------------------------------------
-- 3. MEMBERSHIPS  (P0-1)
-- ---------------------------------------------------------------------------
-- Oude policy stond `user_id = auth.uid()` toe als zelfstandige INSERT-grond:
-- elke ingelogde gebruiker kon zichzelf als `owner` aan een willekeurige
-- organisatie toevoegen. Lidmaatschap ontstaat voortaan uitsluitend via
-- create_organization() (SECURITY DEFINER, omzeilt RLS) of door owner/admin.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS mbr_insert ON public.memberships;
DROP POLICY IF EXISTS mbr_select ON public.memberships;
DROP POLICY IF EXISTS mbr_update ON public.memberships;
DROP POLICY IF EXISTS mbr_delete ON public.memberships;

CREATE POLICY mbr_select ON public.memberships
  FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));

-- Geen self-service meer: alleen owner/admin van een BESTAANDE organisatie.
CREATE POLICY mbr_insert ON public.memberships
  FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_members(organization_id));

-- Eigen rij mag nooit gewijzigd worden -> geen zelf-promotie.
CREATE POLICY mbr_update ON public.memberships
  FOR UPDATE TO authenticated
  USING      (public.can_manage_members(organization_id) AND user_id <> auth.uid())
  WITH CHECK (public.can_manage_members(organization_id) AND user_id <> auth.uid());

CREATE POLICY mbr_delete ON public.memberships
  FOR DELETE TO authenticated
  USING (public.can_manage_members(organization_id) AND user_id <> auth.uid());

-- Invariant, ook voor service_role/SQL-editor: een organisatie houdt >=1 owner.
CREATE OR REPLACE FUNCTION public.fn_guard_last_owner()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_owners int;
BEGIN
  IF OLD.role <> 'owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_owners
    FROM public.memberships
   WHERE organization_id = OLD.organization_id
     AND role = 'owner'
     AND id <> OLD.id;

  IF v_owners = 0 THEN
    RAISE EXCEPTION
      'Organisatie % moet minimaal één owner houden', OLD.organization_id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DROP TRIGGER IF EXISTS trig_guard_last_owner ON public.memberships;
CREATE TRIGGER trig_guard_last_owner
  BEFORE UPDATE OR DELETE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_last_owner();

-- ---------------------------------------------------------------------------
-- 4. ORGANIZATIONS
-- ---------------------------------------------------------------------------
-- Directe INSERT is dicht: organisaties ontstaan uitsluitend via de atomische
-- create_organization() RPC. Dit voorkomt tevens weesorganisaties (P1-2).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS org_insert ON public.organizations;
DROP POLICY IF EXISTS org_select ON public.organizations;
DROP POLICY IF EXISTS org_update ON public.organizations;
DROP POLICY IF EXISTS org_delete ON public.organizations;

CREATE POLICY org_select ON public.organizations
  FOR SELECT TO authenticated USING (public.is_org_member(id));

CREATE POLICY org_insert ON public.organizations
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY org_update ON public.organizations
  FOR UPDATE TO authenticated
  USING (public.can_manage_members(id)) WITH CHECK (public.can_manage_members(id));

CREATE POLICY org_delete ON public.organizations
  FOR DELETE TO authenticated USING (public.is_org_owner(id));

-- ---------------------------------------------------------------------------
-- 5. ORG-GESCOPETE TABELLEN: split FOR ALL -> SELECT / INSERT / UPDATE / DELETE
-- ---------------------------------------------------------------------------
-- Alle bestaande policies gebruikten uitsluitend is_org_member(), waardoor
-- `reader` dezelfde schrijfrechten had als `owner`.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_tables text[] := ARRAY[
    'accounts','bank_accounts','bank_transactions','buildings',
    'charge_allocations','charge_calls','compliance_deadlines','documents',
    'expense_categories','expenses','fiscal_year_closings','fiscal_years',
    'fund_movements','funds','journal_entries','journal_lines','owners',
    'payment_allocations','payments'
  ];
  t text;
  r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = ANY(v_tables)
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;

  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
         USING (public.is_org_member(organization_id))', t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
         WITH CHECK (public.can_write(organization_id))', t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
         USING (public.can_write(organization_id))
         WITH CHECK (public.can_write(organization_id))', t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
         USING (public.can_write(organization_id))', t || '_delete', t);
  END LOOP;
END $$;

-- units: org loopt via building
DROP POLICY IF EXISTS unit_all ON public.units;

CREATE POLICY units_select ON public.units
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.buildings b
                  WHERE b.id = units.building_id
                    AND public.is_org_member(b.organization_id)));

CREATE POLICY units_insert ON public.units
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.buildings b
                       WHERE b.id = units.building_id
                         AND public.can_write(b.organization_id)));

CREATE POLICY units_update ON public.units
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.buildings b
                  WHERE b.id = units.building_id
                    AND public.can_write(b.organization_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.buildings b
                       WHERE b.id = units.building_id
                         AND public.can_write(b.organization_id)));

CREATE POLICY units_delete ON public.units
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.buildings b
                  WHERE b.id = units.building_id
                    AND public.can_write(b.organization_id)));

-- ---------------------------------------------------------------------------
-- 6. OWNERSHIP  (P0-4)
-- ---------------------------------------------------------------------------
-- De oude policy valideerde uitsluitend de keten unit -> building -> org.
-- owner_id werd nergens getoetst, waardoor een eigenaar uit organisatie B aan
-- een unit van organisatie A kon worden gekoppeld.
-- Twee lagen: RLS (autorisatie) EN trigger (invariant, geldt ook voor
-- service_role en SECURITY DEFINER-code).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS ownership_all ON public.ownership;

CREATE POLICY ownership_select ON public.ownership
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.units u
                   JOIN public.buildings b ON b.id = u.building_id
                  WHERE u.id = ownership.unit_id
                    AND public.is_org_member(b.organization_id)));

CREATE POLICY ownership_insert ON public.ownership
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.units u
              JOIN public.buildings b ON b.id = u.building_id
             WHERE u.id = ownership.unit_id
               AND public.can_write(b.organization_id))
    AND EXISTS (SELECT 1 FROM public.owners o
                  JOIN public.units u    ON u.id = ownership.unit_id
                  JOIN public.buildings b ON b.id = u.building_id
                 WHERE o.id = ownership.owner_id
                   AND o.organization_id = b.organization_id)
  );

CREATE POLICY ownership_update ON public.ownership
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.units u
                   JOIN public.buildings b ON b.id = u.building_id
                  WHERE u.id = ownership.unit_id
                    AND public.can_write(b.organization_id)))
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.units u
              JOIN public.buildings b ON b.id = u.building_id
             WHERE u.id = ownership.unit_id
               AND public.can_write(b.organization_id))
    AND EXISTS (SELECT 1 FROM public.owners o
                  JOIN public.units u    ON u.id = ownership.unit_id
                  JOIN public.buildings b ON b.id = u.building_id
                 WHERE o.id = ownership.owner_id
                   AND o.organization_id = b.organization_id)
  );

CREATE POLICY ownership_delete ON public.ownership
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.units u
                   JOIN public.buildings b ON b.id = u.building_id
                  WHERE u.id = ownership.unit_id
                    AND public.can_write(b.organization_id)));

CREATE OR REPLACE FUNCTION public.fn_guard_ownership_tenant()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_unit_org  uuid;
  v_owner_org uuid;
BEGIN
  SELECT b.organization_id INTO v_unit_org
    FROM public.units u
    JOIN public.buildings b ON b.id = u.building_id
   WHERE u.id = NEW.unit_id;

  SELECT o.organization_id INTO v_owner_org
    FROM public.owners o
   WHERE o.id = NEW.owner_id;

  IF v_unit_org IS NULL THEN
    RAISE EXCEPTION 'Unit % bestaat niet', NEW.unit_id USING ERRCODE = '23503';
  END IF;
  IF v_owner_org IS NULL THEN
    RAISE EXCEPTION 'Eigenaar % bestaat niet', NEW.owner_id USING ERRCODE = '23503';
  END IF;
  IF v_unit_org <> v_owner_org THEN
    RAISE EXCEPTION
      'Tenant-schending: eigenaar % (organisatie %) mag niet aan unit % (organisatie %) worden gekoppeld',
      NEW.owner_id, v_owner_org, NEW.unit_id, v_unit_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trig_00_ownership_tenant_guard ON public.ownership;
CREATE TRIGGER trig_00_ownership_tenant_guard
  BEFORE INSERT OR UPDATE ON public.ownership
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_ownership_tenant();

-- ---------------------------------------------------------------------------
-- 7. SAMENGESTELDE FOREIGN KEYS  (P1-6)
-- ---------------------------------------------------------------------------
-- Structurele afdwinging dat een verwijzende rij nooit naar een record van een
-- ANDERE organisatie kan wijzen. Werkt ongeacht applicatiecode, RLS of rol.
-- De bestaande enkelvoudige FK's blijven staan voor hun ON DELETE-gedrag;
-- de samengestelde FK's staan op NO ACTION en zijn zuiver bewakend.
-- ---------------------------------------------------------------------------

ALTER TABLE public.accounts           ADD CONSTRAINT accounts_id_org_key           UNIQUE (id, organization_id);
ALTER TABLE public.bank_accounts      ADD CONSTRAINT bank_accounts_id_org_key      UNIQUE (id, organization_id);
ALTER TABLE public.buildings          ADD CONSTRAINT buildings_id_org_key          UNIQUE (id, organization_id);
ALTER TABLE public.charge_allocations ADD CONSTRAINT charge_allocations_id_org_key UNIQUE (id, organization_id);
ALTER TABLE public.charge_calls       ADD CONSTRAINT charge_calls_id_org_key       UNIQUE (id, organization_id);
ALTER TABLE public.expense_categories ADD CONSTRAINT expense_categories_id_org_key UNIQUE (id, organization_id);
ALTER TABLE public.fiscal_years       ADD CONSTRAINT fiscal_years_id_org_key       UNIQUE (id, organization_id);
ALTER TABLE public.funds              ADD CONSTRAINT funds_id_org_key              UNIQUE (id, organization_id);
ALTER TABLE public.journal_entries    ADD CONSTRAINT journal_entries_id_org_key    UNIQUE (id, organization_id);
ALTER TABLE public.owners             ADD CONSTRAINT owners_id_org_key             UNIQUE (id, organization_id);
ALTER TABLE public.payments           ADD CONSTRAINT payments_id_org_key           UNIQUE (id, organization_id);

ALTER TABLE public.fiscal_years
  ADD CONSTRAINT fiscal_years_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.charge_calls
  ADD CONSTRAINT charge_calls_fy_org_fk
  FOREIGN KEY (fiscal_year_id, organization_id)
  REFERENCES public.fiscal_years(id, organization_id);

ALTER TABLE public.charge_allocations
  ADD CONSTRAINT charge_allocations_cc_org_fk
  FOREIGN KEY (charge_call_id, organization_id)
  REFERENCES public.charge_calls(id, organization_id);

ALTER TABLE public.charge_allocations
  ADD CONSTRAINT charge_allocations_owner_org_fk
  FOREIGN KEY (owner_id, organization_id)
  REFERENCES public.owners(id, organization_id);

ALTER TABLE public.payments
  ADD CONSTRAINT payments_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.payments
  ADD CONSTRAINT payments_owner_org_fk
  FOREIGN KEY (owner_id, organization_id)
  REFERENCES public.owners(id, organization_id);

ALTER TABLE public.payment_allocations
  ADD CONSTRAINT payment_allocations_payment_org_fk
  FOREIGN KEY (payment_id, organization_id)
  REFERENCES public.payments(id, organization_id);

ALTER TABLE public.payment_allocations
  ADD CONSTRAINT payment_allocations_ca_org_fk
  FOREIGN KEY (charge_allocation_id, organization_id)
  REFERENCES public.charge_allocations(id, organization_id);

ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_fy_org_fk
  FOREIGN KEY (fiscal_year_id, organization_id)
  REFERENCES public.fiscal_years(id, organization_id);

ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_category_org_fk
  FOREIGN KEY (category_id, organization_id)
  REFERENCES public.expense_categories(id, organization_id);

ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_account_org_fk
  FOREIGN KEY (account_id, organization_id)
  REFERENCES public.accounts(id, organization_id);

ALTER TABLE public.expense_categories
  ADD CONSTRAINT expense_categories_account_org_fk
  FOREIGN KEY (default_account_id, organization_id)
  REFERENCES public.accounts(id, organization_id);

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_fy_org_fk
  FOREIGN KEY (fiscal_year_id, organization_id)
  REFERENCES public.fiscal_years(id, organization_id);

ALTER TABLE public.journal_lines
  ADD CONSTRAINT journal_lines_entry_org_fk
  FOREIGN KEY (journal_entry_id, organization_id)
  REFERENCES public.journal_entries(id, organization_id);

ALTER TABLE public.journal_lines
  ADD CONSTRAINT journal_lines_account_org_fk
  FOREIGN KEY (account_id, organization_id)
  REFERENCES public.accounts(id, organization_id);

ALTER TABLE public.funds
  ADD CONSTRAINT funds_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.fund_movements
  ADD CONSTRAINT fund_movements_fund_org_fk
  FOREIGN KEY (fund_id, organization_id)
  REFERENCES public.funds(id, organization_id);

ALTER TABLE public.bank_accounts
  ADD CONSTRAINT bank_accounts_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_ba_org_fk
  FOREIGN KEY (bank_account_id, organization_id)
  REFERENCES public.bank_accounts(id, organization_id);

ALTER TABLE public.documents
  ADD CONSTRAINT documents_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.documents
  ADD CONSTRAINT documents_fy_org_fk
  FOREIGN KEY (fiscal_year_id, organization_id)
  REFERENCES public.fiscal_years(id, organization_id);

ALTER TABLE public.fiscal_year_closings
  ADD CONSTRAINT fyc_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.fiscal_year_closings
  ADD CONSTRAINT fyc_fy_org_fk
  FOREIGN KEY (fiscal_year_id, organization_id)
  REFERENCES public.fiscal_years(id, organization_id);

ALTER TABLE public.compliance_deadlines
  ADD CONSTRAINT compliance_building_org_fk
  FOREIGN KEY (building_id, organization_id)
  REFERENCES public.buildings(id, organization_id);

ALTER TABLE public.compliance_deadlines
  ADD CONSTRAINT compliance_fy_org_fk
  FOREIGN KEY (fiscal_year_id, organization_id)
  REFERENCES public.fiscal_years(id, organization_id);

-- Deterministische rekeningopzoeking (get_account_id gebruikt LIMIT 1).
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_org_code_key UNIQUE (organization_id, code);

-- ---------------------------------------------------------------------------
-- 8. STORAGE / RECEIPTS  (P0-2)
-- ---------------------------------------------------------------------------
-- Padconventie: {organization_id}/{building_id}/{bestand}
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.receipt_path_org(p_name text)
RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $$
DECLARE v uuid;
BEGIN
  BEGIN
    v := (storage.foldername(p_name))[1]::uuid;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.receipt_path_building_ok(p_name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid;
  v_bld uuid;
BEGIN
  v_org := public.receipt_path_org(p_name);
  IF v_org IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    v_bld := (storage.foldername(p_name))[2]::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF v_bld IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.buildings b
     WHERE b.id = v_bld AND b.organization_id = v_org
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.receipt_path_org(text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receipt_path_building_ok(text) TO authenticated, service_role;

DROP POLICY IF EXISTS leden_upload_receipts      ON storage.objects;
DROP POLICY IF EXISTS leden_read_receipts        ON storage.objects;
DROP POLICY IF EXISTS leden_delete_own_receipts  ON storage.objects;

CREATE POLICY receipts_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'receipts'
    AND public.is_org_member(public.receipt_path_org(name))
  );

CREATE POLICY receipts_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'receipts'
    AND public.can_write(public.receipt_path_org(name))
    AND public.receipt_path_building_ok(name)
  );

CREATE POLICY receipts_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'receipts'
    AND public.can_write(public.receipt_path_org(name))
  )
  WITH CHECK (
    bucket_id = 'receipts'
    AND public.can_write(public.receipt_path_org(name))
    AND public.receipt_path_building_ok(name)
  );

CREATE POLICY receipts_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'receipts'
    AND public.can_write(public.receipt_path_org(name))
    AND (
      owner = auth.uid()
      OR public.can_manage_members(public.receipt_path_org(name))
    )
  );

-- ---------------------------------------------------------------------------
-- 9. RECEIPT PATH i.p.v. permanente signed URL  (P0-3)
-- ---------------------------------------------------------------------------
-- receipt_url bevatte een signed URL met TTL 315360000 s (10 jaar): een
-- permanente, niet-intrekbare bearer-link die RLS volledig omzeilt.
-- Voortaan wordt uitsluitend het object-pad bewaard; de URL wordt server-side
-- per weergave gegenereerd met korte TTL.
--
-- receipt_url wordt NIET verwijderd: de kolom blijft als vangnet staan zodat
-- geen enkel bestaand bewijsstuk verloren gaat. Verwijderen is een aparte,
-- latere stap zodra de backfill is geverifieerd.
-- ---------------------------------------------------------------------------

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS receipt_path text;

UPDATE public.expenses
   SET receipt_path = substring(receipt_url from '/object/sign/receipts/([^?]+)')
 WHERE receipt_path IS NULL
   AND receipt_url IS NOT NULL
   AND receipt_url LIKE '%/object/sign/receipts/%';

UPDATE public.expenses
   SET receipt_path = substring(receipt_url from '/object/public/receipts/([^?]+)')
 WHERE receipt_path IS NULL
   AND receipt_url IS NOT NULL
   AND receipt_url LIKE '%/object/public/receipts/%';

COMMENT ON COLUMN public.expenses.receipt_url IS
  'DEPRECATED (P0-3). Historische signed URL. Niet meer vullen; gebruik receipt_path.';
COMMENT ON COLUMN public.expenses.receipt_path IS
  'Storage-objectpad in bucket receipts: {organization_id}/{building_id}/{bestand}.';

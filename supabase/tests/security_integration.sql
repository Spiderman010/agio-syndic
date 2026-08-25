-- ============================================================================
-- Agio Syndic — security- en integriteitstests (database-integratie)
-- ============================================================================
--
-- Deze tests draaien ECHT tegen de database: er wordt geen enkele mock
-- gebruikt. RLS wordt afgedwongen door de sessierol op `authenticated` te
-- zetten en request.jwt.claims te vullen, precies zoals PostgREST dat doet.
--
-- Het geheel draait in één DO-blok dat aan het eind een exceptie werpt met het
-- testrapport als boodschap. Daardoor wordt ALLE testdata gegarandeerd
-- teruggerold: de tests laten niets achter in de database.
--
-- Uitvoeren:
--   psql "$DATABASE_URL" -f supabase/tests/security_integration.sql
-- of via de Supabase SQL-editor / MCP-connector.
--
-- Verwachte uitkomst: "18 geslaagd, 0 gefaald".
-- ============================================================================

DO $test$
DECLARE
  v_user_a  uuid := gen_random_uuid();
  v_user_b  uuid := gen_random_uuid();
  v_user_r  uuid := gen_random_uuid();   -- reader binnen organisatie A
  v_user_m  uuid := gen_random_uuid();   -- manager binnen organisatie A
  v_user_c  uuid := gen_random_uuid();   -- verse gebruiker voor onboarding-test

  v_org_a   uuid;
  v_org_b   uuid;
  v_org_c   uuid;

  v_bld_a   uuid;
  v_bld_b   uuid;
  v_unit_a  uuid;
  v_own_a   uuid;
  v_own_b   uuid;
  v_fy_a    uuid;
  v_fy_shut uuid;
  v_cc      uuid;
  v_je      uuid;

  report text := '';
  pass   int  := 0;
  fail   int  := 0;
  ok     boolean;
  n      int;
  v_num  numeric;
  v_num2 numeric;

  PROC_A text;
  PROC_B text;
  PROC_R text;
  PROC_M text;
BEGIN
  PROC_A := json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text;
  PROC_B := json_build_object('sub', v_user_b::text, 'role', 'authenticated')::text;
  PROC_R := json_build_object('sub', v_user_r::text, 'role', 'authenticated')::text;
  PROC_M := json_build_object('sub', v_user_m::text, 'role', 'authenticated')::text;

  -- =========================================================================
  -- SETUP (als postgres; RLS niet van toepassing)
  -- =========================================================================
  INSERT INTO auth.users(id) VALUES (v_user_a), (v_user_b), (v_user_r), (v_user_m), (v_user_c);

  PERFORM set_config('request.jwt.claims', PROC_A, true);
  v_org_a := public.create_organization('TEST Org A');

  PERFORM set_config('request.jwt.claims', PROC_B, true);
  v_org_b := public.create_organization('TEST Org B');

  -- reader en manager in organisatie A
  INSERT INTO public.memberships(organization_id, user_id, role)
  VALUES (v_org_a, v_user_r, 'reader'),
         (v_org_a, v_user_m, 'manager');

  -- Organisatie B: gebouw + eigenaar (de "vreemde" tenant)
  INSERT INTO public.buildings(organization_id, name, total_tantiemes)
  VALUES (v_org_b, 'TEST Gebouw B', 1000) RETURNING id INTO v_bld_b;
  INSERT INTO public.owners(organization_id, full_name)
  VALUES (v_org_b, 'TEST Eigenaar B') RETURNING id INTO v_own_b;

  -- Bewijsstuk van organisatie B in storage
  INSERT INTO storage.objects(bucket_id, name, owner, owner_id)
  VALUES ('receipts', v_org_b::text || '/' || v_bld_b::text || '/geheim.pdf',
          v_user_b, v_user_b::text);

  -- =========================================================================
  -- T12 (happy path, als eerste zodat de rest erop kan bouwen)
  -- Normale geldige flow blijft werken onder RLS als owner van organisatie A.
  -- =========================================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_A, true);
    PERFORM set_config('role', 'authenticated', true);

    INSERT INTO public.buildings(organization_id, name, total_tantiemes)
    VALUES (v_org_a, 'TEST Gebouw A', 1000) RETURNING id INTO v_bld_a;

    INSERT INTO public.units(building_id, label, unit_type, tantiemes)
    VALUES (v_bld_a, 'A1', 'appartement', 1000) RETURNING id INTO v_unit_a;

    INSERT INTO public.owners(organization_id, full_name)
    VALUES (v_org_a, 'TEST Eigenaar A') RETURNING id INTO v_own_a;

    INSERT INTO public.ownership(unit_id, owner_id, share, start_date)
    VALUES (v_unit_a, v_own_a, 1, '2026-01-01');

    INSERT INTO public.fiscal_years(organization_id, building_id, year, start_date, end_date, status)
    VALUES (v_org_a, v_bld_a, 2026, '2026-01-01', '2026-12-31', 'open')
    RETURNING id INTO v_fy_a;

    -- Sinds m15 is de RPC het enige schrijfpad voor een lastenoproep; een
    -- rechtstreekse INSERT is voor `authenticated` geblokkeerd.
    v_cc := public.create_charge_call(v_fy_a, 'regulier', 100.00, '2026-03-01');

    PERFORM set_config('role', 'postgres', true);

    SELECT count(*) INTO n FROM public.charge_allocations WHERE charge_call_id = v_cc;
    ok := (n = 1);
    SELECT count(*) INTO n FROM public.journal_entries WHERE source_id = v_cc;
    ok := ok AND (n = 1);
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := false;
    report := report || E'\n         (T12 exceptie: ' || SQLERRM || ')';
  END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T12  normale geldige flow werkt (gebouw/unit/eigenaar/boekjaar/oproep + allocatie + journaal)';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T12  normale geldige flow werkt NIET'; END IF;

  -- =========================================================================
  -- T1  Gebruiker A kan geen membership in organisatie B maken   (P0-1)
  -- =========================================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_A, true);
    PERFORM set_config('role', 'authenticated', true);
    INSERT INTO public.memberships(organization_id, user_id, role)
    VALUES (v_org_b, v_user_a, 'owner');
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := true;
  END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T1   gebruiker A kan zichzelf NIET aan organisatie B koppelen';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T1   MEMBERSHIP TAKEOVER NOG MOGELIJK'; END IF;

  -- =========================================================================
  -- T2  Reader kan niet schrijven, wel lezen                      (P1-5)
  -- =========================================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_R, true);
    PERFORM set_config('role', 'authenticated', true);
    INSERT INTO public.buildings(organization_id, name, total_tantiemes)
    VALUES (v_org_a, 'TEST reader mag dit niet', 1000);
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := true;
  END;

  -- reader moet WEL kunnen lezen
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_R, true);
    PERFORM set_config('role', 'authenticated', true);
    SELECT count(*) INTO n FROM public.buildings WHERE organization_id = v_org_a;
    PERFORM set_config('role', 'postgres', true);
    ok := ok AND (n >= 1);
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T2   reader kan NIET schrijven maar WEL lezen';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T2   rolmodel dwingt reader niet correct af'; END IF;

  -- =========================================================================
  -- T3  Gebruiker A kan bewijsstuk van organisatie B niet lezen   (P0-2)
  -- =========================================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_A, true);
    PERFORM set_config('role', 'authenticated', true);
    SELECT count(*) INTO n FROM storage.objects
     WHERE bucket_id = 'receipts' AND name LIKE v_org_b::text || '/%';
    PERFORM set_config('role', 'postgres', true);
    ok := (n = 0);
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T3   bewijsstukken van organisatie B zijn onzichtbaar voor gebruiker A';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T3   CROSS-TENANT LEK IN STORAGE'; END IF;

  -- =========================================================================
  -- T4  Gebruiker A kan niet uploaden onder prefix van organisatie B (P0-2)
  -- =========================================================================
  -- (a) upload onder EIGEN prefix moet slagen — sluit uit dat de test alleen
  --     slaagt doordat `authenticated` überhaupt geen INSERT-recht heeft.
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_A, true);
    PERFORM set_config('role', 'authenticated', true);
    INSERT INTO storage.objects(bucket_id, name, owner, owner_id)
    VALUES ('receipts', v_org_a::text || '/' || v_bld_a::text || '/eigen.pdf',
            v_user_a, v_user_a::text);
    PERFORM set_config('role', 'postgres', true);
    ok := true;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := false;
    report := report || E'\n         (T4a exceptie: ' || SQLERRM || ')';
  END;

  -- (b) upload onder prefix van organisatie B moet falen
  IF ok THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', PROC_A, true);
      PERFORM set_config('role', 'authenticated', true);
      INSERT INTO storage.objects(bucket_id, name, owner, owner_id)
      VALUES ('receipts', v_org_b::text || '/' || v_bld_b::text || '/ingesloten.pdf',
              v_user_a, v_user_a::text);
      PERFORM set_config('role', 'postgres', true);
      ok := false;
    EXCEPTION WHEN others THEN
      PERFORM set_config('role', 'postgres', true);
      ok := true;
    END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T4   upload onder eigen prefix slaagt, onder prefix van organisatie B geweigerd';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T4   CROSS-TENANT UPLOAD NOG MOGELIJK'; END IF;

  -- =========================================================================
  -- T5  Eigenaar uit organisatie B kan niet aan unit uit A        (P0-4)
  -- =========================================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_A, true);
    PERFORM set_config('role', 'authenticated', true);
    INSERT INTO public.ownership(unit_id, owner_id, share, start_date)
    VALUES (v_unit_a, v_own_b, 1, '2026-01-01');
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := true;
  END;

  -- Ook de databank-invariant zelf moet het weigeren (zonder RLS, als postgres)
  IF ok THEN
    BEGIN
      INSERT INTO public.ownership(unit_id, owner_id, share, start_date)
      VALUES (v_unit_a, v_own_b, 1, '2026-01-01');
      ok := false;
    EXCEPTION WHEN others THEN
      ok := true;
    END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T5   cross-tenant ownership geweigerd door RLS EN door trigger-invariant';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T5   OWNERSHIP-IDOR NOG MOGELIJK'; END IF;

  -- =========================================================================
  -- T6  Vreemde building/fiscalYear-UUID wordt geweigerd          (P1-6)
  -- =========================================================================
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    -- Zelfs met correcte eigen organization_id mag een vreemd gebouw niet.
    INSERT INTO public.expenses(organization_id, building_id, amount, expense_date)
    VALUES (v_org_a, v_bld_b, 50.00, '2026-04-01');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;

  IF ok THEN
    BEGIN
      INSERT INTO public.payments(organization_id, building_id, owner_id, amount, method, value_date)
      VALUES (v_org_a, v_bld_a, v_own_b, 10.00, 'virement', '2026-04-01');
      ok := false;
    EXCEPTION WHEN others THEN
      ok := true;
    END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T6   vreemde building- en owner-UUID worden door samengestelde FK geweigerd';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T6   CROSS-TENANT FOREIGN KEYS NOG MOGELIJK'; END IF;

  -- =========================================================================
  -- T7  Financiële inserts vereisen een correcte organization_id  (P1-1)
  -- =========================================================================
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    -- Zoals de oude code het deed: zonder organization_id.
    INSERT INTO public.fiscal_years(building_id, year, start_date, end_date, status)
    VALUES (v_bld_a, 2029, '2029-01-01', '2029-12-31', 'open');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;

  IF ok THEN
    BEGIN
      -- Zoals de nieuwe code het doet: mét organization_id.
      INSERT INTO public.fiscal_years(organization_id, building_id, year, start_date, end_date, status)
      VALUES (v_org_a, v_bld_a, 2029, '2029-01-01', '2029-12-31', 'open');
      ok := true;
    EXCEPTION WHEN others THEN
      ok := false;
      report := report || E'\n         (T7 exceptie: ' || SQLERRM || ')';
    END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T7   insert zonder organization_id faalt, mét organization_id slaagt';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T7   organization_id wordt niet correct afgedwongen'; END IF;

  -- =========================================================================
  -- T8  Onboarding is atomisch                                    (P1-2)
  -- =========================================================================
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_user_c::text, 'role', 'authenticated')::text, true);
    v_org_c := public.create_organization('TEST Org C');

    SELECT count(*) INTO n FROM public.memberships
     WHERE organization_id = v_org_c AND user_id = v_user_c AND role = 'owner';
    ok := (n = 1);

    SELECT count(*) INTO n FROM public.accounts WHERE organization_id = v_org_c;
    ok := ok AND (n = 6);   -- 4111, 4419, 4411, 5141, 6110, 7011
  EXCEPTION WHEN others THEN
    ok := false;
    report := report || E'\n         (T8 exceptie: ' || SQLERRM || ')';
  END;

  -- Directe INSERT op organizations moet dicht zijn (geen weesorganisatie).
  IF ok THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', PROC_A, true);
      PERFORM set_config('role', 'authenticated', true);
      INSERT INTO public.organizations(name) VALUES ('TEST wees-organisatie');
      PERFORM set_config('role', 'postgres', true);
      ok := false;
    EXCEPTION WHEN others THEN
      PERFORM set_config('role', 'postgres', true);
      ok := true;
    END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T8   create_organization levert org+owner+6 PCSI-rekeningen; directe insert geblokkeerd';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T8   onboarding is niet atomisch of directe insert nog mogelijk'; END IF;

  -- =========================================================================
  -- T9  Gesloten boekjaar weigert mutaties                        (P1-4)
  -- =========================================================================
  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.fiscal_years(organization_id, building_id, year, start_date, end_date, status)
  VALUES (v_org_a, v_bld_a, 2025, '2025-01-01', '2025-12-31', 'open')
  RETURNING id INTO v_fy_shut;
  UPDATE public.fiscal_years SET status = 'closed' WHERE id = v_fy_shut;

  BEGIN
    INSERT INTO public.expenses(organization_id, building_id, fiscal_year_id, amount, expense_date)
    VALUES (v_org_a, v_bld_a, v_fy_shut, 25.00, '2025-06-01');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;

  IF ok THEN
    BEGIN
      PERFORM public.create_charge_call(v_fy_shut, 'regulier', 500.00, '2025-06-01');
      ok := false;
    EXCEPTION WHEN others THEN
      ok := true;
    END;
  END IF;

  IF ok THEN
    BEGIN
      UPDATE public.fiscal_years SET end_date = '2025-11-30' WHERE id = v_fy_shut;
      ok := false;
    EXCEPTION WHEN others THEN
      ok := true;
    END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T9   gesloten boekjaar weigert uitgave, lastenoproep en periodewijziging';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T9   GESLOTEN BOEKJAAR IS NOG MUTEERBAAR'; END IF;

  -- =========================================================================
  -- T11 Overbetaling verdwijnt niet                               (P1-8)
  -- =========================================================================
  -- Openstaand in fy 2026: 100,00 (uit T12). Betaling van 150,00.
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    INSERT INTO public.payments(organization_id, building_id, owner_id, amount, method, value_date)
    VALUES (v_org_a, v_bld_a, v_own_a, 150.00, 'virement', '2026-04-15');

    SELECT COALESCE(sum(pa.amount), 0) INTO v_num
      FROM public.payment_allocations pa
      JOIN public.payments p ON p.id = pa.payment_id
     WHERE p.owner_id = v_own_a;

    SELECT COALESCE(sum(jl.credit), 0) INTO v_num2
      FROM public.journal_lines jl
      JOIN public.accounts a ON a.id = jl.account_id
     WHERE a.organization_id = v_org_a AND a.code = '4419';

    ok := (v_num = 100.00) AND (v_num2 = 50.00);
    IF NOT ok THEN
      report := report || E'\n         (T11 toegewezen=' || v_num || ', 4419-credit=' || v_num2 || ')';
    END IF;
  EXCEPTION WHEN others THEN
    ok := false;
    report := report || E'\n         (T11 exceptie: ' || SQLERRM || ')';
  END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T11  overbetaling van 50,00 staat als vooruitontvangen op PCSI 4419';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T11  OVERBETALING VERDWIJNT NOG STEEDS'; END IF;

  -- =========================================================================
  -- T10 Journaalpost kan niet leeg of ongebalanceerd ontstaan     (P1-3)
  -- =========================================================================
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    INSERT INTO public.journal_entries(organization_id, building_id, fiscal_year_id,
                                       entry_date, source, description)
    VALUES (v_org_a, v_bld_a, v_fy_a, '2026-05-01', 'manual', 'TEST lege journaalpost')
    RETURNING id INTO v_je;

    SET CONSTRAINTS ALL IMMEDIATE;   -- forceert de uitgestelde controle nu
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Ongebalanceerde regels moeten eveneens worden geweigerd.
  IF ok THEN
    BEGIN
      INSERT INTO public.journal_entries(organization_id, building_id, fiscal_year_id,
                                         entry_date, source, description)
      VALUES (v_org_a, v_bld_a, v_fy_a, '2026-05-02', 'manual', 'TEST ongebalanceerd')
      RETURNING id INTO v_je;
      INSERT INTO public.journal_lines(organization_id, journal_entry_id, account_id, debit, credit)
      VALUES (v_org_a, v_je, public.get_account_id(v_org_a, '5141'), 100, 0),
             (v_org_a, v_je, public.get_account_id(v_org_a, '4111'), 0, 60);
      SET CONSTRAINTS ALL IMMEDIATE;
      ok := false;
    EXCEPTION WHEN others THEN
      ok := true;
    END;
    BEGIN
      SET CONSTRAINTS ALL DEFERRED;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T10  lege én ongebalanceerde journaalpost worden geweigerd';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T10  JOURNAALPOST KAN LEEG OF ONGEBALANCEERD ONTSTAAN'; END IF;

  -- =========================================================================
  -- T13 Boekhoudregel: in een GESLOTEN boekjaar mag settled_amount nog wél
  --     muteren (doorlopende vordering, PCSI 4111), maar amount niet.
  --     Zie docs/accounting-rules.md §2.
  -- =========================================================================
  PERFORM set_config('role', 'postgres', true);
  UPDATE public.fiscal_years SET status = 'closed' WHERE id = v_fy_a;

  BEGIN
    UPDATE public.charge_allocations SET settled_amount = settled_amount
     WHERE charge_call_id = v_cc;
    ok := true;
  EXCEPTION WHEN others THEN
    ok := false;
    report := report || E'\n         (T13 settled_amount geblokkeerd: ' || SQLERRM || ')';
  END;

  IF ok THEN
    BEGIN
      UPDATE public.charge_allocations SET amount = 999 WHERE charge_call_id = v_cc;
      ok := false;
    EXCEPTION WHEN others THEN ok := true; END;
  END IF;

  IF ok THEN
    BEGIN
      DELETE FROM public.payment_allocations
       WHERE charge_allocation_id IN
             (SELECT id FROM public.charge_allocations WHERE charge_call_id = v_cc);
      -- Nul rijen zou een vals-positief zijn; controleer dat er echt iets stond.
      SELECT count(*) INTO n FROM public.payment_allocations
       WHERE charge_allocation_id IN
             (SELECT id FROM public.charge_allocations WHERE charge_call_id = v_cc);
      ok := false;
    EXCEPTION WHEN others THEN ok := true; END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T13  gesloten boekjaar: settled_amount mag muteren, amount en toewijzingen niet';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T13  boekhoudregel voor gesloten boekjaar klopt niet'; END IF;

  -- =========================================================================
  -- T14 Een journaalregel verwijderen mag de balans niet breken   (m11 §1)
  -- =========================================================================
  -- trig_journal_balance_check stond op AFTER INSERT OR UPDATE; DELETE viel
  -- erbuiten, waardoor één regel van een tweeregelige post weg kon.
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    DELETE FROM public.journal_lines
     WHERE journal_entry_id IN (SELECT id FROM public.journal_entries WHERE source_id = v_cc)
       AND debit > 0;
    SET CONSTRAINTS ALL IMMEDIATE;
    ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  BEGIN SET CONSTRAINTS ALL DEFERRED; EXCEPTION WHEN others THEN NULL; END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T14  verwijderen van een journaalregel breekt de balans niet';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T14  JOURNAALREGEL KAN WEG ZONDER BALANSCONTROLE'; END IF;

  -- =========================================================================
  -- T15 Heropenen van een boekjaar is voorbehouden aan owner/admin  (m11 §4)
  -- =========================================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_M, true);
    PERFORM set_config('role', 'authenticated', true);
    UPDATE public.fiscal_years SET status = 'open' WHERE id = v_fy_shut;
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN PERFORM set_config('role', 'postgres', true); ok := true; END;

  IF ok THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', PROC_A, true);
      PERFORM set_config('role', 'authenticated', true);
      UPDATE public.fiscal_years SET status = 'open' WHERE id = v_fy_shut;
      PERFORM set_config('role', 'postgres', true);
      ok := true;
    EXCEPTION WHEN others THEN
      PERFORM set_config('role', 'postgres', true); ok := false;
      report := report || E'\n         (T15 owner: ' || SQLERRM || ')';
    END;
  END IF;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T15  manager kan niet heropenen, owner wel';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T15  rolcontrole op heropenen ontbreekt'; END IF;

  -- =========================================================================
  -- T16 organization_id van een bestaand record is onveranderlijk  (m11 §3)
  -- =========================================================================
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    UPDATE public.buildings SET organization_id = v_org_b WHERE id = v_bld_a;
    ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T16  record kan niet naar een andere organisatie worden verplaatst';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T16  RECORD KAN NAAR ANDERE ORGANISATIE'; END IF;

  -- =========================================================================
  -- T17 Afgeleide tabellen zijn niet rechtstreeks beschrijfbaar  (m11 §2)
  -- =========================================================================
  BEGIN
    PERFORM set_config('request.jwt.claims', PROC_A, true);
    PERFORM set_config('role', 'authenticated', true);
    UPDATE public.charge_allocations SET settled_amount = 999 WHERE charge_call_id = v_cc;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('role', 'postgres', true);
    ok := (n = 0);
  EXCEPTION WHEN others THEN PERFORM set_config('role', 'postgres', true); ok := true; END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T17  settled_amount niet met de hand aanpasbaar via de API';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T17  AFGELEIDE TABELLEN RECHTSTREEKS BESCHRIJFBAAR'; END IF;

  -- =========================================================================
  -- T18 Kernrekeningen van het PCSI zijn beschermd  (m11 §6)
  -- =========================================================================
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    DELETE FROM public.accounts WHERE organization_id = v_org_a AND code = '4111';
    ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  IF ok THEN pass := pass + 1; report := report || E'\n  PASS  T18  kernrekening 4111 kan niet worden verwijderd';
  ELSE     fail := fail + 1; report := report || E'\n  FAIL  T18  PCSI-KERNREKENING VERWIJDERBAAR'; END IF;

  -- =========================================================================
  PERFORM set_config('role', 'postgres', true);
  RAISE EXCEPTION E'\n\n===== AGIO SYNDIC SECURITYTESTS =====%\n\n  %  geslaagd, %  gefaald\n  (alle testdata is teruggerold)\n',
    report, pass, fail;
END
$test$;

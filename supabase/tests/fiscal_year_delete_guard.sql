-- ============================================================================
-- Agio Syndic — fiscal year delete guard (m21), database-integratie
-- ============================================================================
--
-- Draait ECHT tegen de database; geen mocks. Alles staat in een DO-blok dat aan het eind een
-- exceptie werpt met het testrapport als boodschap, zodat ALLE testdata gegarandeerd wordt
-- teruggerold.
--
-- Uitvoeren:
--   psql "$DATABASE_URL" -f supabase/tests/fiscal_year_delete_guard.sql
-- of plakken in de SQL-editor / via de MCP-connector.
--
-- Verwachte uitkomst: "21 geslaagd, 0 gefaald".
--
-- Wat hier wordt vastgelegd:
--   * een LEEG open boekjaar blijft verwijderbaar;
--   * elk soort financiele historie blokkeert de verwijdering hard (FY_HAS_FINANCIAL_HISTORY);
--   * een GESLOTEN boekjaar blijft geblokkeerd;
--   * de invariant geldt voor ELKE rol, ook owner/admin en de postgres-context;
--   * het verwijderen van het GEBOUW is geen omweg meer (BUILDING_HAS_FINANCIAL_HISTORY);
--   * het verwijderen van de ORGANISATIE blijft de bewuste, volledige uitgang;
--   * de parent-cascade escapes werken; sinds m22 is de kruislingse uitgave naar het gesloten
--     boekjaar van een ander gebouw geen sloopdeadlock meer maar gewoon eigen historie (T18).
-- ============================================================================

DO $test$
DECLARE
  vu uuid := gen_random_uuid(); vm uuid := gen_random_uuid();
  vorg uuid; vo uuid; vb uuid; vb2 uuid; vfy uuid; vcc uuid; u1 uuid; u2 uuid;
  vorg2 uuid; vbA uuid; vbB uuid; vbC uuid; vbX uuid;
  vfy2 uuid; vfyB uuid; vfund uuid; vdt uuid; ve uuid;
  n int; n_voor int; n_na int;
  ok boolean; ok2 boolean; msg text;
  rep text := ''; pass int := 0; fail int := 0;
  PA text; PM text;
BEGIN
  PA := json_build_object('sub',vu::text,'role','authenticated')::text;
  PM := json_build_object('sub',vm::text,'role','authenticated')::text;
  INSERT INTO auth.users(id) VALUES (vu),(vm);
  PERFORM set_config('request.jwt.claims',PA,true);
  vorg := public.create_organization('M21 ORG');
  INSERT INTO public.memberships(organization_id,user_id,role) VALUES (vorg,vm,'manager');
  INSERT INTO public.owners(organization_id,full_name) VALUES (vorg,'M21') RETURNING id INTO vo;
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'M21 A',100) RETURNING id INTO vb;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vb,'a','appartement',60) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vb,'b','appartement',40) RETURNING id INTO u2;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u1,vo,1,'2026-01-01'),(u2,vo,1,'2026-01-01');

  -- ---------------------------------------------------------------- T1 -----
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb,2021,'2021-01-01','2021-12-31','open') RETURNING id INTO vfy;
  msg := NULL;
  BEGIN DELETE FROM public.fiscal_years WHERE id=vfy; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T1   leeg OPEN boekjaar -> verwijderbaar ' || coalesce('['||msg||']','');

  -- ------------------------------------------------------------- T2 / T3 ---
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy;
  vcc := public.create_charge_call(vfy,'regulier',1000.00,'2026-03-01',NULL,'Q1');
  SELECT count(*) INTO n FROM public.charge_allocations WHERE charge_call_id=vcc;
  BEGIN DELETE FROM public.fiscal_years WHERE id=vfy; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T2/3 lastenoproep + ' || n || ' allocaties -> geblokkeerd';

  -- ---------------------------------------------------------------- T4 -----
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vb,vo,500.00,'virement','2026-04-01');
  BEGIN DELETE FROM public.fiscal_years WHERE id=vfy; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%betalingskoppeling%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T4   betaalde historie -> geblokkeerd, melding noemt de betalingskoppeling';

  -- ---------------------------------------------------------------- T5 -----
  DECLARE vfy5 uuid;
  BEGIN
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg,vb,2027,'2027-01-01','2027-12-31','open') RETURNING id INTO vfy5;
    INSERT INTO public.journal_entries(organization_id,building_id,fiscal_year_id,entry_date,source,description)
    VALUES (vorg,vb,vfy5,'2027-03-01','manual','T5') RETURNING id INTO ve;
    INSERT INTO public.journal_lines(organization_id,journal_entry_id,account_id,debit,credit)
    VALUES (vorg,ve,public.get_account_id(vorg,'6110'),10,0),
           (vorg,ve,public.get_account_id(vorg,'4411'),0,10);
    BEGIN DELETE FROM public.fiscal_years WHERE id=vfy5; ok := false;
    EXCEPTION WHEN others THEN
      ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%journaalpost%');
    END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T5   alleen journaalhistorie -> geblokkeerd';

  -- ---------------------------------------------------------------- T6 -----
  DECLARE vfy6 uuid;
  BEGIN
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg,vb,2028,'2028-01-01','2028-12-31','open') RETURNING id INTO vfy6;
    INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
    VALUES (vorg,vb,vfy6,public.get_account_id(vorg,'6110'),'Lev',250.00,'2028-05-01');
    BEGIN DELETE FROM public.fiscal_years WHERE id=vfy6; ok := false;
    EXCEPTION WHEN others THEN
      ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%uitgave%');
    END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T6   alleen uitgave -> geblokkeerd';

  -- ---------------------------------------------------------------- T7 -----
  DECLARE vfy7 uuid;
  BEGIN
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg,vb,2024,'2024-01-01','2024-12-31','open') RETURNING id INTO vfy7;
    -- Sinds m23 is close_fiscal_year() het enige afsluitpad; een kale UPDATE naar
    -- 'closed' wordt geweigerd omdat er dan geen afsluitbewijs zou ontstaan.
    PERFORM public.close_fiscal_year(vfy7);
    BEGIN DELETE FROM public.fiscal_years WHERE id=vfy7; ok := false;
    EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'Een afgesloten boekjaar%'); END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T7   GESLOTEN boekjaar -> geblokkeerd';

  -- ------------------------------------------------------------ T10 / T11 --
  -- Rolmodel: de invariant geldt voor iedereen. Geen owner-shortcut.
  BEGIN
    PERFORM set_config('request.jwt.claims',PM,true); PERFORM set_config('role','authenticated',true);
    DELETE FROM public.fiscal_years WHERE id=vfy;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T10  manager -> geblokkeerd';

  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    DELETE FROM public.fiscal_years WHERE id=vfy;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T11  owner -> eveneens geblokkeerd';

  BEGIN DELETE FROM public.fiscal_years WHERE id=vfy; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T11b postgres-context -> eveneens geblokkeerd';

  -- ---------------------------------------------------------------- T8 -----
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'M21 B',100) RETURNING id INTO vb2;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb2,2026,'2026-01-01','2026-12-31','open');
  msg := NULL;
  BEGIN
    DELETE FROM public.buildings WHERE id=vb2;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,80); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T8   gebouw ZONDER historie: cascade van leeg boekjaar slaagt ' || coalesce('['||msg||']','');

  msg := NULL;
  BEGIN DELETE FROM public.buildings WHERE id=vb; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%'); msg := left(SQLERRM,90); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T8b  gebouw MET historie -> geblokkeerd (m21, geen omweg meer)';

  -- ---------------------------------------------------------------- T9 -----
  msg := NULL;
  BEGIN
    DELETE FROM public.organizations WHERE id=vorg;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T9   organisatie verwijderen: volledige cascade slaagt ' || coalesce('['||msg||']','');

  -- =========================================================================
  -- Aanvullende gevallen uit de adversariele toets op het ontwerp
  -- =========================================================================
  PERFORM set_config('role','postgres',true);
  PERFORM set_config('request.jwt.claims',PA,true);
  vorg2 := public.create_organization('M21B ORG');
  INSERT INTO public.owners(organization_id,full_name) VALUES (vorg2,'M21B') RETURNING id INTO vo;
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg2,'A',100) RETURNING id INTO vbA;
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg2,'B',100) RETURNING id INTO vbB;
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg2,'C',100) RETURNING id INTO vbC;
  SELECT id INTO vdt FROM public.document_types LIMIT 1;

  -- T12/T13 — verhuisroute: zonder deze guard kon je een jaar met historie naar een leeg gebouw
  -- verplaatsen en dat gebouw slopen.
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg2,vbA,2030,'2030-01-01','2030-12-31','open') RETURNING id INTO vfy;
  INSERT INTO public.journal_entries(organization_id,building_id,fiscal_year_id,entry_date,source,description)
  VALUES (vorg2,vbA,vfy,'2030-03-01','manual','T12') RETURNING id INTO ve;
  INSERT INTO public.journal_lines(organization_id,journal_entry_id,account_id,debit,credit)
  VALUES (vorg2,ve,public.get_account_id(vorg2,'6110'),10,0),
         (vorg2,ve,public.get_account_id(vorg2,'4411'),0,10);
  BEGIN UPDATE public.fiscal_years SET building_id=vbC WHERE id=vfy; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T12  boekjaar MET historie verhuizen -> geblokkeerd';

  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg2,vbA,2031,'2031-01-01','2031-12-31','open') RETURNING id INTO vfy2;
  msg := NULL;
  BEGIN UPDATE public.fiscal_years SET building_id=vbC WHERE id=vfy2; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T13  LEEG boekjaar verhuizen -> toegestaan (guard niet te streng) ' || coalesce('['||msg||']','');

  -- T14/T15 — documenten zijn financieel bewijsmateriaal; concepten niet.
  DECLARE vfyd uuid;
  BEGIN
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg2,vbC,2032,'2032-01-01','2032-12-31','open') RETURNING id INTO vfyd;
    INSERT INTO public.documents(organization_id,building_id,fiscal_year_id,document_type_id,verification_number,title,status)
    VALUES (vorg2,vbC,vfyd,vdt,'VN-T14','Balans 2032','definitief');
    BEGIN DELETE FROM public.fiscal_years WHERE id=vfyd; ok := false;
    EXCEPTION WHEN others THEN
      ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%document%');
    END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T14  definitief document als enige historie -> geblokkeerd';

  DECLARE vfyc uuid;
  BEGIN
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg2,vbC,2033,'2033-01-01','2033-12-31','open') RETURNING id INTO vfyc;
    INSERT INTO public.documents(organization_id,building_id,fiscal_year_id,document_type_id,verification_number,title,status)
    VALUES (vorg2,vbC,vfyc,vdt,'VN-T15','Concept','concept');
    msg := NULL;
    BEGIN DELETE FROM public.fiscal_years WHERE id=vfyc; ok := true;
    EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,80); END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T15  CONCEPT-document telt niet -> verwijderen toegestaan ' || coalesce('['||msg||']','');

  -- T16 — fondsmutaties worden op periode afgeleid, exact zoals fn_guard_closed_fy_fund_movements.
  DECLARE vfyf uuid; vfyg uuid;
  BEGIN
    INSERT INTO public.funds(organization_id,building_id,type,name,balance)
    VALUES (vorg2,vbC,'reserve','Reserve',0) RETURNING id INTO vfund;
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg2,vbC,2034,'2034-01-01','2034-12-31','open') RETURNING id INTO vfyf;
    INSERT INTO public.fund_movements(organization_id,fund_id,movement_type,amount,movement_date,description)
    VALUES (vorg2,vfund,'apport',1000.00,'2034-06-01','binnen');
    BEGIN DELETE FROM public.fiscal_years WHERE id=vfyf; ok := false;
    EXCEPTION WHEN others THEN
      ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%fondsmutatie%');
    END;
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg2,vbC,2035,'2035-01-01','2035-12-31','open') RETURNING id INTO vfyg;
    BEGIN DELETE FROM public.fiscal_years WHERE id=vfyg; ok2 := true;
    EXCEPTION WHEN others THEN ok2 := false; END;
    ok := ok AND ok2;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T16  fondsmutatie binnen de periode -> geblokkeerd; jaar buiten die periode -> toegestaan';

  -- T17 — bewuste uitsluiting, vastgelegd zodat een latere wijziging opvalt.
  DECLARE vfycd uuid;
  BEGIN
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg2,vbC,2036,'2036-01-01','2036-12-31','open') RETURNING id INTO vfycd;
    INSERT INTO public.compliance_deadlines(organization_id,building_id,fiscal_year_id,type,due_date,status)
    VALUES (vorg2,vbC,vfycd,'av_convocatie','2036-06-01','open');
    msg := NULL;
    BEGIN DELETE FROM public.fiscal_years WHERE id=vfycd; ok := true;
    EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,80); END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T17  alleen een compliance-deadline -> bewust toegestaan ' || coalesce('['||msg||']','');

  -- T18 — kruislingse referentie. GEWIJZIGDE VERWACHTING sinds m22.
  -- Tot m21 was gebouw X hier verwijderbaar en bewees deze test dat de parent-escape op
  -- fn_guard_closed_fy_expenses de oude deadlock ('Boekjaar is afgesloten') ophief. m22 verbreedt
  -- de gebouwguard naar directe historie op building_id, en die uitgave IS financiele historie van
  -- gebouw X. De sloop wordt dus nu geweigerd — maar om de JUISTE reden. Deze test legt beide vast:
  -- geblokkeerd met BUILDING_HAS_FINANCIAL_HISTORY, en nadrukkelijk NIET met de deadlockmelding.
  -- De escape zelf wordt bewezen door T20 (organisatiecascade) en door de m22-suite.
  BEGIN
    INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg2,'X-open',100) RETURNING id INTO vbX;
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg2,vbB,2020,'2020-01-01','2020-12-31','open') RETURNING id INTO vfyB;
    INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
    VALUES (vorg2,vbX,vfyB,public.get_account_id(vorg2,'6110'),'Kruis',10.00,'2020-05-01');
    PERFORM public.close_fiscal_year(vfyB);   -- m23: officiele afsluitroute
    msg := NULL;
    BEGIN
      DELETE FROM public.buildings WHERE id=vbX;
      SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
      ok := false;
    EXCEPTION WHEN others THEN
      ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%uitgave%');
      msg := left(SQLERRM,100);
    END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T18  kruislingse uitgave naar gesloten jaar van ander gebouw -> geblokkeerd op de eigen uitgave (m22), niet op de oude deadlock '
             || coalesce('['||msg||']','');

  -- T19 — BEFORE-guards zijn statement-atomisch: een meervoudige DELETE wordt volledig geweigerd.
  -- De fixture wordt hier expliciet opgebouwd zodat het DELETE-statement WERKELIJK meerdere
  -- boekjaren raakt. Voor m22 raakte deze test er maar een, omdat T13 het tweede jaar naar een
  -- ander gebouw had verplaatst; het label claimde toen iets wat de fixture niet uitvoerde.
  DECLARE vfy19a uuid; vfy19b uuid;
  BEGIN
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg2,vbA,2038,'2038-01-01','2038-12-31','open') RETURNING id INTO vfy19a;
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg2,vbA,2039,'2039-01-01','2039-12-31','open') RETURNING id INTO vfy19b;
    -- 2039 krijgt eigen historie, 2038 blijft leeg. Samen met het beschermde 2030 uit T12 staan
    -- er dan drie jaren onder vbA, waarvan twee beschermd en een verwijderbaar.
    INSERT INTO public.journal_entries(organization_id,building_id,fiscal_year_id,entry_date,source,description)
    VALUES (vorg2,vbA,vfy19b,'2039-03-01','manual','T19') RETURNING id INTO ve;
    INSERT INTO public.journal_lines(organization_id,journal_entry_id,account_id,debit,credit)
    VALUES (vorg2,ve,public.get_account_id(vorg2,'6110'),7,0),
           (vorg2,ve,public.get_account_id(vorg2,'4411'),0,7);
  END;
  SELECT count(*) INTO n_voor FROM public.fiscal_years WHERE building_id=vbA;
  BEGIN DELETE FROM public.fiscal_years WHERE building_id=vbA; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%'); END;
  SELECT count(*) INTO n_na FROM public.fiscal_years WHERE building_id=vbA;
  -- harde eis: het statement moet echt meerdere rijen hebben geraakt
  ok := ok AND (n_voor > 1) AND (n_voor = n_na);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T19  meervoudige DELETE over ' || n_voor || ' boekjaren -> volledige weigering, '
             || n_na || ' nog aanwezig';

  -- T20 — offboarding blijft werken, ook met meerdere gebouwen en volledige historie.
  msg := NULL;
  BEGIN
    DELETE FROM public.organizations WHERE id=vorg2;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,100); END;
  SELECT count(*) INTO n FROM public.fiscal_years WHERE organization_id=vorg2;
  ok := ok AND (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T20  organisatie met meerdere gebouwen + volledige historie -> cascade slaagt, 0 restanten '
             || coalesce('['||msg||']','');

  RAISE EXCEPTION E'FISCAL YEAR DELETE GUARD — % geslaagd, % gefaald%', pass, fail, rep;
END $test$;

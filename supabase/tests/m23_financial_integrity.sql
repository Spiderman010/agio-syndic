-- ============================================================================
-- Agio Syndic — m23 financial integrity completion, database-integratie
-- ============================================================================
--
-- Draait ECHT tegen de database; geen mocks. Alles staat in een DO-blok dat aan het eind een
-- exceptie werpt met het testrapport als boodschap, zodat ALLE testdata gegarandeerd wordt
-- teruggerold.
--
-- Uitvoeren:
--   psql "$DATABASE_URL" -f supabase/tests/m23_financial_integrity.sql
-- of plakken in de SQL-editor / via de MCP-connector.
--
-- Verwachte uitkomst: "34 geslaagd, 0 gefaald".
--
-- Wat hier wordt vastgelegd:
--   * banktransacties tellen mee als financiele historie van een gebouw (P1-A);
--   * een boekjaar kan alleen worden afgesloten via close_fiscal_year(), die het
--     afsluitbewijs in dezelfde transactie vastlegt (P1-B);
--   * een uitgave met journaalpost is niet direct verwijderbaar (P1-C);
--   * TRIGGER en REFERENCES zijn ingetrokken voor anon en authenticated (P2-D);
--   * de guards uit m21 en m22 blijven ongewijzigd werken.
-- ============================================================================

DO $test$
DECLARE
  vu uuid := gen_random_uuid(); vm uuid := gen_random_uuid(); vr uuid := gen_random_uuid();
  PA text; PM text; PR text;
  vorg uuid; vorg2 uuid; vo uuid; vo2 uuid;
  vbBank uuid; vbBankLeeg uuid; vbMulti uuid; vbFull uuid; vbA uuid; vbB uuid; vb2 uuid;
  vbank1 uuid; vbank2 uuid; vdir public.bank_tx_direction; vdir2 public.bank_tx_direction;
  vfy uuid; vfyClose uuid; vfyU uuid; vfyR uuid; vfy2 uuid; vcc uuid;
  vexp uuid; vexpNull uuid; vexp2 uuid; ve uuid; vclosing uuid; u1 uuid;
  ok boolean; ok2 boolean; msg text;
  rep text := ''; pass int := 0; fail int := 0;
  n int; n_voor int; n_na int; s numeric; s2 numeric;
BEGIN
  PA := json_build_object('sub',vu::text,'role','authenticated')::text;
  PM := json_build_object('sub',vm::text,'role','authenticated')::text;
  PR := json_build_object('sub',vr::text,'role','authenticated')::text;
  INSERT INTO auth.users(id) VALUES (vu),(vm),(vr);
  PERFORM set_config('request.jwt.claims',PA,true);

  vorg := public.create_organization('M23 ORG A');
  INSERT INTO public.memberships(organization_id,user_id,role)
  VALUES (vorg,vm,'manager'),(vorg,vr,'reader');
  INSERT INTO public.owners(organization_id,full_name) VALUES (vorg,'M23') RETURNING id INTO vo;

  SELECT e.enumlabel::public.bank_tx_direction INTO vdir
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
   WHERE t.typname='bank_tx_direction' ORDER BY e.enumsortorder LIMIT 1;
  SELECT e.enumlabel::public.bank_tx_direction INTO vdir2
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
   WHERE t.typname='bank_tx_direction' ORDER BY e.enumsortorder DESC LIMIT 1;

  -- =========================================================================
  -- P1-A  BANKHISTORIE
  -- =========================================================================

  -- N01  lege bankrekening telt als stamdata
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'BANK-LEEG',100) RETURNING id INTO vbBankLeeg;
  INSERT INTO public.bank_accounts(organization_id,building_id,name,rib)
  VALUES (vorg,vbBankLeeg,'Lege rekening','0110000000000000000000');
  msg := NULL;
  BEGIN DELETE FROM public.buildings WHERE id=vbBankLeeg; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N01  gebouw met LEGE bankrekening, geen boekjaar -> verwijderbaar (stamdata) '
             || coalesce('['||msg||']','');

  -- N02  een enkele banktransactie is financiele historie
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'BANK-TX',100) RETURNING id INTO vbBank;
  INSERT INTO public.bank_accounts(organization_id,building_id,name,rib)
  VALUES (vorg,vbBank,'Hoofdrekening','0110000000000000000001') RETURNING id INTO vbank1;
  INSERT INTO public.bank_transactions(organization_id,bank_account_id,transaction_date,amount,direction,description)
  VALUES (vorg,vbank1,'2026-03-01',125000.00,vdir,'Storting');
  BEGIN DELETE FROM public.buildings WHERE id=vbBank; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%banktransactie%');
    msg := left(SQLERRM,110);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N02  gebouw met 1 banktransactie, geen boekjaar -> geblokkeerd [' || msg || ']';

  -- N03  meerdere rekeningen, maar de historie zit op een ervan
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'BANK-MULTI',100) RETURNING id INTO vbMulti;
  INSERT INTO public.bank_accounts(organization_id,building_id,name,rib)
  VALUES (vorg,vbMulti,'Leeg','0110000000000000000002');
  INSERT INTO public.bank_accounts(organization_id,building_id,name,rib)
  VALUES (vorg,vbMulti,'Met mutaties','0110000000000000000003') RETURNING id INTO vbank2;
  INSERT INTO public.bank_transactions(organization_id,bank_account_id,transaction_date,amount,direction,description)
  VALUES (vorg,vbank2,'2026-04-01',5000.00,vdir,'Bij');
  BEGIN DELETE FROM public.buildings WHERE id=vbMulti; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N03  twee bankrekeningen, een met mutaties -> geblokkeerd';

  -- N04  beide richtingen tellen mee als historie
  BEGIN
    INSERT INTO public.bank_transactions(organization_id,bank_account_id,transaction_date,amount,direction,description)
    VALUES (vorg,vbank2,'2026-04-02',900.00,vdir2,'Af');
    SELECT count(*) INTO n FROM public.bank_transactions bt
      JOIN public.bank_accounts ba ON ba.id=bt.bank_account_id WHERE ba.building_id=vbMulti;
    ok := (public.fn_building_direct_history_summary(vbMulti) LIKE '%'||n||' banktransactie(s)%');
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,80); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N04  beide richtingen tellen mee: ' || n || ' banktransactie(s) in de melding';

  -- N05  meervoudige gebouw-DELETE waarvan een gebouw bankhistorie heeft
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'BANK-VRIJ',100) RETURNING id INTO vbA;
  SELECT count(*) INTO n_voor FROM public.buildings WHERE id IN (vbBank,vbA);
  BEGIN DELETE FROM public.buildings WHERE id IN (vbBank,vbA); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%'); END;
  SELECT count(*) INTO n_na FROM public.buildings WHERE id IN (vbBank,vbA);
  ok := ok AND (n_voor = 2) AND (n_na = 2);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N05  meervoudige gebouw-DELETE (' || n_voor || ' rijen, 1 met bankhistorie) -> volledig geweigerd, '
             || n_na || ' over';

  -- N06  organisatiecascade ruimt bankhistorie wel op
  PERFORM set_config('request.jwt.claims',PA,true);
  vorg2 := public.create_organization('M23 ORG BANK');
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg2,'B',100) RETURNING id INTO vb2;
  INSERT INTO public.bank_accounts(organization_id,building_id,name,rib)
  VALUES (vorg2,vb2,'R','0110000000000000000004') RETURNING id INTO vbank1;
  INSERT INTO public.bank_transactions(organization_id,bank_account_id,transaction_date,amount,direction,description)
  VALUES (vorg2,vbank1,'2026-05-01',700.00,vdir,'x');
  msg := NULL;
  BEGIN
    DELETE FROM public.organizations WHERE id=vorg2;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,100); END;
  SELECT count(*) INTO n FROM public.bank_transactions WHERE organization_id=vorg2;
  ok := ok AND (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N06  organisatiecascade met bankhistorie -> slaagt, ' || n || ' transacties over '
             || coalesce('['||msg||']','');

  -- =========================================================================
  -- P1-B  AFSLUITEN VEREIST EEN AFSLUITBEWIJS
  -- =========================================================================
  PERFORM set_config('request.jwt.claims',PA,true);
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'FULL',100) RETURNING id INTO vbFull;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vbFull,'a','appartement',100) RETURNING id INTO u1;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u1,vo,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vbFull,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy;
  vcc := public.create_charge_call(vfy,'regulier',1000.00,'2026-03-01',NULL,'Q1');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vbFull,2021,'2021-01-01','2021-12-31','open') RETURNING id INTO vfyClose;

  -- N07  manager mag niet rechtstreeks afsluiten
  BEGIN
    PERFORM set_config('request.jwt.claims',PM,true); PERFORM set_config('role','authenticated',true);
    UPDATE public.fiscal_years SET status='closed' WHERE id=vfyClose;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true);
    ok := (SQLERRM LIKE 'FY_CLOSE_REQUIRES_CLOSING%'); msg := left(SQLERRM,90);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N07  manager zet status rechtstreeks op closed -> geweigerd';

  -- N08  owner evenmin: dit is een invariant, geen rolkwestie
  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    UPDATE public.fiscal_years SET status='closed' WHERE id=vfyClose;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'FY_CLOSE_REQUIRES_CLOSING%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N08  owner zet status rechtstreeks op closed -> eveneens geweigerd';

  -- N09  postgres-context evenmin
  BEGIN
    UPDATE public.fiscal_years SET status='closed' WHERE id=vfyClose; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FY_CLOSE_REQUIRES_CLOSING%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N09  postgres-context -> eveneens geweigerd (invariant, geen autorisatie)';

  -- N10  directe INSERT van een afsluitbewijs is dicht voor de client
  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    INSERT INTO public.fiscal_year_closings(organization_id,building_id,fiscal_year_id,result_amount)
    VALUES (vorg,vbFull,vfyClose,0);
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN PERFORM set_config('role','postgres',true); ok := true; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N10  directe INSERT op fiscal_year_closings door authenticated -> geweigerd';

  -- N11  de officiele route werkt en legt de audittrail vast
  msg := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims',PM,true); PERFORM set_config('role','authenticated',true);
    vclosing := public.close_fiscal_year(vfyClose, 'Afsluiting 2021');
    PERFORM set_config('role','postgres',true); ok := true;
  EXCEPTION WHEN others THEN PERFORM set_config('role','postgres',true); ok := false; msg := left(SQLERRM,100); END;
  SELECT count(*) INTO n FROM public.fiscal_years WHERE id=vfyClose AND status='closed';
  SELECT count(*) INTO n_na FROM public.fiscal_year_closings WHERE fiscal_year_id=vfyClose;
  ok := ok AND (n=1) AND (n_na=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N11  close_fiscal_year door manager -> status closed (' || n || ') en afsluitbewijs ('
             || n_na || ') ' || coalesce('['||msg||']','');

  -- N12  het afsluitbewijs bevat een bruikbare audittrail
  SELECT count(*) INTO n FROM public.fiscal_year_closings
   WHERE id=vclosing AND fiscal_year_id=vfyClose AND organization_id=vorg AND building_id=vbFull
     AND closed_by=vm AND closed_at IS NOT NULL AND result_amount IS NOT NULL AND notes='Afsluiting 2021';
  ok := (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N12  afsluitbewijs bevat closed_by, closed_at, result_amount en notities';

  -- N13  tweede afsluiting van hetzelfde jaar
  BEGIN
    PERFORM set_config('request.jwt.claims',PM,true); PERFORM set_config('role','authenticated',true);
    PERFORM public.close_fiscal_year(vfyClose);
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'FY_NOT_OPEN%'); msg := left(SQLERRM,80);
  END;
  SELECT count(*) INTO n FROM public.fiscal_year_closings WHERE fiscal_year_id=vfyClose;
  ok := ok AND (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N13  dubbele afsluiting -> FY_NOT_OPEN, nog steeds ' || n || ' afsluitbewijs';

  -- N14  atomiciteit: een mislukte afsluiting laat geen halve toestand achter
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vbFull,2022,'2022-01-01','2022-12-31','open') RETURNING id INTO vfyU;
  INSERT INTO public.journal_entries(organization_id,building_id,fiscal_year_id,entry_date,source,description)
  VALUES (vorg,vbFull,vfyU,'2022-03-01','manual','Onbalans') RETURNING id INTO ve;
  INSERT INTO public.journal_lines(organization_id,journal_entry_id,account_id,debit,credit)
  VALUES (vorg,ve,public.get_account_id(vorg,'6110'),10,0);
  BEGIN PERFORM public.close_fiscal_year(vfyU); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FY_JOURNAL_UNBALANCED%'); msg := left(SQLERRM,90); END;
  SELECT count(*) INTO n FROM public.fiscal_year_closings WHERE fiscal_year_id=vfyU;
  SELECT count(*) INTO n_na FROM public.fiscal_years WHERE id=vfyU AND status='open';
  ok := ok AND (n=0) AND (n_na=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N14  onbalans -> afsluiting faalt, 0 afsluitbewijzen en jaar nog open (geen halve afsluiting)';
  DELETE FROM public.journal_lines WHERE journal_entry_id=ve;
  DELETE FROM public.journal_entries WHERE id=ve;

  -- N15  reader mag niet afsluiten
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vbFull,2023,'2023-01-01','2023-12-31','open') RETURNING id INTO vfyR;
  BEGIN
    PERFORM set_config('request.jwt.claims',PR,true); PERFORM set_config('role','authenticated',true);
    PERFORM public.close_fiscal_year(vfyR);
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'FY_CLOSE_FORBIDDEN%'); msg := left(SQLERRM,80);
  END;
  SELECT count(*) INTO n FROM public.fiscal_year_closings WHERE fiscal_year_id=vfyR;
  ok := ok AND (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N15  reader roept close_fiscal_year aan -> FY_CLOSE_FORBIDDEN, 0 afsluitbewijzen';

  -- N16  m22 blijft intact: het afsluitbewijs is niet te wissen
  PERFORM set_config('request.jwt.claims',PA,true);
  BEGIN DELETE FROM public.fiscal_year_closings WHERE fiscal_year_id=vfyClose; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FISCAL_YEAR_CLOSING_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N16  afsluitbewijs verwijderen -> nog steeds FISCAL_YEAR_CLOSING_IMMUTABLE (m22 intact)';

  -- N17  heropenen blijft het bestaande owner/admin-model volgen
  BEGIN
    PERFORM set_config('request.jwt.claims',PM,true); PERFORM set_config('role','authenticated',true);
    UPDATE public.fiscal_years SET status='open' WHERE id=vfyClose;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN PERFORM set_config('role','postgres',true); ok := true; END;
  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    UPDATE public.fiscal_years SET status='open' WHERE id=vfyClose;
    PERFORM set_config('role','postgres',true); ok2 := true;
  EXCEPTION WHEN others THEN PERFORM set_config('role','postgres',true); ok2 := false; msg := left(SQLERRM,80); END;
  ok := ok AND ok2;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N17  heropenen: manager geweigerd, owner toegestaan (ongewijzigd model) '
             || coalesce('['||msg||']','');

  -- =========================================================================
  -- P1-C  UITGAVE MET JOURNAALPOST
  -- =========================================================================
  PERFORM set_config('request.jwt.claims',PA,true);

  -- N18  uitgave zonder boekjaar heeft geen journaalpost en blijft verwijderbaar
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
  VALUES (vorg,vbFull,NULL,public.get_account_id(vorg,'6110'),'Lev',75.00,'2026-05-02') RETURNING id INTO vexpNull;
  SELECT count(*) INTO n FROM public.journal_entries WHERE source='expense' AND source_id=vexpNull;
  msg := NULL;
  BEGIN DELETE FROM public.expenses WHERE id=vexpNull; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  ok := ok AND (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N18  uitgave zonder boekjaar (' || n || ' journaalposten) -> verwijderbaar '
             || coalesce('['||msg||']','');

  -- N19  uitgave met journaalpost is bronregistratie
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
  VALUES (vorg,vbFull,vfy,public.get_account_id(vorg,'6110'),'Lev',900.00,'2026-05-01') RETURNING id INTO vexp;
  SELECT count(*) INTO n FROM public.journal_entries WHERE source='expense' AND source_id=vexp;
  BEGIN DELETE FROM public.expenses WHERE id=vexp; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'EXPENSE_HAS_FINANCIAL_HISTORY%'); msg := left(SQLERRM,100);
  END;
  SELECT count(*) INTO n_na FROM public.journal_entries WHERE source='expense' AND source_id=vexp;
  ok := ok AND (n=1) AND (n_na=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N19  uitgave met journaalpost -> geblokkeerd, journaalpost nog aanwezig (' || n_na || ')';

  -- N20  manager
  BEGIN
    PERFORM set_config('request.jwt.claims',PM,true); PERFORM set_config('role','authenticated',true);
    DELETE FROM public.expenses WHERE id=vexp;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'EXPENSE_HAS_FINANCIAL_HISTORY%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  N20  manager -> eveneens geblokkeerd';

  -- N21  owner
  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    DELETE FROM public.expenses WHERE id=vexp;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'EXPENSE_HAS_FINANCIAL_HISTORY%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  N21  owner -> eveneens geblokkeerd';

  -- N22  journaalpost is niet los te koppelen om de guard te ontwijken
  PERFORM set_config('request.jwt.claims',PA,true);
  BEGIN
    PERFORM set_config('role','authenticated',true);
    UPDATE public.journal_entries SET source_id=NULL WHERE source='expense' AND source_id=vexp;
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM public.journal_entries WHERE source='expense' AND source_id=vexp;
    GET DIAGNOSTICS n_na = ROW_COUNT;
    PERFORM set_config('role','postgres',true);
    ok := (n=0) AND (n_na=0);
  EXCEPTION WHEN others THEN PERFORM set_config('role','postgres',true); ok := true; END;
  SELECT count(*) INTO n FROM public.journal_entries WHERE source='expense' AND source_id=vexp;
  ok := ok AND (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N22  journaalpost loskoppelen of wissen door de client -> onmogelijk, koppeling intact';

  -- N23  meervoudige uitgave-DELETE met een beschermde uitgave
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
  VALUES (vorg,vbFull,NULL,public.get_account_id(vorg,'6110'),'Lev',5.00,'2026-05-03') RETURNING id INTO vexp2;
  SELECT count(*) INTO n_voor FROM public.expenses WHERE id IN (vexp,vexp2);
  BEGIN DELETE FROM public.expenses WHERE id IN (vexp,vexp2); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'EXPENSE_HAS_FINANCIAL_HISTORY%'); END;
  SELECT count(*) INTO n_na FROM public.expenses WHERE id IN (vexp,vexp2);
  ok := ok AND (n_voor=2) AND (n_na=2);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N23  meervoudige uitgave-DELETE (' || n_voor || ' rijen, 1 beschermd) -> volledig geweigerd, '
             || n_na || ' over';

  -- =========================================================================
  -- P2-D  PRIVILEGES
  -- =========================================================================
  SELECT count(*) INTO n FROM pg_class c
   WHERE c.relnamespace='public'::regnamespace AND c.relkind in ('r','v','m')
     AND has_table_privilege('anon', c.oid, 'TRIGGER');
  ok := (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N24  anon TRIGGER: ' || n || ' relaties';

  SELECT count(*) INTO n FROM pg_class c
   WHERE c.relnamespace='public'::regnamespace AND c.relkind in ('r','v','m')
     AND has_table_privilege('authenticated', c.oid, 'TRIGGER');
  ok := (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N25  authenticated TRIGGER: ' || n || ' relaties';

  SELECT count(*) INTO n FROM pg_class c
   WHERE c.relnamespace='public'::regnamespace AND c.relkind in ('r','v','m')
     AND has_table_privilege('anon', c.oid, 'REFERENCES');
  ok := (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N26  anon REFERENCES: ' || n || ' relaties';

  SELECT count(*) INTO n FROM pg_class c
   WHERE c.relnamespace='public'::regnamespace AND c.relkind in ('r','v','m')
     AND has_table_privilege('authenticated', c.oid, 'REFERENCES');
  ok := (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N27  authenticated REFERENCES: ' || n || ' relaties';

  -- N28  nieuwe tabellen erven de ingetrokken rechten evenmin, wel gewone CRUD
  BEGIN
    EXECUTE 'CREATE TABLE public.zz_m23_defacl(id int)';
    ok := NOT has_table_privilege('authenticated','public.zz_m23_defacl','TRIGGER')
      AND NOT has_table_privilege('authenticated','public.zz_m23_defacl','REFERENCES')
      AND NOT has_table_privilege('anon','public.zz_m23_defacl','TRIGGER')
      AND NOT has_table_privilege('anon','public.zz_m23_defacl','REFERENCES')
      AND NOT has_table_privilege('authenticated','public.zz_m23_defacl','TRUNCATE')
      AND has_table_privilege('authenticated','public.zz_m23_defacl','SELECT')
      AND has_table_privilege('authenticated','public.zz_m23_defacl','INSERT')
      AND has_table_privilege('authenticated','public.zz_m23_defacl','UPDATE')
      AND has_table_privilege('authenticated','public.zz_m23_defacl','DELETE');
    EXECUTE 'DROP TABLE public.zz_m23_defacl';
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N28  nieuwe tabel: geen TRIGGER/REFERENCES/TRUNCATE, wel SELECT/INSERT/UPDATE/DELETE';

  -- N29  de gewone applicatiepaden blijven werken
  DECLARE vbApp uuid; vfyApp uuid; vccApp uuid; vbWeg uuid; n_del int;
  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    -- INSERT
    INSERT INTO public.buildings(organization_id,name,total_tantiemes)
    VALUES (vorg,'APP',100) RETURNING id INTO vbApp;
    INSERT INTO public.units(building_id,label,unit_type,tantiemes)
    VALUES (vbApp,'a','appartement',100) RETURNING id INTO u1;
    INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u1,vo,1,'2026-01-01');
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg,vbApp,2030,'2030-01-01','2030-12-31','open') RETURNING id INTO vfyApp;
    -- UPDATE
    UPDATE public.buildings SET name='APP2' WHERE id=vbApp;
    -- SELECT via een RLS-policy die op is_org_member leunt
    SELECT count(*) INTO n FROM public.memberships WHERE organization_id=vorg;
    -- RPC
    vccApp := public.create_charge_call(vfyApp,'regulier',500.00,'2030-03-01',NULL,'Q1');
    SELECT count(*), sum(amount) INTO n_na, s FROM public.charge_allocations WHERE charge_call_id=vccApp;
    -- DELETE binnen RLS op een gebouw zonder historie
    INSERT INTO public.buildings(organization_id,name,total_tantiemes)
    VALUES (vorg,'APP-WEG',100) RETURNING id INTO vbWeg;
    DELETE FROM public.buildings WHERE id=vbWeg;
    GET DIAGNOSTICS n_del = ROW_COUNT;
    PERFORM set_config('role','postgres',true);
    ok := (n=3) AND (n_na=1) AND (s=500.00) AND (n_del=1);
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := false; msg := left(SQLERRM,90);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N29  RLS-CRUD, lidmaatschapsquery en create_charge_call blijven werken ('
             || coalesce(n,0) || ' leden, ' || coalesce(n_na,0) || ' allocaties van ' || coalesce(s,0)::text || ') '
             || coalesce('['||msg||']','');

  -- =========================================================================
  -- REGRESSIE OP m21 / m22
  -- =========================================================================
  PERFORM set_config('request.jwt.claims',PA,true);

  -- N30  betalingsguard
  DECLARE vpay uuid;
  BEGIN
    INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
    VALUES (vorg,vbFull,vo,600.00,'virement','2026-04-01') RETURNING id INTO vpay;
    BEGIN DELETE FROM public.payments WHERE id=vpay; ok := false;
    EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'PAYMENT_HAS_FINANCIAL_HISTORY%'); END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  N30  m22 betalingsguard nog intact';

  -- N31  boekjaarguard
  BEGIN DELETE FROM public.fiscal_years WHERE id=vfy; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FY_HAS_FINANCIAL_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  N31  m21 boekjaarguard nog intact';

  -- N32  gebouwguard op niet-bancaire historie
  BEGIN DELETE FROM public.buildings WHERE id=vbFull; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%' AND SQLERRM NOT LIKE '%banktransactie%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N32  m22 gebouwguard nog intact op niet-bancaire historie';

  -- N33  guards op een gesloten boekjaar
  DECLARE vfyC uuid;
  BEGIN
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorg,vbFull,2019,'2019-01-01','2019-12-31','open') RETURNING id INTO vfyC;
    PERFORM public.close_fiscal_year(vfyC);
    BEGIN
      INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
      VALUES (vorg,vbFull,vfyC,public.get_account_id(vorg,'6110'),'Lev',1.00,'2019-05-01');
      ok := false;
    EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'Boekjaar is afgesloten%'); END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N33  closed-fy guards nog intact na afsluiting via de RPC';

  -- N34  allocatie-engine: journaal sluit aan op de subadministratie
  SELECT coalesce(sum(jl.debit),0) INTO s FROM public.journal_lines jl
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
    JOIN public.accounts a ON a.id=jl.account_id
   WHERE je.source_id=vcc AND a.code='4111';
  SELECT coalesce(sum(amount),0) INTO s2 FROM public.charge_allocations WHERE charge_call_id=vcc;
  ok := (s = s2) AND (s2 > 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  N34  allocatie-engine intact: 4111 (' || s::text || ') = som allocaties (' || s2::text || ')';

  RAISE EXCEPTION E'M23 FINANCIAL INTEGRITY — % geslaagd, % gefaald%', pass, fail, rep;
END $test$;

-- ============================================================================
-- Agio Syndic — m22 financial integrity hardening, database-integratie
-- ============================================================================
--
-- Draait ECHT tegen de database; geen mocks. Alles staat in een DO-blok dat aan het eind een
-- exceptie werpt met het testrapport als boodschap, zodat ALLE testdata gegarandeerd wordt
-- teruggerold.
--
-- Uitvoeren:
--   psql "$DATABASE_URL" -f supabase/tests/m22_financial_integrity.sql
-- of plakken in de SQL-editor / via de MCP-connector.
--
-- Verwachte uitkomst: "34 geslaagd, 0 gefaald".
--
-- Wat hier wordt vastgelegd:
--   * TRUNCATE is voor anon en authenticated dicht, ook voor nieuwe tabellen (P1-A);
--   * een betaling met financiele historie is niet direct verwijderbaar (P1-B);
--   * een jaarafsluiting is auditdata en niet direct verwijderbaar (P1-C);
--   * de gebouwguard kijkt naar ALLE financiele historie op building_id, niet alleen
--     naar wat via een boekjaar hangt (P1-D);
--   * is_org_member blijft na de hardening precies hetzelfde doen (P2-E);
--   * offboarding van een organisatie met een GESLOTEN boekjaar vol historie slaagt,
--     nu op expliciete escapes en niet meer op RI-triggervolgorde (P2-F);
--   * een vastgelegd document kan niet terug naar concept (P2-H);
--   * de boekjaarkoppeling van een uitgave ligt vast (P2-I);
--   * de guards nemen een expliciete rijvergrendeling voor ze tellen (TOCTOU).
--
-- NIET afgedekt, eerlijk benoemd: een ECHTE gelijktijdigheidstest met twee parallelle
-- sessies. Dat vereist dblink of postgres_fdw; beide zijn beschikbaar maar niet
-- geinstalleerd, en ze installeren zou een schemawijziging buiten deze ronde zijn.
-- M34 controleert daarom structureel dat de rijvergrendeling in de guards aanwezig is,
-- zodat een latere refactor die hem weghaalt hier stukloopt.
-- ============================================================================

DO $test$
DECLARE
  vu uuid := gen_random_uuid(); vm uuid := gen_random_uuid(); vu2 uuid := gen_random_uuid();
  PA text; PM text; P2 text;
  vorg uuid; vorg2 uuid; vorg3 uuid;
  vo uuid; vo3 uuid;
  vbFull uuid; vbExp uuid; vbFund uuid; vbDoc uuid; vbEmpty uuid; vbEmptyFy uuid;
  vbM22a uuid; vbM22b uuid; vb3 uuid; vb2 uuid;
  vfy25 uuid; vfy26 uuid; vfy29 uuid; vfy27 uuid; vfy3 uuid;
  vcc uuid; vpay uuid; vfund uuid; vdt uuid; ve uuid; vexp uuid;
  vdocDef uuid; vdocCon uuid; vdocFy uuid; u1 uuid;
  ok boolean; ok2 boolean; ok3 boolean; msg text;
  rep text := ''; pass int := 0; fail int := 0;
  n int; n_voor int; n_na int;
BEGIN
  PA := json_build_object('sub',vu::text, 'role','authenticated')::text;
  PM := json_build_object('sub',vm::text, 'role','authenticated')::text;
  P2 := json_build_object('sub',vu2::text,'role','authenticated')::text;
  INSERT INTO auth.users(id) VALUES (vu),(vm),(vu2);
  PERFORM set_config('request.jwt.claims',PA,true);

  vorg := public.create_organization('M22 ORG A');
  INSERT INTO public.memberships(organization_id,user_id,role) VALUES (vorg,vm,'manager');
  INSERT INTO public.owners(organization_id,full_name) VALUES (vorg,'M22') RETURNING id INTO vo;
  SELECT id INTO vdt FROM public.document_types LIMIT 1;

  -- gebouw met volledige historie
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'FULL',100) RETURNING id INTO vbFull;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vbFull,'a','appartement',100) RETURNING id INTO u1;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u1,vo,1,'2025-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vbFull,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy26;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vbFull,2029,'2029-01-01','2029-12-31','open') RETURNING id INTO vfy29;
  vcc := public.create_charge_call(vfy26,'regulier',1000.00,'2026-03-01',NULL,'Q1');
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vbFull,vo,600.00,'virement','2026-04-01') RETURNING id INTO vpay;
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
  VALUES (vorg,vbFull,vfy26,public.get_account_id(vorg,'6110'),'Lev',900.00,'2026-05-01') RETURNING id INTO vexp;
  INSERT INTO public.documents(organization_id,building_id,fiscal_year_id,document_type_id,verification_number,title,status)
  VALUES (vorg,vbFull,vfy26,vdt,'VN-M22-FY','Balans 2026','definitief') RETURNING id INTO vdocFy;
  INSERT INTO public.documents(organization_id,building_id,fiscal_year_id,document_type_id,verification_number,title,status)
  VALUES (vorg,vbFull,vfy26,vdt,'VN-M22-CON','Concept','concept') RETURNING id INTO vdocCon;

  -- apart AFGESLOTEN boekjaar met een jaarafsluiting, voor de closing-tests
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vbFull,2025,'2025-01-01','2025-12-31','open') RETURNING id INTO vfy25;
  INSERT INTO public.fiscal_year_closings(organization_id,building_id,fiscal_year_id,result_amount)
  VALUES (vorg,vbFull,vfy25,100);
  UPDATE public.fiscal_years SET status='closed' WHERE id=vfy25;

  -- gebouwen met precies EEN soort historie en GEEN boekjaar
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'ALLEEN-UITGAVE',100) RETURNING id INTO vbExp;
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
  VALUES (vorg,vbExp,NULL,public.get_account_id(vorg,'6110'),'Lev',5000.00,'2026-05-01');

  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'ALLEEN-FONDS',100) RETURNING id INTO vbFund;
  INSERT INTO public.funds(organization_id,building_id,type,name,balance)
  VALUES (vorg,vbFund,'reserve','R',0) RETURNING id INTO vfund;
  INSERT INTO public.fund_movements(organization_id,fund_id,movement_type,amount,movement_date,description)
  VALUES (vorg,vfund,'apport',3000.00,'2026-06-01','p');

  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'ALLEEN-DOC',100) RETURNING id INTO vbDoc;
  INSERT INTO public.documents(organization_id,building_id,fiscal_year_id,document_type_id,verification_number,title,status)
  VALUES (vorg,vbDoc,NULL,vdt,'VN-M22-DOC','Kwitantie','definitief') RETURNING id INTO vdocDef;

  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'LEEG',100) RETURNING id INTO vbEmpty;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vbEmpty,'a','appartement',100);

  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'LEEG-BOEKJAAR',100) RETURNING id INTO vbEmptyFy;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vbEmptyFy,2027,'2027-01-01','2027-12-31','open') RETURNING id INTO vfy27;

  -- =========================================================================
  -- P1-A  TRUNCATE
  -- =========================================================================
  BEGIN
    PERFORM set_config('role','authenticated',true);
    EXECUTE 'TRUNCATE TABLE public.expenses';
    PERFORM set_config('role','postgres',true); ok := false; msg := 'TRUNCATE SLAAGDE';
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true);
    ok := (SQLERRM LIKE '%permission denied%'); msg := left(SQLERRM,60);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M01  authenticated TRUNCATE expenses -> geweigerd [' || msg || ']';

  BEGIN
    PERFORM set_config('role','authenticated',true);
    EXECUTE 'TRUNCATE TABLE public.payments CASCADE';
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE '%permission denied%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M02  authenticated TRUNCATE payments CASCADE -> geweigerd';

  BEGIN
    PERFORM set_config('role','authenticated',true);
    EXECUTE 'TRUNCATE TABLE public.fiscal_years CASCADE';
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE '%permission denied%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M03  authenticated TRUNCATE fiscal_years CASCADE -> geweigerd';

  BEGIN
    PERFORM set_config('role','anon',true);
    EXECUTE 'TRUNCATE TABLE public.expenses';
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE '%permission denied%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M04  anon TRUNCATE expenses -> geweigerd';

  -- default privileges: een NIEUWE tabel mag geen TRUNCATE meer erven, maar de rest wel
  BEGIN
    EXECUTE 'CREATE TABLE public.zz_m22_defacl(id int)';
    ok  := NOT has_table_privilege('authenticated','public.zz_m22_defacl','TRUNCATE')
       AND NOT has_table_privilege('anon','public.zz_m22_defacl','TRUNCATE');
    ok2 := has_table_privilege('authenticated','public.zz_m22_defacl','SELECT')
       AND has_table_privilege('authenticated','public.zz_m22_defacl','INSERT')
       AND has_table_privilege('authenticated','public.zz_m22_defacl','DELETE');
    EXECUTE 'DROP TABLE public.zz_m22_defacl';
    ok := ok AND ok2;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,60); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M05  nieuwe tabel erft geen TRUNCATE, wel SELECT/INSERT/DELETE';

  -- de gewone datapaden mogen hier niet door geraakt zijn
  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true);
    PERFORM set_config('role','authenticated',true);
    SELECT count(*) INTO n FROM public.buildings WHERE organization_id=vorg;
    INSERT INTO public.owners(organization_id,full_name) VALUES (vorg,'M22 RLS');
    UPDATE public.buildings SET name='FULL' WHERE id=vbFull;
    PERFORM set_config('role','postgres',true);
    ok := (n >= 6);
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := false; msg := left(SQLERRM,70);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M06  normale RLS-paden ongewijzigd: SELECT (' || n || ' gebouwen), INSERT en UPDATE werken';

  -- =========================================================================
  -- P1-B  betalingen
  -- =========================================================================
  SELECT count(*) INTO n FROM public.payment_allocations WHERE payment_id=vpay;
  BEGIN DELETE FROM public.payments WHERE id=vpay; ok := false; msg := 'VERWIJDERD';
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'PAYMENT_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%toewijzing%');
    msg := left(SQLERRM,100);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M07  betaling met ' || n || ' toewijzing(en) -> geblokkeerd, melding noemt de toewijzing';

  -- betaling ZONDER toewijzingen. fn_journal_from_payment maakt bij elke INSERT een
  -- journaalpost, dus ook deze betaling heeft historie. Dat is de bedoelde uitkomst:
  -- corrigeren hoort via een storno te lopen, niet via DELETE.
  DECLARE vpay2 uuid;
  BEGIN
    INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
    VALUES (vorg,vbFull,vo,50.00,'especes','2026-04-02') RETURNING id INTO vpay2;
    SELECT count(*) INTO n FROM public.payment_allocations WHERE payment_id=vpay2;
    BEGIN DELETE FROM public.payments WHERE id=vpay2; ok := false;
    EXCEPTION WHEN others THEN
      ok := (SQLERRM LIKE 'PAYMENT_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%journaalpost%');
      msg := left(SQLERRM,100);
    END;
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M08  betaling met 0 toewijzingen maar wel journaalpost -> geblokkeerd op de journaalpost';

  BEGIN
    PERFORM set_config('request.jwt.claims',PM,true); PERFORM set_config('role','authenticated',true);
    DELETE FROM public.payments WHERE id=vpay;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'PAYMENT_HAS_FINANCIAL_HISTORY%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  M09  manager -> eveneens geblokkeerd';

  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    DELETE FROM public.payments WHERE id=vpay;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'PAYMENT_HAS_FINANCIAL_HISTORY%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  M10  owner -> eveneens geblokkeerd';

  -- De ouderroute via `owners` was al dicht VOOR m22: fn_guard_owner_delete_history (m18/m19)
  -- weigert een eigenaar met vorderingen (ALLOC_OWNER_HAS_HISTORY) of met betalingen
  -- (ALLOC_OWNER_HAS_PAYMENTS), en die guard vuurt eerder in de cascade dan de betalingsguard.
  -- De betalingsguard van m22 is daar dus een tweede slot achter, geen gedragswijziging.
  -- Dat is precies waarom m22 GEEN escape op owners kreeg: zonder eigen ouderguard zou zo'n
  -- escape de betalingsguard gratis omzeilbaar maken.
  PERFORM set_config('request.jwt.claims',PA,true);
  BEGIN DELETE FROM public.owners WHERE id=vo; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'ALLOC_OWNER_HAS_%' OR SQLERRM LIKE 'PAYMENT_HAS_FINANCIAL_HISTORY%');
    msg := left(SQLERRM,90);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M11  eigenaar met betalingen verwijderen -> geblokkeerd, geen omweg via de ouder [' || msg || ']';

  -- =========================================================================
  -- P1-C  jaarafsluiting
  -- =========================================================================
  BEGIN DELETE FROM public.fiscal_year_closings WHERE fiscal_year_id=vfy25; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'FISCAL_YEAR_CLOSING_IMMUTABLE%'); msg := left(SQLERRM,90);
  END;
  SELECT count(*) INTO n FROM public.fiscal_year_closings WHERE fiscal_year_id=vfy25;
  ok := ok AND (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M12  jaarafsluiting direct verwijderen -> geblokkeerd, afsluiting nog aanwezig';

  BEGIN
    PERFORM set_config('request.jwt.claims',PM,true); PERFORM set_config('role','authenticated',true);
    DELETE FROM public.fiscal_year_closings WHERE fiscal_year_id=vfy25;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role','postgres',true); ok := (SQLERRM LIKE 'FISCAL_YEAR_CLOSING_IMMUTABLE%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  M13  manager -> eveneens geblokkeerd';

  -- status en afsluiting blijven consistent: het jaar is nog gesloten EN heeft nog zijn bewijs
  PERFORM set_config('request.jwt.claims',PA,true);
  SELECT count(*) INTO n FROM public.fiscal_years fy
    JOIN public.fiscal_year_closings c ON c.fiscal_year_id=fy.id
   WHERE fy.id=vfy25 AND fy.status='closed';
  ok := (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M14  geen status/afsluiting-divergentie: gesloten jaar heeft nog steeds zijn afsluiting';

  -- =========================================================================
  -- P1-D  gebouwguard verbreed
  -- =========================================================================
  BEGIN DELETE FROM public.buildings WHERE id=vbExp; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%uitgave%');
    msg := left(SQLERRM,110);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M15  gebouw met alleen een uitgave (5.000) en GEEN boekjaar -> geblokkeerd [' || msg || ']';

  BEGIN DELETE FROM public.buildings WHERE id=vbFull; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%'); msg := left(SQLERRM,110);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M16  gebouw met betaling en volledige historie -> geblokkeerd';

  BEGIN DELETE FROM public.buildings WHERE id=vbFund; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%fondsmutatie%');
    msg := left(SQLERRM,110);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M17  gebouw met alleen een fondsmutatie (3.000) en GEEN boekjaar -> geblokkeerd';

  BEGIN DELETE FROM public.buildings WHERE id=vbDoc; ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%' AND SQLERRM LIKE '%document%');
    msg := left(SQLERRM,110);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M18  gebouw met alleen een definitief document en GEEN boekjaar -> geblokkeerd';

  msg := NULL;
  BEGIN DELETE FROM public.buildings WHERE id=vbEmpty; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M19  volledig leeg gebouw (alleen stamdata) -> verwijderbaar ' || coalesce('['||msg||']','');

  msg := NULL;
  BEGIN
    DELETE FROM public.buildings WHERE id=vbEmptyFy;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M20  gebouw met alleen een LEEG open boekjaar -> verwijderbaar (guard niet te streng) '
             || coalesce('['||msg||']','');

  -- meervoudige gebouw-DELETE: een beschermd gebouw weigert het HELE statement
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'M22A',100) RETURNING id INTO vbM22a;
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'M22B',100) RETURNING id INTO vbM22b;
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
  VALUES (vorg,vbM22b,NULL,public.get_account_id(vorg,'6110'),'Lev',12.00,'2026-05-01');
  SELECT count(*) INTO n_voor FROM public.buildings WHERE id IN (vbM22a,vbM22b);
  BEGIN DELETE FROM public.buildings WHERE id IN (vbM22a,vbM22b); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%'); END;
  SELECT count(*) INTO n_na FROM public.buildings WHERE id IN (vbM22a,vbM22b);
  ok := ok AND (n_voor = 2) AND (n_na = 2);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M21  meervoudige gebouw-DELETE (' || n_voor || ' rijen, 1 beschermd) -> volledige weigering, '
             || n_na || ' nog aanwezig';

  -- =========================================================================
  -- P2-H  documenten
  -- =========================================================================
  BEGIN UPDATE public.documents SET status='concept' WHERE id=vdocFy; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'DOCUMENT_IMMUTABLE%'); msg := left(SQLERRM,90); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M22  definitief document -> concept: geblokkeerd (de bewezen bypass is dicht)';

  BEGIN UPDATE public.documents SET verification_number='VERVALST' WHERE id=vdocFy; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'DOCUMENT_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M23  verification_number van een vastgelegd document wijzigen -> geblokkeerd';

  BEGIN UPDATE public.documents SET fiscal_year_id=NULL WHERE id=vdocFy; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'DOCUMENT_IMMUTABLE%'); END;
  BEGIN UPDATE public.documents SET fiscal_year_id=vfy29 WHERE id=vdocFy; ok2 := false;
  EXCEPTION WHEN others THEN ok2 := (SQLERRM LIKE 'DOCUMENT_IMMUTABLE%'); END;
  ok := ok AND ok2;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M24  boekjaarkoppeling van een vastgelegd document losmaken of verplaatsen -> geblokkeerd';

  -- de guard mag de normale flow niet breken
  msg := NULL;
  BEGIN
    UPDATE public.documents SET status='definitief' WHERE id=vdocCon;      -- concept -> definitief
    UPDATE public.documents SET title='Balans 2026 (herzien)' WHERE id=vdocFy;  -- titel blijft vrij
    UPDATE public.documents SET status='geannuleerd' WHERE id=vdocCon;     -- telt nog steeds als historie
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  SELECT count(*) INTO n FROM public.documents WHERE id=vdocCon AND status='geannuleerd';
  ok := ok AND (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M25  concept->definitief, titel wijzigen en definitief->geannuleerd blijven toegestaan '
             || coalesce('['||msg||']','');

  -- =========================================================================
  -- P2-I  uitgaven
  -- =========================================================================
  BEGIN UPDATE public.expenses SET fiscal_year_id=NULL WHERE id=vexp; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'EXPENSE_FY_IMMUTABLE%'); msg := left(SQLERRM,90); END;
  SELECT count(*) INTO n FROM public.expenses WHERE id=vexp AND fiscal_year_id=vfy26;
  ok := ok AND (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M26  uitgave losmaken van haar boekjaar -> geblokkeerd, koppeling ongewijzigd';

  BEGIN UPDATE public.expenses SET fiscal_year_id=vfy29 WHERE id=vexp; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'EXPENSE_FY_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M27  uitgave naar een ander boekjaar verplaatsen -> geblokkeerd';

  -- late toewijzing: fn_journal_from_expense is AFTER INSERT only en zou hier nooit meer
  -- vuren, dus het bedrag zou wel in het boekjaar maar niet in het grootboek belanden.
  DECLARE vexp2 uuid;
  BEGIN
    INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
    VALUES (vorg,vbFull,NULL,public.get_account_id(vorg,'6110'),'Lev',77.00,'2026-05-02') RETURNING id INTO vexp2;
    SELECT count(*) INTO n FROM public.journal_entries WHERE source='expense' AND source_id=vexp2;
    BEGIN UPDATE public.expenses SET fiscal_year_id=vfy26 WHERE id=vexp2; ok := false;
    EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'EXPENSE_FY_LATE_ASSIGNMENT%'); END;
  END;
  ok := ok AND (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M28  late boekjaartoewijzing -> geblokkeerd (uitgave zonder boekjaar had inderdaad '
             || n || ' journaalposten)';

  msg := NULL;
  BEGIN UPDATE public.expenses SET supplier='Andere leverancier' WHERE id=vexp; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M29  uitgave wijzigen zonder het boekjaar te raken -> blijft toegestaan '
             || coalesce('['||msg||']','');

  -- =========================================================================
  -- P2-E  is_org_member
  -- =========================================================================
  PERFORM set_config('request.jwt.claims',P2,true);
  vorg2 := public.create_organization('M22 ORG B');
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg2,'B1',100) RETURNING id INTO vb2;

  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    SELECT count(*) INTO n FROM public.buildings WHERE organization_id=vorg;
    ok  := (n >= 5) AND public.is_org_member(vorg);
    PERFORM set_config('role','postgres',true);
  EXCEPTION WHEN others THEN PERFORM set_config('role','postgres',true); ok := false; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M30  is_org_member: eigen organisatie blijft zichtbaar (' || n || ' gebouwen)';

  BEGIN
    PERFORM set_config('request.jwt.claims',PA,true); PERFORM set_config('role','authenticated',true);
    SELECT count(*) INTO n FROM public.buildings WHERE organization_id=vorg2;
    SELECT count(*) INTO n_na FROM public.organizations WHERE id=vorg2;
    ok := (n = 0) AND (n_na = 0) AND NOT public.is_org_member(vorg2);
    PERFORM set_config('role','postgres',true);
  EXCEPTION WHEN others THEN PERFORM set_config('role','postgres',true); ok := false; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M31  is_org_member: andere tenant blijft onzichtbaar (' || n || ' gebouwen, ' || n_na || ' orgs)';

  -- =========================================================================
  -- P2-F  offboarding met een GESLOTEN boekjaar vol historie
  -- =========================================================================
  PERFORM set_config('request.jwt.claims',PA,true);
  vorg3 := public.create_organization('M22 ORG C');
  INSERT INTO public.owners(organization_id,full_name) VALUES (vorg3,'C') RETURNING id INTO vo3;
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg3,'C1',100) RETURNING id INTO vb3;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vb3,'a','appartement',100) RETURNING id INTO u1;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u1,vo3,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg3,vb3,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy3;
  vcc := public.create_charge_call(vfy3,'regulier',800.00,'2026-03-01',NULL,'Q1');
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg3,vb3,vo3,800.00,'virement','2026-04-01');
  INSERT INTO public.funds(organization_id,building_id,type,name,balance)
  VALUES (vorg3,vb3,'reserve','R',0) RETURNING id INTO vfund;
  INSERT INTO public.fund_movements(organization_id,fund_id,movement_type,amount,movement_date,description)
  VALUES (vorg3,vfund,'apport',400.00,'2026-06-01','p');
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
  VALUES (vorg3,vb3,vfy3,public.get_account_id(vorg3,'6110'),'Lev',300.00,'2026-05-01');
  INSERT INTO public.documents(organization_id,building_id,fiscal_year_id,document_type_id,verification_number,title,status)
  VALUES (vorg3,vb3,vfy3,vdt,'VN-M22-C','Balans','definitief');
  INSERT INTO public.fiscal_year_closings(organization_id,building_id,fiscal_year_id,result_amount)
  VALUES (vorg3,vb3,vfy3,500);
  UPDATE public.fiscal_years SET status='closed' WHERE id=vfy3;

  SELECT count(*) INTO n_voor FROM public.payment_allocations pa
    JOIN public.charge_allocations ca ON ca.id=pa.charge_allocation_id WHERE ca.charge_call_id=vcc;

  msg := NULL;
  BEGIN
    DELETE FROM public.organizations WHERE id=vorg3;
    SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,120); END;
  SELECT count(*) INTO n FROM public.fiscal_years      WHERE organization_id=vorg3;
  SELECT count(*) INTO n_na FROM public.payments       WHERE organization_id=vorg3;
  SELECT count(*) INTO n_voor FROM public.fiscal_year_closings WHERE organization_id=vorg3;
  ok := ok AND (n=0) AND (n_na=0) AND (n_voor=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M32  offboarding: organisatie met GESLOTEN boekjaar + oproep + allocaties + '
             || 'betalingskoppeling + journaal + fondsmutatie + afsluiting -> volledige cascade slaagt, 0 restanten '
             || coalesce('['||msg||']','');

  -- de betalingsguard mag offboarding niet in de weg zitten
  ok := (n_na = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M33  betalingsguard blokkeert de organisatiecascade niet (escape op verdwenen gebouw)';

  -- =========================================================================
  -- TOCTOU: structurele controle
  -- =========================================================================
  SELECT count(*) INTO n FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace
     AND p.proname IN ('fn_guard_fy_delete_history','fn_guard_building_delete_history',
                       'fn_guard_payment_delete_history')
     AND p.prosrc ILIKE '%FOR UPDATE%';
  ok := (n = 3);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  M34  alle drie de historie-guards nemen een expliciete rijvergrendeling (' || n || '/3)';

  RAISE EXCEPTION E'M22 FINANCIAL INTEGRITY — % geslaagd, % gefaald%', pass, fail, rep;
END $test$;

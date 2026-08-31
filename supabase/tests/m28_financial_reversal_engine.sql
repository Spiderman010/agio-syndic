-- ============================================================================
-- Agio Syndic — m24 t/m m28 Financial Reversal Engine, database-integratie
-- ============================================================================
--
-- Draait ECHT tegen de database; geen mocks. Alles staat in een DO-blok dat aan het eind een
-- exceptie werpt met het testrapport als boodschap, zodat ALLE testdata gegarandeerd wordt
-- teruggerold.
--
-- Uitvoeren:
--   psql "$DATABASE_URL" -f supabase/tests/m28_financial_reversal_engine.sql
-- of plakken in de SQL-editor / via de MCP-connector.
--
-- Verwachte uitkomst: "77 geslaagd, 0 gefaald".
--
-- LET OP bij het lezen van deze suite: een gefaalde plpgsql-subtransactie (elk BEGIN/EXCEPTION
-- blok) rolt OOK set_config(..., is_local := true) terug. De JWT-context wordt daarom vlak
-- voor elke rolgevoelige aanroep opnieuw gezet, en nooit eenmalig bovenaan een reeks.
--
-- Wat hier wordt vastgelegd:
--   P01-P22  betalingen: storno, correctie, overbetaling, gesloten boekjaar
--   E01-E12  uitgaven: storno, correctie, historische rekening, bewijsstuk
--   A01-A36  invarianten, immutability, rollen, tenantisolatie, bypasspogingen
--   A37-A43  de vier bevindingen uit de adversariële review op m24-m27, gesloten in m28
-- ============================================================================

DO $test$
DECLARE
  -- gebruikers
  vu uuid := gen_random_uuid();   -- owner
  vm uuid := gen_random_uuid();   -- manager
  vr uuid := gen_random_uuid();   -- reader
  va uuid := gen_random_uuid();   -- accountant
  vx uuid := gen_random_uuid();   -- lid van een ANDERE organisatie
  PU text; PM text; PR text; PA text; PX text;

  -- organisaties en stamdata
  vorg uuid; vorgB uuid;
  vo1 uuid; vo2 uuid; vo3 uuid; vo4 uuid; vo5 uuid; voB uuid;
  vb1 uuid; vb2 uuid; vb3 uuid; vb4 uuid; vb5 uuid; vb6 uuid; vbB uuid;
  u1 uuid; u2 uuid; u3 uuid; u4 uuid; u5 uuid;
  vfy1 uuid; vfy2 uuid; vfy3 uuid; vfy4a uuid; vfy4b uuid; vfy5 uuid; vfy6a uuid; vfy6b uuid;
  vfyB uuid;
  vcc1 uuid; vcc2 uuid; vcc4 uuid; vcc5 uuid; vcc6 uuid;

  -- transacties
  vpay1 uuid; vpay2 uuid; vpay3 uuid; vpay4 uuid; vpay5 uuid; vpay6 uuid; vpayB uuid;
  vrev1 uuid; vrev2 uuid; vrevE uuid;
  vnew1 uuid; vnewE uuid;
  vexp1 uuid; vexp2 uuid; vexp3 uuid; vexpNull uuid;
  vje_orig uuid; vje_rev uuid;
  vacc6110 uuid; vacc6120 uuid; vcat uuid;
  vpa1 uuid; vca1 uuid; vca2 uuid;
  -- m28: fixtures voor de vier bevindingen uit de adversariële review
  vb7 uuid; u7 uuid; vfy7a uuid; vfy7b uuid; vcc7 uuid; vpay7 uuid; vnew7 uuid;
  vje7 uuid; fy_storno uuid; fy_corr uuid; vcb uuid;

  -- meetwaarden
  ok boolean; ok2 boolean;
  n int; n2 int;
  s numeric; s2 numeric; s3 numeric;
  d_orig numeric; c_orig numeric;
  rep text := ''; pass int := 0; fail int := 0;
  msg text;
BEGIN
  PU := json_build_object('sub',vu::text,'role','authenticated')::text;
  PM := json_build_object('sub',vm::text,'role','authenticated')::text;
  PR := json_build_object('sub',vr::text,'role','authenticated')::text;
  PA := json_build_object('sub',va::text,'role','authenticated')::text;
  PX := json_build_object('sub',vx::text,'role','authenticated')::text;
  INSERT INTO auth.users(id) VALUES (vu),(vm),(vr),(va),(vx);

  PERFORM set_config('request.jwt.claims',PU,true);
  vorg := public.create_organization('M26 ORG A');
  INSERT INTO public.memberships(organization_id,user_id,role)
  VALUES (vorg,vm,'manager'),(vorg,vr,'reader'),(vorg,va,'accountant');

  PERFORM set_config('request.jwt.claims',PX,true);
  vorgB := public.create_organization('M26 ORG B');

  PERFORM set_config('request.jwt.claims',PU,true);

  INSERT INTO public.owners(organization_id,full_name) VALUES
    (vorg,'Eigenaar 1'),(vorg,'Eigenaar 2'),(vorg,'Eigenaar 3'),
    (vorg,'Eigenaar 4'),(vorg,'Eigenaar 5');
  SELECT id INTO vo1 FROM public.owners WHERE organization_id=vorg AND full_name='Eigenaar 1';
  SELECT id INTO vo2 FROM public.owners WHERE organization_id=vorg AND full_name='Eigenaar 2';
  SELECT id INTO vo3 FROM public.owners WHERE organization_id=vorg AND full_name='Eigenaar 3';
  SELECT id INTO vo4 FROM public.owners WHERE organization_id=vorg AND full_name='Eigenaar 4';
  SELECT id INTO vo5 FROM public.owners WHERE organization_id=vorg AND full_name='Eigenaar 5';

  -- ---------------------------------------------------------------- gebouw 1
  -- Overbetaling: oproep 600 verdeeld 360/240, betaling 1000.
  INSERT INTO public.buildings(organization_id,name,total_tantiemes)
  VALUES (vorg,'GEBOUW 1 OVERBETALING',100) RETURNING id INTO vb1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vb1,'1a','appartement',60) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vb1,'1b','appartement',40) RETURNING id INTO u2;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date)
  VALUES (u1,vo1,1,'2026-01-01'),(u2,vo1,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb1,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy1;
  vcc1 := public.create_charge_call(vfy1,'regulier',600.00,'2026-03-01');

  -- ---------------------------------------------------------------- gebouw 2
  -- Correctie en gedeeltelijke toewijzing: oproep 500, betaling 200.
  INSERT INTO public.buildings(organization_id,name,total_tantiemes)
  VALUES (vorg,'GEBOUW 2 CORRECTIE',100) RETURNING id INTO vb2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vb2,'2a','appartement',100) RETURNING id INTO u3;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u3,vo2,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb2,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy2;
  vcc2 := public.create_charge_call(vfy2,'regulier',500.00,'2026-03-01');

  -- ---------------------------------------------------------------- gebouw 3
  -- Geen vorderingen: betaling landt volledig op 4419.
  INSERT INTO public.buildings(organization_id,name,total_tantiemes)
  VALUES (vorg,'GEBOUW 3 ALLEEN 4419',100) RETURNING id INTO vb3;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb3,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy3;

  -- ---------------------------------------------------------------- gebouw 4
  -- Vordering in een GESLOTEN boekjaar, betaling in het open jaar.
  INSERT INTO public.buildings(organization_id,name,total_tantiemes)
  VALUES (vorg,'GEBOUW 4 GESLOTEN VORDERING',100) RETURNING id INTO vb4;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vb4,'4a','appartement',100) RETURNING id INTO u4;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u4,vo4,1,'2025-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb4,2025,'2025-01-01','2025-12-31','open') RETURNING id INTO vfy4a;
  vcc4 := public.create_charge_call(vfy4a,'regulier',400.00,'2025-03-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb4,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy4b;

  -- ---------------------------------------------------------------- gebouw 5
  -- Uitgaven.
  INSERT INTO public.buildings(organization_id,name,total_tantiemes)
  VALUES (vorg,'GEBOUW 5 UITGAVEN',100) RETURNING id INTO vb5;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb5,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy5;

  -- ---------------------------------------------------------------- gebouw 6
  -- Betaling waarvan de EIGEN journaalpost in een gesloten jaar staat.
  INSERT INTO public.buildings(organization_id,name,total_tantiemes)
  VALUES (vorg,'GEBOUW 6 GESLOTEN BETALING',100) RETURNING id INTO vb6;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vb6,'6a','appartement',100) RETURNING id INTO u5;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u5,vo5,1,'2025-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb6,2025,'2025-01-01','2025-12-31','open') RETURNING id INTO vfy6a;
  vcc6 := public.create_charge_call(vfy6a,'regulier',300.00,'2025-03-01');

  -- ---------------------------------------------------------------- org B
  INSERT INTO public.owners(organization_id,full_name) VALUES (vorgB,'Eigenaar B') RETURNING id INTO voB;
  INSERT INTO public.buildings(organization_id,name,total_tantiemes)
  VALUES (vorgB,'GEBOUW B',100) RETURNING id INTO vbB;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorgB,vbB,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfyB;

  -- =========================================================================
  -- P  BETALINGEN
  -- =========================================================================

  -- P01  gewone betaling: FIFO wijst 600 toe, 400 blijft over
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date,reference)
  VALUES (vorg,vb1,vo1,1000.00,'virement','2026-04-01','P01') RETURNING id INTO vpay1;
  SELECT count(*), coalesce(sum(amount),0) INTO n, s
    FROM public.payment_allocations WHERE payment_id=vpay1;
  ok := (n = 2 AND s = 600.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P01  betaling 1000 wijst ' || n::text || ' allocatie(s) van samen ' || s::text || ' toe';

  -- P02  origineel journaal: 5141 D 1000, 4111 C 600, 4419 C 400
  SELECT je.id INTO vje_orig FROM public.journal_entries je
   WHERE je.source='payment' AND je.source_id=vpay1;
  SELECT coalesce(sum(jl.debit),0), coalesce(sum(jl.credit),0) INTO d_orig, c_orig
    FROM public.journal_lines jl WHERE jl.journal_entry_id=vje_orig;
  SELECT coalesce(sum(jl.credit),0) INTO s
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
   WHERE jl.journal_entry_id=vje_orig AND a.code='4419';
  ok := (d_orig = 1000.00 AND c_orig = 1000.00 AND s = 400.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P02  origineel journaal sluit (D ' || d_orig::text || ' / C ' || c_orig::text
             || ') met 4419 credit ' || s::text;

  -- P03  settled_amount staat op 360 en 240
  SELECT count(*) INTO n FROM public.charge_allocations
   WHERE charge_call_id=vcc1 AND settled_amount = amount;
  ok := (n = 2);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P03  ' || n::text || ' van 2 vorderingen volledig afgeboekt voor de storno';

  -- P04  reverse_payment slaagt
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    vrev1 := public.reverse_payment(vpay1,'Betaling dubbel geboekt vanuit het bankbestand');
    ok := (vrev1 IS NOT NULL);
  EXCEPTION WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P04  reverse_payment door manager geslaagd' || coalesce(' — '||msg,'');
  msg := NULL;

  -- P05  settled_amount volledig hersteld
  SELECT count(*), coalesce(sum(settled_amount),0) INTO n, s
    FROM public.charge_allocations WHERE charge_call_id=vcc1;
  ok := (n = 2 AND s = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P05  na storno staat settled_amount van beide vorderingen op 0 (som ' || s::text || ')';

  -- P06  twee append-only neutralisatierijen met POSITIEVE bedragen
  SELECT count(*), coalesce(sum(amount),0), coalesce(min(amount),0) INTO n, s, s2
    FROM public.payment_allocation_reversals WHERE reversal_id=vrev1;
  ok := (n = 2 AND s = 600.00 AND s2 > 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P06  ' || n::text || ' neutralisatierij(en) van samen ' || s::text || ', alle positief';

  -- P07  gespiegelde journaalpost met source='reversal' in het open boekjaar
  SELECT je.id INTO vje_rev FROM public.journal_entries je
   WHERE je.source='reversal' AND je.source_id=vrev1;
  SELECT fiscal_year_id INTO vfy1 FROM public.journal_entries WHERE id=vje_rev;
  ok := (vje_rev IS NOT NULL);
  SELECT (status='open') INTO ok2 FROM public.fiscal_years WHERE id=vfy1;
  ok := ok AND coalesce(ok2,false);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P07  gespiegelde journaalpost bestaat met source=reversal in een OPEN boekjaar';

  -- P08  spiegeling: 5141 credit 1000
  SELECT coalesce(sum(jl.credit),0) INTO s
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
   WHERE jl.journal_entry_id=vje_rev AND a.code='5141';
  ok := (s = 1000.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P08  storno boekt 5141 CREDIT ' || s::text || ' (origineel was debet)';

  -- P09  spiegeling: 4111 debet 600
  SELECT coalesce(sum(jl.debit),0) INTO s
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
   WHERE jl.journal_entry_id=vje_rev AND a.code='4111';
  ok := (s = 600.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P09  storno boekt 4111 DEBET ' || s::text || ' (het toegewezen deel)';

  -- P10  spiegeling: 4419 debet 400  — de overbetaling verdwijnt mee
  SELECT coalesce(sum(jl.debit),0) INTO s
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
   WHERE jl.journal_entry_id=vje_rev AND a.code='4419';
  ok := (s = 400.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P10  storno boekt 4419 DEBET ' || s::text || ': het vooruitontvangen bedrag valt vrij';

  -- P11  originele journaalpost ONGEWIJZIGD
  SELECT coalesce(sum(jl.debit),0), coalesce(sum(jl.credit),0) INTO s, s2
    FROM public.journal_lines jl WHERE jl.journal_entry_id=vje_orig;
  ok := (s = d_orig AND s2 = c_orig);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P11  originele journaalpost onaangeroerd (D ' || s::text || ' / C ' || s2::text || ')';

  -- P12  originele betaling bestaat nog, ongewijzigd
  SELECT count(*) INTO n FROM public.payments WHERE id=vpay1 AND amount=1000.00;
  ok := (n = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P12  de originele betaling bestaat nog en is ongewijzigd';

  -- P13  netto grootboekeffect van origineel + storno is exact nul, per rekening
  SELECT count(*) INTO n FROM (
    SELECT a.code, sum(jl.debit - jl.credit) AS netto
      FROM public.journal_lines jl
      JOIN public.accounts a ON a.id=jl.account_id
     WHERE jl.journal_entry_id IN (vje_orig, vje_rev)
     GROUP BY a.code HAVING sum(jl.debit - jl.credit) <> 0) q;
  ok := (n = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P13  netto effect origineel+storno is nul op elke rekening (' || n::text || ' afwijkingen)';

  -- P14  dubbele storno geweigerd
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    PERFORM public.reverse_payment(vpay1,'Nogmaals proberen te storneren voor de test');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALREADY_REVERSED%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  P14  dubbele storno geweigerd';

  -- P15  te korte reden geweigerd
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
    VALUES (vorg,vb3,vo3,50.00,'especes','2026-04-02') RETURNING id INTO vpay3;
    PERFORM public.reverse_payment(vpay3,'te kort');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'REVERSAL_REASON_REQUIRED%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  P15  storno zonder deugdelijke reden geweigerd';

  -- P16  betaling zonder enige vordering: volledig 4419, en de storno spiegelt dat
  PERFORM set_config('request.jwt.claims',PM,true);
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vb3,vo3,300.00,'virement','2026-04-03') RETURNING id INTO vpay4;
  SELECT count(*) INTO n FROM public.payment_allocations WHERE payment_id=vpay4;
  PERFORM set_config('request.jwt.claims',PM,true);
  vrev2 := public.reverse_payment(vpay4,'Betaling hoorde bij een ander gebouw');
  SELECT coalesce(sum(jl.debit),0) INTO s
    FROM public.journal_lines jl
    JOIN public.accounts a ON a.id=jl.account_id
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.source='reversal' AND je.source_id=vrev2 AND a.code='4419';
  SELECT count(*) INTO n2 FROM public.payment_allocation_reversals WHERE reversal_id=vrev2;
  ok := (n = 0 AND s = 300.00 AND n2 = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P16  volledig vooruitontvangen betaling: 0 toewijzingen, storno 4419 debet ' || s::text;

  -- P17  gedeeltelijke toewijzing: betaling 200 op een vordering van 500
  PERFORM set_config('request.jwt.claims',PM,true);
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vb2,vo2,200.00,'cheque','2026-04-04') RETURNING id INTO vpay2;
  SELECT settled_amount INTO s FROM public.charge_allocations WHERE charge_call_id=vcc2;
  ok := (s = 200.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P17  gedeeltelijke betaling boekt ' || s::text || ' van 500 af';

  -- P18  correct_payment: storno + vervangende betaling in EEN transactie
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    vnew1 := public.correct_payment(vpay2, 350.00, '2026-04-04', 'cheque', 'P18-CORR',
                                    'Bedrag verkeerd overgenomen van het bankafschrift');
    ok := (vnew1 IS NOT NULL AND vnew1 <> vpay2);
  EXCEPTION WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P18  correct_payment levert een nieuwe betaling op' || coalesce(' — '||msg,'');
  msg := NULL;

  -- P19  na correctie volgt settled_amount de NIEUWE betaling
  SELECT settled_amount INTO s FROM public.charge_allocations WHERE charge_call_id=vcc2;
  SELECT coalesce(sum(amount),0) INTO s2 FROM public.payment_allocations WHERE payment_id=vnew1;
  ok := (s = 350.00 AND s2 = 350.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P19  na correctie is settled_amount ' || s::text || ' via de nieuwe betaling';

  -- P20  correction_source_id wijst naar de nieuwe betaling; beide betalingen bestaan
  SELECT count(*) INTO n FROM public.financial_reversals
   WHERE source_type='payment' AND source_id=vpay2 AND correction_source_id=vnew1;
  SELECT count(*) INTO n2 FROM public.payments WHERE id IN (vpay2, vnew1);
  ok := (n = 1 AND n2 = 2);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P20  correctie gekoppeld en beide betalingen bewaard (' || n2::text || ' rijen)';

  -- =========================================================================
  -- P  GESLOTEN BOEKJAAR
  -- =========================================================================

  -- P21  vordering uit een GESLOTEN jaar wordt hersteld, gesloten journaal blijft intact
  PERFORM set_config('request.jwt.claims',PU,true);
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vb4,vo4,400.00,'virement','2026-02-01') RETURNING id INTO vpay5;
  SELECT settled_amount INTO s FROM public.charge_allocations WHERE charge_call_id=vcc4;
  PERFORM set_config('request.jwt.claims',PU,true);
  PERFORM public.close_fiscal_year(vfy4a);
  SELECT coalesce(sum(jl.debit),0) INTO s2 FROM public.journal_lines jl
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.fiscal_year_id=vfy4a;
  PERFORM set_config('request.jwt.claims',PM,true);
  PERFORM public.reverse_payment(vpay5,'Betaling was aan het verkeerde gebouw toegerekend');
  SELECT settled_amount INTO s3 FROM public.charge_allocations WHERE charge_call_id=vcc4;
  SELECT coalesce(sum(jl.debit),0) INTO s FROM public.journal_lines jl
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.fiscal_year_id=vfy4a;
  ok := (s3 = 0 AND s = s2);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P21  vordering in gesloten jaar hersteld naar ' || s3::text
             || ' terwijl het gesloten journaal onveranderd bleef (debet ' || s::text || ')';

  -- P22  de storno landde in het OPEN jaar, niet in het gesloten jaar
  SELECT fiscal_year_id INTO vfy4a FROM public.journal_entries
   WHERE source='reversal' AND source_id=(SELECT id FROM public.financial_reversals
                                           WHERE source_type='payment' AND source_id=vpay5);
  ok := (vfy4a = vfy4b);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  P22  de storno is in het OPEN boekjaar geboekt, niet in het afgesloten jaar';

  -- =========================================================================
  -- E  UITGAVEN
  -- =========================================================================

  SELECT public.get_account_id(vorg,'6110') INTO vacc6110;

  -- E01  uitgave met boekjaar krijgt een journaalpost
  PERFORM set_config('request.jwt.claims',PM,true);
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,description,amount,expense_date,receipt_path)
  VALUES (vorg,vb5,vfy5,vacc6110,'Loodgieter','Reparatie lekkage',900.00,'2026-05-01','receipts/x/y/z.pdf')
  RETURNING id INTO vexp1;
  SELECT count(*) INTO n FROM public.journal_entries WHERE source='expense' AND source_id=vexp1;
  ok := (n = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  E01  uitgave met boekjaar krijgt een journaalpost';

  -- E02  reverse_expense slaagt
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    vrevE := public.reverse_expense(vexp1,'Factuur hoorde bij een ander gebouw en is teruggedraaid');
    ok := (vrevE IS NOT NULL);
  EXCEPTION WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E02  reverse_expense geslaagd' || coalesce(' — '||msg,'');
  msg := NULL;

  -- E03  spiegeling: 4411 debet en de lastrekening credit
  SELECT coalesce(sum(jl.debit),0) INTO s
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.source='reversal' AND je.source_id=vrevE AND a.code='4411';
  SELECT coalesce(sum(jl.credit),0) INTO s2
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.source='reversal' AND je.source_id=vrevE AND a.code='6110';
  ok := (s = 900.00 AND s2 = 900.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E03  storno uitgave: 4411 debet ' || s::text || ', 6110 credit ' || s2::text;

  -- E04  originele uitgave en haar bewijsstuk blijven bestaan
  SELECT count(*) INTO n FROM public.expenses
   WHERE id=vexp1 AND amount=900.00 AND receipt_path='receipts/x/y/z.pdf';
  ok := (n = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E04  originele uitgave en receipt_path onaangeroerd na de storno';

  -- E05  netto effect uitgave + storno is nul
  SELECT count(*) INTO n FROM (
    SELECT a.code, sum(jl.debit - jl.credit) AS netto
      FROM public.journal_lines jl
      JOIN public.accounts a ON a.id=jl.account_id
      JOIN public.journal_entries je ON je.id=jl.journal_entry_id
     WHERE (je.source='expense' AND je.source_id=vexp1)
        OR (je.source='reversal' AND je.source_id=vrevE)
     GROUP BY a.code HAVING sum(jl.debit - jl.credit) <> 0) q;
  ok := (n = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E05  netto effect uitgave+storno is nul op elke rekening';

  -- E06  dubbele storno geweigerd
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    PERFORM public.reverse_expense(vexp1,'Poging tot een tweede storno van dezelfde uitgave');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALREADY_REVERSED%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  E06  dubbele storno van een uitgave geweigerd';

  -- E07  uitgave ZONDER boekjaar: geen journaalpost, dus geen storno
  PERFORM set_config('request.jwt.claims',PM,true);
  INSERT INTO public.expenses(organization_id,building_id,account_id,supplier,amount,expense_date)
  VALUES (vorg,vb5,vacc6110,'Nog toe te rekenen',75.00,'2026-05-02') RETURNING id INTO vexpNull;
  BEGIN
    PERFORM public.reverse_expense(vexpNull,'Deze uitgave heeft geen boekjaar en geen journaal');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'EXPENSE_NOT_JOURNALED%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E07  uitgave zonder journaalpost wordt niet gestorneerd maar ingetrokken';

  -- E08  HISTORISCHE REKENING: de standaardrekening van de categorie wijzigt na de boeking
  PERFORM set_config('request.jwt.claims',PU,true);
  INSERT INTO public.accounts(organization_id,code,name,class,type)
  VALUES (vorg,'6120','Onderhoud gebouw',6,'charge') RETURNING id INTO vacc6120;
  INSERT INTO public.expense_categories(organization_id,name,default_account_id)
  VALUES (vorg,'Onderhoud',vacc6110) RETURNING id INTO vcat;
  PERFORM set_config('request.jwt.claims',PM,true);
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,category_id,supplier,amount,expense_date)
  VALUES (vorg,vb5,vfy5,vcat,'Schilder',200.00,'2026-05-03') RETURNING id INTO vexp2;
  SELECT coalesce(sum(jl.debit),0) INTO s
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.source='expense' AND je.source_id=vexp2 AND a.code='6110';
  -- de categorie wijst nu naar een ANDERE rekening dan waarop is geboekt
  PERFORM set_config('request.jwt.claims',PU,true);
  UPDATE public.expense_categories SET default_account_id=vacc6120 WHERE id=vcat;
  PERFORM set_config('request.jwt.claims',PM,true);
  vrevE := public.reverse_expense(vexp2,'Werkzaamheden zijn nooit uitgevoerd, factuur ingetrokken');
  SELECT coalesce(sum(jl.credit),0) INTO s2
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.source='reversal' AND je.source_id=vrevE AND a.code='6110';
  SELECT coalesce(sum(jl.credit),0) INTO s3
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.source='reversal' AND je.source_id=vrevE AND a.code='6120';
  ok := (s = 200.00 AND s2 = 200.00 AND s3 = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E08  storno spiegelt de HISTORISCHE rekening 6110 (' || s2::text
             || ') en niet de gewijzigde categoriestandaard 6120 (' || s3::text || ')';

  -- E09  correct_expense: storno + vervangende uitgave
  PERFORM set_config('request.jwt.claims',PM,true);
  INSERT INTO public.expenses(organization_id,building_id,fiscal_year_id,account_id,supplier,amount,expense_date)
  VALUES (vorg,vb5,vfy5,vacc6110,'Elektricien',500.00,'2026-05-04') RETURNING id INTO vexp3;
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    vnewE := public.correct_expense(vexp3, 450.00, '2026-05-04', vacc6110, NULL,
                                    'Elektricien', 'Bedrag gecorrigeerd', NULL,
                                    'Factuurbedrag was inclusief een korting die nog niet was verwerkt');
    ok := (vnewE IS NOT NULL AND vnewE <> vexp3);
  EXCEPTION WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E09  correct_expense levert een vervangende uitgave op' || coalesce(' — '||msg,'');
  msg := NULL;

  -- E10  de vervangende uitgave heeft een eigen journaalpost van 450
  SELECT coalesce(sum(jl.debit),0) INTO s
    FROM public.journal_lines jl JOIN public.accounts a ON a.id=jl.account_id
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.source='expense' AND je.source_id=vnewE AND a.code='6110';
  ok := (s = 450.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E10  vervangende uitgave heeft een eigen journaalpost van ' || s::text;

  -- E11  netto effect van origineel + storno + correctie = 450 last
  SELECT coalesce(sum(jl.debit - jl.credit),0) INTO s
    FROM public.journal_lines jl
    JOIN public.accounts a ON a.id=jl.account_id
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE a.code='6110'
     AND (je.source_id IN (vexp3, vnewE)
       OR je.source_id = (SELECT id FROM public.financial_reversals
                           WHERE source_type='expense' AND source_id=vexp3));
  ok := (s = 450.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E11  netto last na correctie is ' || s::text || ' en niet 950';

  -- E12  de originele uitgave is niet overschreven
  SELECT count(*) INTO n FROM public.expenses WHERE id=vexp3 AND amount=500.00;
  ok := (n = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  E12  de originele uitgave staat er nog, met het oude bedrag';

  -- =========================================================================
  -- A  INVARIANTEN, IMMUTABILITY, ROLLEN, BYPASSPOGINGEN
  -- =========================================================================

  -- A01  directe verlaging van settled_amount geblokkeerd
  SELECT ca.id INTO vca1 FROM public.charge_allocations ca WHERE ca.charge_call_id=vcc2;
  BEGIN
    UPDATE public.charge_allocations SET settled_amount = 0 WHERE id=vca1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'SETTLEMENT_NOT_DERIVED%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A01  directe UPDATE van settled_amount naar 0 geblokkeerd';

  -- A02  ook VERHOGEN zonder onderliggende toewijzing geblokkeerd
  BEGIN
    UPDATE public.charge_allocations SET settled_amount = settled_amount + 1 WHERE id=vca1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'SETTLEMENT_NOT_DERIVED%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A02  ophogen van settled_amount zonder toewijzing geblokkeerd';

  -- A03  BYPASSPOGING: neutralisatierij zelf schrijven om daarna settled te mogen verlagen
  SELECT id INTO vpa1 FROM public.payment_allocations WHERE charge_allocation_id=vca1 LIMIT 1;
  BEGIN
    INSERT INTO public.payment_allocation_reversals(
      organization_id, reversal_id, payment_allocation_id, charge_allocation_id, amount)
    VALUES (vorg, vrev1, vpa1, vca1, 1.00);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'ALLOCATION_REVERSAL_PARTIAL%' OR SQLERRM LIKE 'ALLOCATION_REVERSAL_MISLINKED%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A03  bypass via een zelfgeschreven neutralisatierij met afwijkend bedrag geblokkeerd';

  -- A04  BYPASSPOGING: neutralisatie die naar een ANDERE vordering wijst
  SELECT ca.id INTO vca2 FROM public.charge_allocations ca WHERE ca.charge_call_id=vcc1 LIMIT 1;
  BEGIN
    INSERT INTO public.payment_allocation_reversals(
      organization_id, reversal_id, payment_allocation_id, charge_allocation_id, amount)
    VALUES (vorg, vrev1, vpa1, vca2, (SELECT amount FROM public.payment_allocations WHERE id=vpa1));
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOCATION_REVERSAL_MISLINKED%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A04  neutralisatie die naar een andere vordering wijst geblokkeerd';

  -- A05  dubbele neutralisatie van dezelfde toewijzing: DB-constraint, niet applicatielogica
  SELECT pa.id INTO vpa1 FROM public.payment_allocations pa
    JOIN public.payment_allocation_reversals par ON par.payment_allocation_id=pa.id LIMIT 1;
  BEGIN
    INSERT INTO public.payment_allocation_reversals(
      organization_id, reversal_id, payment_allocation_id, charge_allocation_id, amount)
    SELECT pa.organization_id, vrev2, pa.id, pa.charge_allocation_id, pa.amount
      FROM public.payment_allocations pa WHERE pa.id=vpa1;
    ok := false;
  EXCEPTION WHEN unique_violation THEN ok := true;
            WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A05  tweede neutralisatie van dezelfde toewijzing afgewezen door UNIQUE' || coalesce(' — '||msg,'');
  msg := NULL;

  -- A06  dubbele reversal-rij: DB-constraint op (source_type, source_id)
  BEGIN
    INSERT INTO public.financial_reversals(
      organization_id, source_type, source_id, reversal_journal_entry_id,
      fiscal_year_id, effective_date, reason)
    VALUES (vorg,'payment',vpay1,vje_rev,vfy2,current_date,'Rechtstreekse tweede storno-rij');
    ok := false;
  EXCEPTION WHEN unique_violation THEN ok := true;
            WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A06  tweede storno-rij voor dezelfde betaling afgewezen door UNIQUE index' || coalesce(' — '||msg,'');
  msg := NULL;

  -- A07  reden korter dan 10 tekens: CHECK op de tabel, niet alleen de RPC
  BEGIN
    INSERT INTO public.financial_reversals(
      organization_id, source_type, source_id, reversal_journal_entry_id,
      fiscal_year_id, effective_date, reason)
    VALUES (vorg,'payment',gen_random_uuid(),vje_rev,vfy2,current_date,'kort');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
            WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A07  CHECK op reason weigert een te korte reden' || coalesce(' — '||msg,'');
  msg := NULL;

  -- A08  financial_reversals UPDATE geblokkeerd
  BEGIN
    UPDATE public.financial_reversals SET reason='Achteraf een andere reden opgeven' WHERE id=vrev1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FINANCIAL_REVERSAL_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A08  storno-rij is onwijzigbaar';

  -- A09  financial_reversals DELETE geblokkeerd
  BEGIN
    DELETE FROM public.financial_reversals WHERE id=vrev1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FINANCIAL_REVERSAL_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A09  storno-rij is niet verwijderbaar';

  -- A10  payment_allocation_reversals DELETE geblokkeerd
  BEGIN
    DELETE FROM public.payment_allocation_reversals WHERE reversal_id=vrev1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOCATION_REVERSAL_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A10  neutralisatierij is niet verwijderbaar';

  -- A11  payments.amount onwijzigbaar na journalisering
  BEGIN
    UPDATE public.payments SET amount=1.00 WHERE id=vpay1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'PAYMENT_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A11  bedrag van een geboekte betaling ligt vast';

  -- A12  payments.method onwijzigbaar (aanscherping van Checkpoint 1)
  BEGIN
    UPDATE public.payments SET method='especes' WHERE id=vpay1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'PAYMENT_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A12  betaalwijze van een geboekte betaling ligt vast';

  -- A13  payments.reference blijft administratief wijzigbaar
  BEGIN
    UPDATE public.payments SET reference='ADMIN-KENMERK' WHERE id=vpay1;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A13  referentie blijft administratief wijzigbaar' || coalesce(' — '||msg,'');
  msg := NULL;

  -- A14  expenses.amount onwijzigbaar na journalisering
  BEGIN
    UPDATE public.expenses SET amount=1.00 WHERE id=vexp1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'EXPENSE_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A14  bedrag van een geboekte uitgave ligt vast';

  -- A15  expenses.account_id onwijzigbaar na journalisering
  BEGIN
    UPDATE public.expenses SET account_id=vacc6120 WHERE id=vexp1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'EXPENSE_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A15  grootboekrekening van een geboekte uitgave ligt vast';

  -- A16  uitgave ZONDER journaalpost blijft bewerkbaar
  BEGIN
    UPDATE public.expenses SET amount=80.00 WHERE id=vexpNull;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A16  uitgave zonder journaalpost blijft bewerkbaar' || coalesce(' — '||msg,'');
  msg := NULL;

  -- A17  ROL: reader mag niet storneren
  PERFORM set_config('request.jwt.claims',PR,true);
  BEGIN
    PERFORM public.reverse_payment(vpay4,'Reader probeert een storno te boeken voor de test');
    ok := false;
  -- De autorisatiecontrole staat VOOR de dubbele-storno-check, dus dit is deterministisch
  -- REVERSAL_FORBIDDEN en niet ALREADY_REVERSED.
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'REVERSAL_FORBIDDEN%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A17  reader mag niet storneren';

  -- A18  ROL: accountant mag wel storneren in een open boekjaar
  PERFORM set_config('request.jwt.claims',PA,true);
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vb3,vo3,25.00,'carte','2026-04-09') RETURNING id INTO vpay6;
  PERFORM set_config('request.jwt.claims',PA,true);
  BEGIN
    PERFORM public.reverse_payment(vpay6,'Accountant corrigeert een verkeerd geboekte ontvangst');
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A18  accountant mag storneren in een open boekjaar' || coalesce(' — '||msg,'');
  msg := NULL;

  -- A19  GESLOTEN BOEKJAAR: manager mag niet, owner wel
  PERFORM set_config('request.jwt.claims',PU,true);
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vb6,vo5,300.00,'virement','2025-06-01') RETURNING id INTO vpay6;
  PERFORM set_config('request.jwt.claims',PU,true);
  PERFORM public.close_fiscal_year(vfy6a);
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb6,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy6b;
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    PERFORM public.reverse_payment(vpay6,'Manager probeert een gesloten boekjaar te raken');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'REVERSAL_FORBIDDEN_CLOSED_FY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A19  manager mag een transactie uit een afgesloten boekjaar niet storneren';

  -- A20  ... maar de owner wel, en de storno landt in het OPEN jaar
  PERFORM set_config('request.jwt.claims',PU,true);
  BEGIN
    PERFORM public.reverse_payment(vpay6,'Owner corrigeert een betaling uit het afgesloten boekjaar');
    SELECT fiscal_year_id INTO vfy6a FROM public.journal_entries
     WHERE source='reversal'
       AND source_id=(SELECT id FROM public.financial_reversals
                       WHERE source_type='payment' AND source_id=vpay6);
    ok := (vfy6a = vfy6b);
  EXCEPTION WHEN others THEN ok := false; msg := SQLERRM; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A20  owner mag wel, en de storno landt in het open boekjaar' || coalesce(' — '||msg,'');
  msg := NULL;

  -- A21  CROSS-TENANT: lid van org B kan een betaling van org A niet storneren
  PERFORM set_config('request.jwt.claims',PU,true);
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vb3,vo3,60.00,'virement','2026-04-10') RETURNING id INTO vpay6;
  PERFORM set_config('request.jwt.claims',PX,true);
  BEGIN
    PERFORM public.reverse_payment(vpay6,'Vreemde organisatie probeert hier te storneren');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'REVERSAL_FORBIDDEN%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A21  cross-tenant storno geweigerd';

  -- A22  FORGED ID: onbekende betaling
  PERFORM set_config('request.jwt.claims',PM,true);
  BEGIN
    PERFORM public.reverse_payment(gen_random_uuid(),'Verzonnen betalings-id voor de test');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'PAYMENT_NOT_FOUND%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  A22  onbekend betalings-id afgewezen';

  -- A23  ROLLBACK-ATOMICITEIT: correct_payment met een ongeldig bedrag laat niets achter
  PERFORM set_config('request.jwt.claims',PM,true);
  SELECT count(*) INTO n FROM public.financial_reversals WHERE source_type='payment' AND source_id=vpay6;
  BEGIN
    PERFORM public.correct_payment(vpay6, -5.00, '2026-04-10', 'virement', NULL,
                                   'Poging tot correctie met een negatief bedrag');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'CORRECTION_AMOUNT_INVALID%'); END;
  SELECT count(*) INTO n2 FROM public.financial_reversals WHERE source_type='payment' AND source_id=vpay6;
  ok := ok AND (n = n2) AND (n2 = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A23  mislukte correctie laat geen halve storno achter (' || n2::text || ' storno-rijen)';

  -- A24  interne kernen zijn GEEN RPC-endpoint
  ok := NOT has_function_privilege('authenticated','public.fn_reverse_payment_core(uuid,text,uuid)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.fn_reverse_expense_core(uuid,text,uuid)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.fn_reversal_authorize(uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('anon','public.reverse_payment(uuid,text)','EXECUTE')
    AND NOT has_function_privilege('anon','public.correct_payment(uuid,numeric,date,public.payment_method,text,text)','EXECUTE');
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A24  interne kernen en anon hebben geen EXECUTE op de engine';

  -- A25  de vier bedoelde RPCs zijn wel aanroepbaar voor authenticated
  ok := has_function_privilege('authenticated','public.reverse_payment(uuid,text)','EXECUTE')
    AND has_function_privilege('authenticated','public.reverse_expense(uuid,text)','EXECUTE')
    AND has_function_privilege('authenticated','public.correct_payment(uuid,numeric,date,public.payment_method,text,text)','EXECUTE')
    AND has_function_privilege('authenticated','public.correct_expense(uuid,numeric,date,uuid,uuid,text,text,text,text)','EXECUTE');
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A25  de vier RPCs zijn aanroepbaar voor authenticated';

  -- A26  anon heeft geen enkel recht op de nieuwe tabellen
  ok := NOT has_table_privilege('anon','public.financial_reversals','SELECT')
    AND NOT has_table_privilege('anon','public.payment_allocation_reversals','SELECT')
    AND NOT has_table_privilege('authenticated','public.financial_reversals','INSERT')
    AND NOT has_table_privilege('authenticated','public.payment_allocation_reversals','INSERT')
    AND NOT has_table_privilege('authenticated','public.v_settlement_integrity','INSERT')
    AND NOT has_table_privilege('authenticated','public.v_financial_reversals','UPDATE');
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A26  anon leest niets, authenticated schrijft niets in tabellen noch views';

  -- A27  SETTLEMENT INTEGRITY: geen enkele afwijking over de hele testset
  SELECT count(*) INTO n FROM public.v_settlement_integrity vsi WHERE vsi.ok IS NOT TRUE;
  SELECT count(*) INTO n2 FROM public.v_settlement_integrity;
  ok := (n = 0 AND n2 > 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A27  v_settlement_integrity: ' || n::text || ' afwijkingen op ' || n2::text || ' vorderingen';

  -- A28  bestaande allocatie-integriteit blijft groen
  SELECT count(*) INTO n FROM public.v_allocation_integrity vai WHERE vai.ok IS NOT TRUE;
  ok := (n = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A28  v_allocation_integrity onaangetast: ' || n::text || ' afwijkingen';

  -- A29  bestaande 4111-reconciliatie blijft groen
  SELECT count(*) INTO n FROM public.v_reconciliation_4111 WHERE verschil <> 0;
  ok := (n = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A29  v_reconciliation_4111 onaangetast: ' || n::text || ' afwijkingen';

  -- A30  elke storno-journaalpost sluit
  SELECT count(*) INTO n FROM (
    SELECT je.id FROM public.journal_entries je
      JOIN public.journal_lines jl ON jl.journal_entry_id=je.id
     WHERE je.source='reversal'
     GROUP BY je.id HAVING sum(jl.debit) <> sum(jl.credit) OR count(*) < 2) q;
  SELECT count(*) INTO n2 FROM public.journal_entries WHERE source='reversal';
  ok := (n = 0 AND n2 > 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A30  alle ' || n2::text || ' storno-posten sluiten en hebben minimaal 2 regels';

  -- A31  geen enkele storno-journaalpost staat in een GESLOTEN boekjaar
  SELECT count(*) INTO n FROM public.journal_entries je
    JOIN public.fiscal_years fy ON fy.id=je.fiscal_year_id
   WHERE je.source='reversal' AND fy.status='closed';
  ok := (n = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A31  geen enkele storno is in een afgesloten boekjaar geboekt';

  -- A32  STORNO VAN EEN STORNO is structureel onmogelijk
  BEGIN
    PERFORM public.reverse_payment(vrev1,'Poging om een storno zelf te storneren');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'PAYMENT_NOT_FOUND%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A32  een storno is geen betaling en kan dus niet zelf worden gestorneerd';

  -- A33  v_financial_reversals markeert een correctie over de jaargrens
  SELECT count(*) INTO n FROM public.v_financial_reversals WHERE is_correctie IS TRUE;
  SELECT count(*) INTO n2 FROM public.v_financial_reversals WHERE is_correctie_vorig_boekjaar IS TRUE;
  ok := (n >= 2 AND n2 >= 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A33  v_financial_reversals: ' || n::text || ' correcties, waarvan '
             || n2::text || ' over een boekjaargrens';

  -- A34  de gestorneerde betaling blijft NIET verwijderbaar (m22 blijft intact)
  BEGIN
    DELETE FROM public.payments WHERE id=vpay1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'PAYMENT_HAS_FINANCIAL_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A34  een gestorneerde betaling blijft onverwijderbaar (m22 intact)';

  -- A35  de gestorneerde uitgave blijft NIET verwijderbaar (m23 blijft intact)
  BEGIN
    DELETE FROM public.expenses WHERE id=vexp1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'EXPENSE_HAS_FINANCIAL_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A35  een gestorneerde uitgave blijft onverwijderbaar (m23 intact)';

  -- A36  effective_date en created_by zijn vastgelegd
  SELECT count(*) INTO n FROM public.financial_reversals
   WHERE effective_date = current_date AND created_by IS NOT NULL;
  SELECT count(*) INTO n2 FROM public.financial_reversals;
  ok := (n = n2 AND n2 > 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A36  alle ' || n2::text || ' storno-rijen dragen effective_date en created_by';

  -- =========================================================================
  -- A37-A41  de vier bevindingen uit de adversariële review op m24-m27 (m28)
  -- =========================================================================

  -- A37  P1-A: een verzonnen toewijzing bovenop een bestaande betaling
  -- Zonder fn_guard_pa_within_payment mocht settled_amount daarna legitiem omhoog, en
  -- v_settlement_integrity meldde ok=true omdat die dezelfde vergelijking stelt.
  BEGIN
    INSERT INTO public.payment_allocations(organization_id,payment_id,charge_allocation_id,amount)
    SELECT vorg, vnew1, ca.id, 5000.00 FROM public.charge_allocations ca WHERE ca.charge_call_id=vcc2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOCATION_EXCEEDS_PAYMENT%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A37  toewijzing die de betaling overschrijdt geweigerd';

  -- A38  de bijbehorende detectieview meldt geen enkele afwijking
  SELECT count(*) INTO n FROM public.v_payment_allocation_integrity vpi WHERE vpi.ok IS NOT TRUE;
  SELECT count(*) INTO n2 FROM public.v_payment_allocation_integrity;
  ok := (n = 0 AND n2 > 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A38  v_payment_allocation_integrity: ' || n::text || ' afwijkingen op ' || n2::text || ' betalingen';

  -- A39  P1-C: de gespiegelde journaalpost is het bewijs en mag niet los verdwijnen
  SELECT reversal_journal_entry_id INTO vje7 FROM public.financial_reversals
   WHERE source_type='payment' AND source_id=vpay1;
  BEGIN
    DELETE FROM public.journal_entries WHERE id=vje7;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'REVERSAL_ENTRY_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A39  storno-journaalpost is niet los verwijderbaar';

  -- A40  P1-D: storno en correctie mogen niet over twee OPEN boekjaren splitsen
  PERFORM set_config('request.jwt.claims',PU,true);
  INSERT INTO public.buildings(organization_id,name,total_tantiemes)
  VALUES (vorg,'GEBOUW 7 TWEE OPEN JAREN',100) RETURNING id INTO vb7;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes)
  VALUES (vb7,'7a','appartement',100) RETURNING id INTO u7;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u7,vo1,1,'2025-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb7,2025,'2025-01-01','2025-12-31','open') RETURNING id INTO vfy7a;
  vcc7 := public.create_charge_call(vfy7a,'regulier',1000.00,'2025-03-01');
  -- betaling wordt geboekt terwijl 2025 het enige open jaar is
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (vorg,vb7,vo1,400.00,'virement','2025-06-01') RETURNING id INTO vpay7;
  -- daarna gaat 2026 open; 2025 blijft OPEN
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb7,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy7b;
  PERFORM set_config('request.jwt.claims',PM,true);
  vnew7 := public.correct_payment(vpay7, 350.00, '2025-06-01', 'virement', NULL,
                                  'Bedrag verkeerd overgenomen uit het bankbestand van 2025');
  SELECT fiscal_year_id INTO fy_storno FROM public.journal_entries
   WHERE source='reversal' AND source_id=(SELECT id FROM public.financial_reversals
                                           WHERE source_type='payment' AND source_id=vpay7);
  SELECT fiscal_year_id INTO fy_corr FROM public.journal_entries
   WHERE source='payment' AND source_id=vnew7;
  ok := (fy_storno = fy_corr AND fy_storno = vfy7b);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A40  storno en correctie landen in HETZELFDE open boekjaar ('
             || (fy_storno = fy_corr)::text || '), namelijk het meest recente';

  -- A41  P1-B: een gebruiker die een storno boekte moet verwijderbaar blijven (offboarding/AVG)
  -- De accountant boekte in A18 een storno. ON DELETE SET NULL op created_by wordt door
  -- PostgreSQL als een UPDATE uitgevoerd; die moet precies hier doorgelaten worden.
  SELECT count(*) INTO n FROM public.financial_reversals WHERE created_by = va;
  DELETE FROM public.memberships WHERE organization_id=vorg AND user_id=va;
  BEGIN
    DELETE FROM auth.users WHERE id=va;
    SELECT count(*) INTO n2 FROM public.financial_reversals WHERE created_by IS NULL;
    ok := (n > 0 AND n2 >= n);
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,60); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A41  gebruiker met ' || n::text || ' storno(s) verwijderd, auditrij geanonimiseerd'
             || coalesce(' — '||msg,'');
  msg := NULL;

  -- A42  ... maar elke ANDERE wijziging aan een storno blijft geweigerd
  BEGIN
    UPDATE public.financial_reversals SET effective_date = current_date - 5 WHERE id=vrev1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FINANCIAL_REVERSAL_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A42  de anonimisering opent geen algemene UPDATE-route';

  -- A43  settlement blijft sluitend na alles wat hierboven is gebeurd
  SELECT count(*) INTO n FROM public.v_settlement_integrity vsi WHERE vsi.ok IS NOT TRUE;
  ok := (n = 0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  A43  settlement-integriteit sluitend na de volledige suite: ' || n::text || ' afwijkingen';

  RAISE EXCEPTION E'M24-M28 FINANCIAL REVERSAL ENGINE — % geslaagd, % gefaald%', pass, fail, rep;
END $test$;

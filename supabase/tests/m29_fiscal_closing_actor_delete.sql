-- ============================================================================
-- Agio Syndic — m29 fiscal closing actor deletion, database-integratie
-- ============================================================================
--
-- Draait ECHT tegen de database; geen mocks. Alles staat in een DO-blok dat aan het eind een
-- exceptie werpt met het testrapport als boodschap, zodat ALLE testdata gegarandeerd wordt
-- teruggerold.
--
-- Uitvoeren:
--   psql "$DATABASE_URL" -f supabase/tests/m29_fiscal_closing_actor_delete.sql
-- of plakken in de SQL-editor / via de MCP-connector.
--
-- Verwachte uitkomst: "20 geslaagd, 0 gefaald".
--
-- Wat hier wordt vastgelegd:
--   T1-T2    een gebruiker die ooit een boekjaar afsloot kan worden verwijderd; het
--            afsluitbewijs blijft bestaan en closed_by wordt NULL;
--   T3-T7    de afsluiting blijft verder volledig onwijzigbaar, inclusief een handmatige
--            poging om closed_by op NULL te zetten terwijl de gebruiker nog bestaat;
--   T8-T10   de bestaande cascades (boekjaar, gebouw, organisatie) blijven ongewijzigd;
--   T11-T13  gebruikers zonder afsluiting, met meerdere afsluitingen, en de m28-fix voor
--            financial_reversals blijven werken;
--   T14-T16  close_fiscal_year en de omliggende invarianten zijn niet geraakt.
--
-- LET OP: een gefaalde plpgsql-subtransactie (elk BEGIN/EXCEPTION blok) rolt OOK
-- set_config(..., is_local := true) terug. De JWT-context wordt daarom vlak voor elke
-- rolgevoelige aanroep opnieuw gezet.
-- ============================================================================

DO $test$
DECLARE
  vu uuid := gen_random_uuid();   -- owner, blijft bestaan
  vm uuid := gen_random_uuid();   -- manager die afsluit en wordt verwijderd
  vk uuid := gen_random_uuid();   -- tweede manager, meerdere afsluitingen
  vz uuid := gen_random_uuid();   -- gebruiker zonder enige afsluiting
  PU text; PM text; PK text;

  vorg uuid; vo uuid;
  vb uuid; vb2 uuid; vb3 uuid; vb4 uuid; vbCasc uuid;
  vfy uuid; vfy2 uuid; vfy3 uuid; vfyCasc uuid; vfyOrg uuid;
  vclosing uuid; vclosing2 uuid; vclosing3 uuid; vcloseCasc uuid;
  vcc uuid; u1 uuid; vpay uuid; vrev uuid;

  ok boolean; n int; n2 int; cb uuid; msg text;
  d_amount numeric; d_closed timestamptz;
  rep text := ''; pass int := 0; fail int := 0;
BEGIN
  PU := json_build_object('sub',vu::text,'role','authenticated')::text;
  PM := json_build_object('sub',vm::text,'role','authenticated')::text;
  PK := json_build_object('sub',vk::text,'role','authenticated')::text;
  INSERT INTO auth.users(id) VALUES (vu),(vm),(vk),(vz);

  PERFORM set_config('request.jwt.claims',PU,true);
  vorg := public.create_organization('M29 ORG');
  INSERT INTO public.memberships(organization_id,user_id,role)
  VALUES (vorg,vm,'manager'),(vorg,vk,'manager');
  INSERT INTO public.owners(organization_id,full_name) VALUES (vorg,'Eigenaar') RETURNING id INTO vo;

  -- gebouw 1: de hoofdcasus
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'B1',100) RETURNING id INTO vb;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy;

  PERFORM set_config('request.jwt.claims',PM,true);
  vclosing := public.close_fiscal_year(vfy, 'Afsluiting door de manager');
  SELECT closed_by, result_amount, closed_at INTO cb, d_amount, d_closed
    FROM public.fiscal_year_closings WHERE id=vclosing;

  -- =========================================================================
  -- T1/T2  gebruiker verwijderen -> lukt, afsluiting blijft, closed_by NULL
  -- =========================================================================
  ok := (cb = vm);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T0  afsluitbewijs draagt closed_by van de manager';

  DELETE FROM public.memberships WHERE organization_id=vorg AND user_id=vm;
  BEGIN
    DELETE FROM auth.users WHERE id=vm;
    ok := true; msg := NULL;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,60); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T1  DELETE auth.users van een gebruiker met afsluiting slaagt' || coalesce(' — '||msg,'');
  msg := NULL;

  SELECT count(*) INTO n FROM public.fiscal_year_closings WHERE id=vclosing;
  SELECT closed_by INTO cb FROM public.fiscal_year_closings WHERE id=vclosing;
  ok := (n = 1 AND cb IS NULL);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T2  afsluitbewijs bestaat nog (' || n::text || ') en closed_by is NULL';

  -- financiële auditdata onaangeroerd
  SELECT count(*) INTO n FROM public.fiscal_year_closings
   WHERE id=vclosing AND result_amount IS NOT DISTINCT FROM d_amount AND closed_at = d_closed
     AND notes = 'Afsluiting door de manager';
  ok := (n = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T2b result_amount, closed_at en notes ongewijzigd na anonimisering';

  -- het boekjaar blijft afgesloten
  SELECT count(*) INTO n FROM public.fiscal_years WHERE id=vfy AND status='closed';
  ok := (n = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T2c het boekjaar staat nog steeds op closed';

  -- =========================================================================
  -- T3-T6  de afsluiting blijft verder onwijzigbaar
  -- =========================================================================
  -- Nieuwe afsluiting met een NOG BESTAANDE actor, om de guard te testen.
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'B2',100) RETURNING id INTO vb2;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb2,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy2;
  PERFORM set_config('request.jwt.claims',PK,true);
  vclosing2 := public.close_fiscal_year(vfy2, 'Afsluiting door manager K');

  -- T3  handmatige UPDATE closed_by = NULL terwijl de gebruiker BESTAAT
  BEGIN
    UPDATE public.fiscal_year_closings SET closed_by = NULL WHERE id=vclosing2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'Een vastgelegde jaarafsluiting is onwijzigbaar%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T3  handmatige UPDATE closed_by=NULL geweigerd (gebruiker bestaat nog)';

  -- T3b  closed_by naar een ANDERE gebruiker zetten
  BEGIN
    UPDATE public.fiscal_year_closings SET closed_by = vu WHERE id=vclosing2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'Een vastgelegde jaarafsluiting is onwijzigbaar%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T3b closed_by naar een andere gebruiker herschrijven geweigerd';

  -- T4  closed_at
  BEGIN
    UPDATE public.fiscal_year_closings SET closed_at = now() - interval '5 days' WHERE id=vclosing2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'Een vastgelegde jaarafsluiting is onwijzigbaar%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T4  closed_at wijzigen geweigerd';

  -- T5  result_amount
  BEGIN
    UPDATE public.fiscal_year_closings SET result_amount = 999999.99 WHERE id=vclosing2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'Een vastgelegde jaarafsluiting is onwijzigbaar%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T5  result_amount wijzigen geweigerd';

  -- T6  notes
  BEGIN
    UPDATE public.fiscal_year_closings SET notes = 'Achteraf een andere toelichting' WHERE id=vclosing2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'Een vastgelegde jaarafsluiting is onwijzigbaar%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T6  notes wijzigen geweigerd';

  -- T7  DELETE rechtstreeks
  BEGIN
    DELETE FROM public.fiscal_year_closings WHERE id=vclosing2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FISCAL_YEAR_CLOSING_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T7  rechtstreekse DELETE van de afsluiting geweigerd';

  -- =========================================================================
  -- T8-T10  cascades: bestaand bedoeld gedrag blijft
  -- =========================================================================
  -- Boekjaar met een afsluiting is niet verwijderbaar (m21/m22-gedrag).
  BEGIN
    DELETE FROM public.fiscal_years WHERE id=vfy2;
    ok := false;
  EXCEPTION WHEN others THEN ok := true; msg := left(SQLERRM,45); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T8  boekjaar met afsluiting blijft onverwijderbaar — ' || coalesce(msg,'');
  msg := NULL;

  -- Gebouw met een afgesloten boekjaar is niet verwijderbaar (m22-gedrag).
  BEGIN
    DELETE FROM public.buildings WHERE id=vb2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T9  gebouw met afgesloten boekjaar blijft onverwijderbaar';

  -- Organisatiecascade ruimt alles op, inclusief de afsluiting.
  DECLARE vorgC uuid; vuC uuid := gen_random_uuid();
  BEGIN
    INSERT INTO auth.users(id) VALUES (vuC);
    PERFORM set_config('request.jwt.claims', json_build_object('sub',vuC::text,'role','authenticated')::text, true);
    vorgC := public.create_organization('M29 CASCADE');
    INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorgC,'BC',100) RETURNING id INTO vbCasc;
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorgC,vbCasc,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfyCasc;
    vcloseCasc := public.close_fiscal_year(vfyCasc, 'Afsluiting die mee mag cascaderen');
    DELETE FROM public.organizations WHERE id=vorgC;
    SELECT count(*) INTO n FROM public.fiscal_year_closings WHERE id=vcloseCasc;
    ok := (n = 0);
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,60); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T10 organisatiecascade ruimt de afsluiting op' || coalesce(' — '||msg,'');
  msg := NULL;

  -- =========================================================================
  -- T11-T13  gebruikers zonder/meerdere afsluitingen, en m28 blijft intact
  -- =========================================================================
  BEGIN
    DELETE FROM auth.users WHERE id=vz;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,50); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T11 gebruiker zonder afsluiting normaal verwijderbaar' || coalesce(' — '||msg,'');
  msg := NULL;

  -- Manager K heeft nu twee afsluitingen (vclosing2 en een derde).
  PERFORM set_config('request.jwt.claims',PU,true);
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'B3',100) RETURNING id INTO vb3;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb3,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfy3;
  PERFORM set_config('request.jwt.claims',PK,true);
  vclosing3 := public.close_fiscal_year(vfy3, 'Tweede afsluiting door manager K');

  SELECT count(*) INTO n FROM public.fiscal_year_closings WHERE closed_by = vk;
  DELETE FROM public.memberships WHERE organization_id=vorg AND user_id=vk;
  BEGIN
    DELETE FROM auth.users WHERE id=vk;
    SELECT count(*) INTO n2 FROM public.fiscal_year_closings WHERE id IN (vclosing2, vclosing3) AND closed_by IS NULL;
    ok := (n = 2 AND n2 = 2);
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,60); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T12 gebruiker met ' || n::text || ' afsluitingen verwijderd, alle rijen bewaard en geanonimiseerd'
             || coalesce(' — '||msg,'');
  msg := NULL;

  -- T13  de m28-fix voor financial_reversals blijft werken (storno + user delete)
  DECLARE vuR uuid := gen_random_uuid(); vmR uuid := gen_random_uuid(); vorgR uuid;
          vbR uuid; vfyR uuid; voR uuid; uR uuid; vpayR uuid; vrevR uuid;
  BEGIN
    INSERT INTO auth.users(id) VALUES (vuR),(vmR);
    PERFORM set_config('request.jwt.claims', json_build_object('sub',vuR::text,'role','authenticated')::text, true);
    vorgR := public.create_organization('M29 REVERSAL');
    INSERT INTO public.memberships(organization_id,user_id,role) VALUES (vorgR,vmR,'manager');
    INSERT INTO public.owners(organization_id,full_name) VALUES (vorgR,'E') RETURNING id INTO voR;
    INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorgR,'BR',100) RETURNING id INTO vbR;
    INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (vbR,'a','appartement',100) RETURNING id INTO uR;
    INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (uR,voR,1,'2026-01-01');
    INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
    VALUES (vorgR,vbR,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfyR;
    PERFORM public.create_charge_call(vfyR,'regulier',500.00,'2026-03-01');
    PERFORM set_config('request.jwt.claims', json_build_object('sub',vmR::text,'role','authenticated')::text, true);
    INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
    VALUES (vorgR,vbR,voR,500.00,'virement','2026-04-01') RETURNING id INTO vpayR;
    PERFORM set_config('request.jwt.claims', json_build_object('sub',vmR::text,'role','authenticated')::text, true);
    vrevR := public.reverse_payment(vpayR,'Storno om de m28-fix te controleren na m29');
    DELETE FROM public.memberships WHERE organization_id=vorgR AND user_id=vmR;
    DELETE FROM auth.users WHERE id=vmR;
    SELECT count(*) INTO n FROM public.financial_reversals WHERE id=vrevR AND created_by IS NULL;
    ok := (n = 1);
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,60); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T13 m28: storno blijft bestaan en created_by wordt NULL na user-delete' || coalesce(' — '||msg,'');
  msg := NULL;

  -- =========================================================================
  -- T14-T16  close_fiscal_year en de omliggende invarianten
  -- =========================================================================
  PERFORM set_config('request.jwt.claims',PU,true);
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (vorg,'B4',100) RETURNING id INTO vb4;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (vorg,vb4,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO vfyOrg;
  BEGIN
    PERFORM public.close_fiscal_year(vfyOrg, 'Afsluiting na m29');
    SELECT count(*) INTO n FROM public.fiscal_year_closings WHERE fiscal_year_id=vfyOrg AND closed_by = vu;
    ok := (n = 1);
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,55); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T14 close_fiscal_year werkt onveranderd en zet closed_by' || coalesce(' — '||msg,'');
  msg := NULL;

  -- T15  een gesloten boekjaar kan niet nogmaals via de RPC worden afgesloten
  BEGIN
    PERFORM public.close_fiscal_year(vfyOrg, 'Tweede poging');
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'FY_NOT_OPEN%' OR SQLERRM LIKE 'FY_CLOSING_EXISTS%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T15 opnieuw afsluiten via de RPC blijft geweigerd';

  -- T16  de guard is geen RPC-endpoint
  ok := NOT has_function_privilege('authenticated','public.fn_guard_fy_closing_immutable()','EXECUTE')
    AND NOT has_function_privilege('anon','public.fn_guard_fy_closing_immutable()','EXECUTE');
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T16 fn_guard_fy_closing_immutable is voor niemand uitvoerbaar';

  RAISE EXCEPTION E'M29 FISCAL CLOSING ACTOR DELETE — % geslaagd, % gefaald%', pass, fail, rep;
END $test$;

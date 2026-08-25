-- ============================================================================
-- Agio Syndic — allocation engine (database-integratie)
-- ============================================================================
--
-- Draait ECHT tegen de database; geen mocks. Alles staat in één DO-blok dat aan
-- het eind een exceptie werpt met het testrapport als boodschap, zodat ALLE
-- testdata gegarandeerd wordt teruggerold.
--
-- Uitvoeren:
--   psql "$DATABASE_URL" -f supabase/tests/allocation_integration.sql
-- of plakken in de SQL-editor / via de MCP-connector.
--
-- Verwachte uitkomst: "38 geslaagd, 0 gefaald".
--
-- Let op de SET CONSTRAINTS ALL IMMEDIATE in T25, T26, T30, T31 en T32: de
-- som-invariant en de journaalcontroles zijn DEFERRABLE INITIALLY DEFERRED en
-- vuren dus normaal pas bij COMMIT. Een test die altijd terugrolt zou ze nooit
-- uitvoeren. Precies dat verborg een blocker in fn_charge_alloc_total_check tot
-- deze regel werd toegevoegd; laat hem staan.
-- ============================================================================

DO $test$
DECLARE
  v_u   uuid := gen_random_uuid();
  v_u2  uuid := gen_random_uuid();
  v_org uuid; v_org2 uuid; v_o uuid;
  v_b uuid; v_b2 uuid; v_b3 uuid;
  v_fy uuid; v_fy2 uuid; v_fy3 uuid;
  v_cc uuid; v_cc2 uuid; v_rule uuid; v_blk_a uuid; v_blk_b uuid;
  u1 uuid; u2 uuid; u3 uuid; ux uuid; a1 uuid;
  n int; n2 int; s numeric; v_sub numeric; v_lines int; i int;
  ok boolean; msg text;
  cents_a bigint[]; cents_b bigint[]; before_cents bigint[]; after_cents bigint[];
  rep text := ''; pass int := 0; fail int := 0;

  PROCEDURE_MARK text;   -- placeholder om het blok leesbaar op te delen
BEGIN
  INSERT INTO auth.users(id) VALUES (v_u), (v_u2);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_u::text, 'role', 'authenticated')::text, true);
  v_org := public.create_organization('ALLOC TEST org A');
  INSERT INTO public.owners(organization_id, full_name)
  VALUES (v_org, 'ALLOC TEST eigenaar') RETURNING id INTO v_o;

  -- =========================================================================
  -- METHODEN
  -- =========================================================================

  -- T01  equal: 3 lots, 100,00 MAD
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T01',3) RETURNING id INTO v_b;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'a','appartement',1) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'b','appartement',1) RETURNING id INTO u2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'c','appartement',1) RETURNING id INTO u3;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date)
  VALUES (u1,v_o,1,'2026-01-01'),(u2,v_o,1,'2026-01-01'),(u3,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy;
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,status)
  VALUES (v_org,v_b,'egal','Parts egales','equal','whole_building','none','active') RETURNING id INTO v_rule;
  v_cc := public.create_charge_call(v_fy,'regulier',100.00,'2026-03-01',NULL,NULL,NULL,NULL,v_rule);
  SELECT count(*), sum(amount) INTO n, s FROM public.charge_allocations WHERE charge_call_id=v_cc;
  ok := (n=3 AND s=100.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T01  equal, 3 lots, 100,00 -> ' || n || ' rijen, som ' || s::text;

  -- T02  tantieme 16 / 24 / 60 op 1000,00
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T02',100) RETURNING id INTO v_b;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'a','appartement',16) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'b','appartement',24) RETURNING id INTO u2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'c','appartement',60) RETURNING id INTO u3;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date)
  VALUES (u1,v_o,1,'2026-01-01'),(u2,v_o,1,'2026-01-01'),(u3,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy;
  v_cc := public.create_charge_call(v_fy,'regulier',1000.00,'2026-03-01');
  SELECT sum(amount), array_agg(amount_cents ORDER BY weight_micro) INTO s, cents_a
    FROM public.charge_allocations WHERE charge_call_id=v_cc;
  ok := (s=1000.00 AND cents_a = ARRAY[16000,24000,60000]::bigint[]);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T02  tantieme 16/24/60 -> som ' || s::text || ', centen ' || cents_a::text;

  -- T03  dezelfde verhouding op een andere schaal moet identiek uitkomen
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T03',1000) RETURNING id INTO v_b;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'a','appartement',160) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'b','appartement',240) RETURNING id INTO u2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'c','appartement',600) RETURNING id INTO u3;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date)
  VALUES (u1,v_o,1,'2026-01-01'),(u2,v_o,1,'2026-01-01'),(u3,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy;
  v_cc := public.create_charge_call(v_fy,'regulier',1000.00,'2026-03-01');
  SELECT array_agg(amount_cents ORDER BY weight_micro) INTO cents_b
    FROM public.charge_allocations WHERE charge_call_id=v_cc;
  ok := (cents_a = cents_b);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T03  schaal irrelevant: 160/240/600 geeft ' || cents_b::text;

  -- =========================================================================
  -- SCOPES
  -- =========================================================================

  -- T04  block: alleen de lots van het gekozen blok
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T04',100) RETURNING id INTO v_b;
  INSERT INTO public.blocks(organization_id,building_id,code,name) VALUES (v_org,v_b,'A','Bloc A') RETURNING id INTO v_blk_a;
  INSERT INTO public.blocks(organization_id,building_id,code,name) VALUES (v_org,v_b,'B','Bloc B') RETURNING id INTO v_blk_b;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes,block_id) VALUES (v_b,'A1','appartement',30,v_blk_a) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes,block_id) VALUES (v_b,'A2','appartement',20,v_blk_a) RETURNING id INTO u2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes,block_id) VALUES (v_b,'B1','appartement',50,v_blk_b) RETURNING id INTO u3;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date)
  VALUES (u1,v_o,1,'2026-01-01'),(u2,v_o,1,'2026-01-01'),(u3,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy;
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,scope_block_id,status)
  VALUES (v_org,v_b,'bloc-a','Charges Bloc A','tantieme','block','unit_tantiemes',v_blk_a,'active') RETURNING id INTO v_rule;
  v_cc := public.create_charge_call(v_fy,'regulier',500.00,'2026-03-01',NULL,NULL,NULL,NULL,v_rule);
  SELECT count(*), sum(amount) INTO n, s FROM public.charge_allocations WHERE charge_call_id=v_cc;
  SELECT count(*) INTO n2 FROM public.charge_allocations WHERE charge_call_id=v_cc AND unit_id=u3;
  ok := (n=2 AND s=500.00 AND n2=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T04  scope=Bloc A -> ' || n || ' rijen (som ' || s::text || '), Bloc B krijgt geen rij';

  -- T05  selected_units: alleen de gekozen lots
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,status,uncovered_unit_policy)
  VALUES (v_org,v_b,'sel','Selectie','tantieme','selected_units','unit_tantiemes','active','scope_default') RETURNING id INTO v_rule;
  INSERT INTO public.allocation_rule_units(organization_id,building_id,rule_id,rule_scope,unit_id)
  VALUES (v_org,v_b,v_rule,'selected_units',u1);
  v_cc := public.create_charge_call(v_fy,'exceptionnel',300.00,'2026-04-01',NULL,NULL,NULL,NULL,v_rule);
  SELECT count(*), sum(amount) INTO n, s FROM public.charge_allocations WHERE charge_call_id=v_cc;
  ok := (n=1 AND s=300.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T05  selected_units -> ' || n || ' rij, som ' || s::text;

  -- =========================================================================
  -- PERCENTAGE EN MANUAL
  -- =========================================================================

  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T06',100) RETURNING id INTO v_b;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'a','appartement',30) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'b','appartement',20) RETURNING id INTO u2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'c','appartement',50) RETURNING id INTO u3;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date)
  VALUES (u1,v_o,1,'2026-01-01'),(u2,v_o,1,'2026-01-01'),(u3,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy;

  -- T06  percentage 30/20/50 = 100 procent
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,control_total,status)
  VALUES (v_org,v_b,'pct100','Pct 100','percentage','whole_building','rule_weights',100,'active') RETURNING id INTO v_rule;
  INSERT INTO public.allocation_rule_weights(organization_id,building_id,rule_id,rule_weight_source,unit_id,weight)
  VALUES (v_org,v_b,v_rule,'rule_weights',u1,30),(v_org,v_b,v_rule,'rule_weights',u2,20),(v_org,v_b,v_rule,'rule_weights',u3,50);
  BEGIN
    v_cc := public.create_charge_call(v_fy,'regulier',1000.00,'2026-03-01',NULL,'P1',NULL,NULL,v_rule);
    SELECT count(*), sum(amount) INTO n, s FROM public.charge_allocations WHERE charge_call_id=v_cc;
    ok := (n=3 AND s=1000.00);
  EXCEPTION WHEN others THEN ok := false; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T06  percentage 30/20/50 = 100 procent -> ' || coalesce(n,0) || ' rijen, som ' || coalesce(s,0)::text;

  -- T07  percentage 99 procent
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,control_total,status)
  VALUES (v_org,v_b,'pct99','Pct 99','percentage','whole_building','rule_weights',100,'active') RETURNING id INTO v_rule;
  INSERT INTO public.allocation_rule_weights(organization_id,building_id,rule_id,rule_weight_source,unit_id,weight)
  VALUES (v_org,v_b,v_rule,'rule_weights',u1,30),(v_org,v_b,v_rule,'rule_weights',u2,20),(v_org,v_b,v_rule,'rule_weights',u3,49);
  BEGIN
    PERFORM public.create_charge_call(v_fy,'regulier',1000.00,'2026-03-02',NULL,'P2',NULL,NULL,v_rule); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_PCT_SUM%'); END;
  -- Sterker dan de RPC-controle: zo'n regel kan niet eens worden vastgelegd.
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE; ok := false;
  EXCEPTION WHEN others THEN ok := ok AND (SQLERRM LIKE 'ALLOC_PCT_SUM%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T07  percentage 99 procent geweigerd door de RPC en door de commit-controle';
  -- Opruimen: een actieve percentageregel die niet op 100 uitkomt hoort niet te
  -- bestaan, dus hij mag ook in deze test niet blijven staan.
  DELETE FROM public.allocation_rules WHERE id = v_rule;

  -- T08  percentage 101 procent
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,control_total,status)
  VALUES (v_org,v_b,'pct101','Pct 101','percentage','whole_building','rule_weights',100,'active') RETURNING id INTO v_rule;
  INSERT INTO public.allocation_rule_weights(organization_id,building_id,rule_id,rule_weight_source,unit_id,weight)
  VALUES (v_org,v_b,v_rule,'rule_weights',u1,31),(v_org,v_b,v_rule,'rule_weights',u2,20),(v_org,v_b,v_rule,'rule_weights',u3,50);
  BEGIN
    PERFORM public.create_charge_call(v_fy,'regulier',1000.00,'2026-03-03',NULL,'P3',NULL,NULL,v_rule); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_PCT_SUM%'); END;
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE; ok := false;
  EXCEPTION WHEN others THEN ok := ok AND (SQLERRM LIKE 'ALLOC_PCT_SUM%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T08  percentage 101 procent geweigerd door de RPC en door de commit-controle';
  DELETE FROM public.allocation_rules WHERE id = v_rule;

  -- T09  manual met som = totaal, inclusief een lot van 0,00
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,status)
  VALUES (v_org,v_b,'man','Handmatig','manual','whole_building','charge_call_lines','active') RETURNING id INTO v_rule;
  BEGIN
    v_cc := public.create_charge_call(v_fy,'regulier',1000.00,'2026-05-01',NULL,'M1',NULL,NULL,v_rule,
      jsonb_build_array(
        jsonb_build_object('unit_id',u1,'amount_cents',60000),
        jsonb_build_object('unit_id',u2,'amount_cents',40000),
        jsonb_build_object('unit_id',u3,'amount_cents',0)));
    SELECT count(*), sum(amount) INTO n, s FROM public.charge_allocations WHERE charge_call_id=v_cc;
    SELECT count(*) INTO v_lines FROM public.charge_call_lines WHERE charge_call_id=v_cc;
    ok := (n=3 AND s=1000.00 AND v_lines=3);
  EXCEPTION WHEN others THEN ok := false; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T09  manual som=totaal incl. lot van 0,00 -> ' || coalesce(n,0) || ' rijen, brondocument '
             || coalesce(v_lines,0) || ' regels';

  -- T10  manual met som <> totaal
  BEGIN
    PERFORM public.create_charge_call(v_fy,'regulier',1000.00,'2026-05-02',NULL,'M2',NULL,NULL,v_rule,
      jsonb_build_array(
        jsonb_build_object('unit_id',u1,'amount_cents',60000),
        jsonb_build_object('unit_id',u2,'amount_cents',39999),
        jsonb_build_object('unit_id',u3,'amount_cents',0)));
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_MANUAL_SUM%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T10  manual som<>totaal geweigerd';

  -- =========================================================================
  -- FAALGEVALLEN
  -- =========================================================================

  -- T11  lege scope
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,status)
  VALUES (v_org,v_b,'leeg','Leeg','tantieme','selected_units','unit_tantiemes','active') RETURNING id INTO v_rule;
  BEGIN
    PERFORM public.create_charge_call(v_fy,'regulier',100.00,'2026-06-01',NULL,'E1',NULL,NULL,v_rule); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_NO_PARTICIPANTS%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T11  lege scope geweigerd';

  -- T12  nulgewicht
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T12',10) RETURNING id INTO v_b2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b2,'z','appartement',0) RETURNING id INTO ux;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (ux,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b2,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy2;
  BEGIN
    PERFORM public.create_charge_call(v_fy2,'regulier',100.00,'2026-06-01'); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_WEIGHT_MISSING%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T12  nulgewicht geweigerd (geen stille uitsluiting)';

  -- T13  cross-tenant lot in een selectie
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_u2::text, 'role','authenticated')::text, true);
  v_org2 := public.create_organization('ALLOC TEST org B');
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org2,'T13B',100) RETURNING id INTO v_b2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b2,'vreemd','appartement',100) RETURNING id INTO ux;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_u::text, 'role','authenticated')::text, true);
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,status)
  VALUES (v_org,v_b,'xt','Cross','tantieme','selected_units','unit_tantiemes','active') RETURNING id INTO v_rule;
  BEGIN
    INSERT INTO public.allocation_rule_units(organization_id,building_id,rule_id,rule_scope,unit_id)
    VALUES (v_org,v_b,v_rule,'selected_units',ux);
    ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T13  lot uit een andere organisatie geweigerd door de samengestelde FK';

  -- T14  historische onveranderlijkheid
  SELECT array_agg(amount_cents ORDER BY unit_id) INTO before_cents
    FROM public.charge_allocations WHERE charge_call_id=v_cc;
  UPDATE public.units SET tantiemes = 999 WHERE building_id = v_b;
  UPDATE public.allocation_rules SET label = 'GEWIJZIGD' WHERE building_id = v_b AND code='man';
  SELECT array_agg(amount_cents ORDER BY unit_id) INTO after_cents
    FROM public.charge_allocations WHERE charge_call_id=v_cc;
  ok := (before_cents = after_cents AND before_cents IS NOT NULL);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T14  tantiemes en regel gewijzigd na vastlegging -> allocaties identiek';

  -- =========================================================================
  -- DE PRODUCTIEBUG
  -- =========================================================================

  -- T15  som gewichten (16) wijkt af van de controlewaarde (1000): hard falen
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T15',1000) RETURNING id INTO v_b3;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b3,'p','appartement',16) RETURNING id INTO u1;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u1,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b3,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy3;
  BEGIN
    PERFORM public.create_charge_call(v_fy3,'regulier',1000.00,'2026-03-01'); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_CONTROL_TOTAL%'); END;
  SELECT count(*) INTO n FROM public.charge_calls WHERE building_id=v_b3;
  ok := ok AND (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T15  16 op controlewaarde 1000 faalt hard, niets achtergebleven';

  -- T16  met onderbouwde derogatie krijgt dat ene lot 100 procent
  UPDATE public.allocation_rules
     SET partial_denominator_reason = 'Copropriete in oplevering',
         partial_denominator_by = v_u, partial_denominator_at = now(),
         partial_denominator_until_year = 2026
   WHERE building_id = v_b3 AND is_default;
  BEGIN
    v_cc := public.create_charge_call(v_fy3,'regulier',1000.00,'2026-03-01');
    SELECT count(*), sum(amount) INTO n, s FROM public.charge_allocations WHERE charge_call_id=v_cc;
    SELECT alloc_partial_denominator INTO ok FROM public.charge_calls WHERE id=v_cc;
    ok := ok AND n=1 AND s=1000.00;
  EXCEPTION WHEN others THEN ok := false; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T16  met derogatie: 100 procent naar dat lot, gemarkeerd als afwijkend';

  -- =========================================================================
  -- INTEGRITEIT
  -- =========================================================================

  -- T17  de snapshotkop is niet client-schrijfbaar
  BEGIN
    PERFORM set_config('role','authenticated',true);
    INSERT INTO public.charge_calls(organization_id,fiscal_year_id,building_id,type,total_amount,call_date,
      allocation_rule_id,alloc_method,alloc_scope,alloc_weight_source,alloc_rule_code,alloc_rule_label,
      alloc_rule_revision,alloc_total_cents,alloc_denominator,alloc_unit_count,alloc_remainder_cents,
      alloc_tie_breaker,alloc_algo_version)
    SELECT v_org,v_fy3,v_b3,'regulier',1.00,'2026-03-01',r.id,'equal','whole_building','none','x','x',1,100,
      1000000,1,0,'remainder_desc_unit_id_asc',1
      FROM public.allocation_rules r WHERE r.building_id=v_b3 LIMIT 1;
    PERFORM set_config('role','postgres',true); ok := false;
  EXCEPTION WHEN others THEN PERFORM set_config('role','postgres',true); ok := true; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T17  directe INSERT op charge_calls geblokkeerd';

  -- T18  de rekenkern is declaratief vastgelegd
  SELECT id INTO a1 FROM public.charge_allocations WHERE charge_call_id=v_cc LIMIT 1;
  BEGIN
    UPDATE public.charge_allocations SET base_cents = base_cents - 1 WHERE id=a1; ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T18  wijzigen van base_cents geweigerd';

  -- T19  NaN
  BEGIN
    PERFORM public.create_charge_call(v_fy3,'exceptionnel','NaN'::numeric,'2026-03-05'); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_AMOUNT_INVALID%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T19  NaN als bedrag geweigerd';

  -- T20  dubbele oproep voor dezelfde periode
  BEGIN
    PERFORM public.create_charge_call(v_fy3,'exceptionnel',10.00,'2026-04-01',NULL,'Q9');
    PERFORM public.create_charge_call(v_fy3,'exceptionnel',10.00,'2026-04-01',NULL,'Q9');
    ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T20  tweede oproep met dezelfde periode geweigerd';

  -- T21  TRUNCATE
  BEGIN
    TRUNCATE public.charge_allocations; ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T21  TRUNCATE geblokkeerd';

  -- T22  nulcent-rijen worden geschreven: 0,10 MAD over 48 lots
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T22',48) RETURNING id INTO v_b3;
  FOR i IN 1..48 LOOP
    INSERT INTO public.units(building_id,label,unit_type,tantiemes)
    VALUES (v_b3,'k'||i,'appartement',1) RETURNING id INTO u2;
    INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (u2,v_o,1,'2026-01-01');
  END LOOP;
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b3,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy3;
  v_cc2 := public.create_charge_call(v_fy3,'regulier',0.10,'2026-03-01');
  SELECT count(*), sum(amount) INTO n, s FROM public.charge_allocations WHERE charge_call_id=v_cc2;
  ok := (n=48 AND s=0.10);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T22  0,10 MAD over 48 lots -> ' || n || ' rijen, som ' || s::text;

  -- T23  grootboek 4111 sluit aan op de subadministratie
  SELECT sum(jl.debit) INTO s FROM public.journal_lines jl
    JOIN public.journal_entries je ON je.id=jl.journal_entry_id
    JOIN public.accounts a ON a.id=jl.account_id
   WHERE je.source_id=v_cc2 AND a.code='4111';
  SELECT sum(amount) INTO v_sub FROM public.charge_allocations WHERE charge_call_id=v_cc2;
  ok := (s = v_sub);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T23  4111 (' || coalesce(s,0)::text || ') = som allocaties (' || coalesce(v_sub,0)::text || ')';

  -- T24  nieuw gebouw krijgt automatisch een standaardregel
  SELECT count(*) INTO n FROM public.allocation_rules
   WHERE building_id=v_b3 AND is_default AND status='active';
  ok := (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T24  nieuw gebouw krijgt automatisch een standaard-verdeelregel';

  -- =========================================================================
  -- COMMIT-CONTROLES (deferred; zonder SET CONSTRAINTS onzichtbaar)
  -- =========================================================================

  -- T25  een geldige oproep overleeft de commit-controle
  -- LET OP: SET CONSTRAINTS ALL IMMEDIATE blijft gelden voor de REST van de
  -- transactie. Slaagt hij, dan moet de modus expliciet terug naar DEFERRED —
  -- anders vuurt kant A bij een volgende lastenoproep al direct ná de
  -- charge_calls-INSERT, dus voordat de allocaties bestaan, en faalt elke
  -- verdere oproep met ALLOC_SUM_MISMATCH. Bij een mislukte poging rolt de
  -- subtransactie de modus vanzelf terug.
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,80); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T25  geldige oproepen overleven de commit-controle (kant A)  ' || coalesce('['||msg||']','');

  -- T26  een verwijderde allocatieregel wordt bij commit gevangen
  SELECT id INTO a1 FROM public.charge_allocations WHERE charge_call_id=v_cc2 LIMIT 1;
  BEGIN
    DELETE FROM public.charge_allocations WHERE id=a1;
    SET CONSTRAINTS ALL IMMEDIATE;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T26  verwijderde allocatieregel geweigerd bij commit (kant B)';

  -- =========================================================================
  -- CASCADES EN CORRECTIEROUTE
  -- =========================================================================

  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org,'T27',100) RETURNING id INTO v_b;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'a','appartement',60) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'b','appartement',40) RETURNING id INTO u2;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date)
  VALUES (u1,v_o,1,'2026-01-01'),(u2,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org,v_b,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy;
  v_cc := public.create_charge_call(v_fy,'regulier',1000.00,'2026-03-01',NULL,'Q1');
  INSERT INTO public.allocation_rules(organization_id,building_id,code,label,method,scope,weight_source,control_total,status)
  VALUES (v_org,v_b,'pct','Pct','percentage','whole_building','rule_weights',100,'active') RETURNING id INTO v_rule;
  INSERT INTO public.allocation_rule_weights(organization_id,building_id,rule_id,rule_weight_source,unit_id,weight)
  VALUES (v_org,v_b,v_rule,'rule_weights',u1,60),(v_org,v_b,v_rule,'rule_weights',u2,40);
  INSERT INTO public.payments(organization_id,building_id,owner_id,amount,method,value_date)
  VALUES (v_org,v_b,v_o,500.00,'virement','2026-04-01');

  -- T27  losse unit met historie
  BEGIN DELETE FROM public.units WHERE id=u1; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_UNIT_HAS_HISTORY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T27  losse unit met historie niet verwijderbaar';

  -- T28  losse eigenaar met historie
  BEGIN DELETE FROM public.owners WHERE id=v_o; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_OWNER_HAS%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T28  losse eigenaar met historie niet verwijderbaar';

  -- T29  oproep met betalingskoppeling
  BEGIN DELETE FROM public.charge_calls WHERE id=v_cc; ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_CALL_PAID%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '  T29  oproep met betaling niet intrekbaar';

  -- T30  oproep zonder betaling: intrekbaar, journaalpost mee opgeruimd
  v_cc2 := public.create_charge_call(v_fy,'exceptionnel',200.00,'2026-05-01',NULL,'Q2');
  BEGIN
    DELETE FROM public.charge_calls WHERE id=v_cc2;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    SELECT count(*) INTO n FROM public.journal_entries WHERE source='charge' AND source_id=v_cc2;
    ok := (n=0);
  EXCEPTION WHEN others THEN ok := false; END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T30  oproep zonder betaling intrekbaar, journaalpost opgeruimd';

  -- T31  het HELE gebouw verwijderen moet blijven werken
  BEGIN
    DELETE FROM public.buildings WHERE id=v_b;
    SET CONSTRAINTS ALL IMMEDIATE;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,80); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T31  DELETE van gebouw met betaalde historie en actieve percentageregel  '
             || coalesce('['||msg||']','');

  -- T32  de hele organisatie verwijderen
  BEGIN
    DELETE FROM public.organizations WHERE id=v_org;
    SET CONSTRAINTS ALL IMMEDIATE;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,80); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T32  DELETE van de hele organisatie  ' || coalesce('['||msg||']','');

  -- =========================================================================
  -- CONSTRAINT-MODE (m20)
  -- =========================================================================
  -- `SET CONSTRAINTS ALL IMMEDIATE` geldt voor de rest van de transactie. Zet
  -- een caller die modus, dan zouden de uitgestelde controles al tijdens de
  -- opbouw van de oproep vuren in plaats van bij commit. De RPC dwingt daarom
  -- zelf af dat precies zijn eigen vier controles uitgesteld zijn.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_u::text, 'role','authenticated')::text, true);
  v_org2 := public.create_organization('ALLOC TEST constraint-mode');
  INSERT INTO public.owners(organization_id,full_name) VALUES (v_org2,'CM Eig') RETURNING id INTO v_o;
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org2,'T33',100) RETURNING id INTO v_b;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'a','appartement',60) RETURNING id INTO u1;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b,'b','appartement',40) RETURNING id INTO u2;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date)
  VALUES (u1,v_o,1,'2026-01-01'),(u2,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org2,v_b,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy;

  -- T33  de RPC slaagt ook wanneer de caller alles op IMMEDIATE heeft gezet
  SET CONSTRAINTS ALL IMMEDIATE;
  BEGIN
    v_cc := public.create_charge_call(v_fy,'regulier',1000.00,'2026-03-01',NULL,'CM1');
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T33  RPC slaagt onder SET CONSTRAINTS ALL IMMEDIATE  ' || coalesce('['||msg||']','');

  -- T34  allocaties tellen exact op tot het oproeptotaal
  SELECT count(*), sum(amount) INTO n, s FROM public.charge_allocations WHERE charge_call_id=v_cc;
  ok := (n=2 AND s=1000.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T34  ' || coalesce(n,0) || ' allocaties, som ' || coalesce(s,0)::text || ' = 1000.00';

  -- T35  de journaalpost sluit
  SELECT coalesce(sum(jl.debit),0), coalesce(sum(jl.credit),0) INTO v_sub, s
    FROM public.journal_lines jl JOIN public.journal_entries je ON je.id=jl.journal_entry_id
   WHERE je.source_id=v_cc;
  ok := (v_sub = s AND v_sub = 1000.00);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T35  journaal debet ' || coalesce(v_sub,0)::text || ' = credit ' || coalesce(s,0)::text;

  -- T36  de controles zijn niet verzwakt: een verwijderde allocatie faalt nog steeds
  SELECT id INTO a1 FROM public.charge_allocations WHERE charge_call_id=v_cc LIMIT 1;
  BEGIN
    DELETE FROM public.charge_allocations WHERE id=a1;
    SET CONSTRAINTS ALL IMMEDIATE;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T36  verwijderde allocatie faalt nog steeds hard onder IMMEDIATE';

  -- T37  ongeldige invoer faalt hard onder IMMEDIATE en laat niets achter
  INSERT INTO public.buildings(organization_id,name,total_tantiemes) VALUES (v_org2,'T37',1000) RETURNING id INTO v_b2;
  INSERT INTO public.units(building_id,label,unit_type,tantiemes) VALUES (v_b2,'p','appartement',16) RETURNING id INTO ux;
  INSERT INTO public.ownership(unit_id,owner_id,share,start_date) VALUES (ux,v_o,1,'2026-01-01');
  INSERT INTO public.fiscal_years(organization_id,building_id,year,start_date,end_date,status)
  VALUES (v_org2,v_b2,2026,'2026-01-01','2026-12-31','open') RETURNING id INTO v_fy2;
  SET CONSTRAINTS ALL IMMEDIATE;
  BEGIN
    PERFORM public.create_charge_call(v_fy2,'regulier',1000.00,'2026-03-01'); ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'ALLOC_CONTROL_TOTAL%'); END;
  SELECT count(*) INTO n FROM public.charge_calls WHERE building_id=v_b2;
  ok := ok AND (n=0);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T37  ongeldige verdeling faalt hard onder IMMEDIATE, niets achtergebleven';

  -- T38  de RPC raakt bewust NIET de constraint van allocation_rule_weights aan
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conname='trig_zz_rule_complete_w' AND condeferrable AND condeferred;
  ok := (n=1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
             || '  T38  trig_zz_rule_complete_w ongemoeid (geen blinde SET CONSTRAINTS ALL)';

  BEGIN SET CONSTRAINTS ALL DEFERRED; EXCEPTION WHEN others THEN NULL; END;

  RAISE EXCEPTION E'ALLOCATION ENGINE — % geslaagd, % gefaald%', pass, fail, rep;
END $test$;

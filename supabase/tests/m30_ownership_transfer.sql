-- ============================================================================
-- Agio Syndic — m30 gecontroleerde eigendomsmutaties, database-integratie
-- ============================================================================
--
-- Draait ECHT tegen de database; geen mocks. Alles staat in een DO-blok dat aan
-- het eind een exceptie werpt met het testrapport als boodschap, zodat ALLE
-- testdata gegarandeerd wordt teruggerold.
--
-- Uitvoeren (bouwt zelf een verse PostgreSQL 17 in Docker en draait ook de
-- preflightscenario's):
--   pnpm test:db:m30
--
-- Handmatig tegen een reeds opgebouwde lokale database:
--   psql "$LOKALE_DATABASE_URL" -f supabase/tests/m30_ownership_transfer.sql
--
-- NOOIT tegen productie. Alleen tegen een lokale database of een expliciet
-- toegestane niet-productieomgeving.
--
-- Verwachte uitkomst: "55 geslaagd, 0 gefaald".
--
-- Wat hier wordt vastgelegd (55 asserties):
--   L1-L6      eerste koppeling, inclusief tenantisolatie en bestaansorakel;
--   T1-T16     overdracht: datumgrenzen, share/primary, stale writes, rollback;
--   F1-F3      allocaties, betalingen en journaal blijven byte-identiek. Er
--              worden EERST echte rijen aangemaakt; elke assertie eist een
--              niet-lege nulmeting, een gelijke rijtelling en een gelijke hash,
--              zodat md5('') = md5('') nooit als bewijs kan passeren;
--   D1-D6      directe DML via de Data API is dicht, ook voor service_role;
--   I1-I6      historie-immutability onder privileged writes;
--   X1-X3, X2b exclusion constraints, met BEHOUD van geldige mede-eigendom.
--              X1 en X3 controleren behalve SQLSTATE 23P01 ook de NAAM van de
--              constraint, zodat een weigering door de oudere UNIQUE-constraint
--              niet als succes telt;
--   C1-C9      cascadegedrag: losse owner-, unit- en building-deletes kunnen de
--              eigendomsketen niet meer wissen, terwijl een VOLLEDIGE
--              organisatieverwijdering de bestaande cascade behoudt. C6 en C9
--              bouwen daarvoor een EIGEN organisatie op en zijn niet afhankelijk
--              van wat eerdere asserties achterlaten;
--   G1-G4      grants, policies, triggerstatus en constraints.
--
-- Wat hier BEWUST NIET wordt vastgelegd: dat de m30-preflight bestaande
-- ongeldige eigendomsdata tegenhoudt. Die vraag kan niet binnen deze suite
-- worden beantwoord, want de migratie is dan al toegepast. Zie de vier
-- scenario's in `scripts/test-m30-local.mjs` plus
-- `supabase/tests/fixtures/preflight_cases.sql`, die de ECHTE migratie tegen
-- ongeldige datasets draaien.
--
-- LET OP: dit bestand mag NERGENS een kale DELETE op public.ownership doen om
-- op te ruimen. De historieguard uit m30 weigert die zolang de organisatie
-- bestaat, en buiten een BEGIN/EXCEPTION-blok breekt dat het hele DO-blok af.
-- Waar een schone uitgangssituatie nodig is, wordt een VERS lot gebruikt.
--
-- LET OP: een gefaalde plpgsql-subtransactie (elk BEGIN/EXCEPTION blok) rolt OOK
-- set_config(..., is_local := true) terug. De JWT-context wordt daarom vlak voor
-- elke rolgevoelige aanroep opnieuw gezet.
-- ============================================================================

DO $test$
DECLARE
  vu_owner  uuid := gen_random_uuid();   -- owner in organisatie A
  vu_reader uuid := gen_random_uuid();   -- reader in organisatie A
  vu_b      uuid := gen_random_uuid();   -- owner in organisatie B
  PU text; PR text; PB text;

  vorgA uuid; vorgB uuid;
  vbA uuid; vbA2 uuid; vbB uuid;
  u1 uuid; u2 uuid; u3 uuid; u4 uuid; u5 uuid; u6 uuid; u7 uuid; ub uuid;
  oA1 uuid; oA2 uuid; oA3 uuid; oA4 uuid; oB uuid;
  ow1 uuid; ow2 uuid; ow_tmp uuid;

  -- Eigen fixtures voor C6 en C9, zodat die twee niet meeliften op de toestand
  -- die eerdere asserties achterlaten.
  vorgC uuid; oC6 uuid;
  vorgD uuid; vbD uuid; uD uuid; oD uuid; owD uuid;

  vandaag date := CURRENT_DATE;
  d_over  date;                          -- overdrachtsdatum
  v_rec   record;
  md5_ca_voor text; md5_ca_na text;
  md5_pay_voor text; md5_pay_na text;
  md5_je_voor text; md5_je_na text;
  md5_row_voor text; md5_row_na text;

  -- Rijtellingen naast de hashes: een lege verzameling hasht naar md5('') en
  -- zou anders "onveranderd" opleveren zonder iets te meten.
  n_ca_voor int; n_ca_na int;
  n_pay_voor int; n_pay_na int;
  n_je_voor int; n_je_na int;
  md5_leeg text := md5('');

  -- Voor X1/X3: bewijzen WELKE constraint de overlap weigert, niet alleen dat
  -- er iets weigerde.
  v_constraint text;

  ok boolean; n int; msg text;
  pass int := 0; fail int := 0; rep text := '';

BEGIN
  PU := json_build_object('sub', vu_owner::text,  'role', 'authenticated')::text;
  PR := json_build_object('sub', vu_reader::text, 'role', 'authenticated')::text;
  PB := json_build_object('sub', vu_b::text,      'role', 'authenticated')::text;

  -- ══════════════════════════════════════════════════════════ FIXTURE ══════
  INSERT INTO auth.users(id) VALUES (vu_owner), (vu_reader), (vu_b);

  PERFORM set_config('request.jwt.claims', PU, true);
  vorgA := public.create_organization('M30 ORG A');
  PERFORM set_config('request.jwt.claims', PB, true);
  vorgB := public.create_organization('M30 ORG B');
  PERFORM set_config('request.jwt.claims', PU, true);

  INSERT INTO public.memberships(organization_id, user_id, role)
  VALUES (vorgA, vu_reader, 'reader');

  INSERT INTO public.buildings(organization_id, name, total_tantiemes)
  VALUES (vorgA, 'M30 A', 1000) RETURNING id INTO vbA;
  INSERT INTO public.buildings(organization_id, name, total_tantiemes)
  VALUES (vorgA, 'M30 A2', 1000) RETURNING id INTO vbA2;
  INSERT INTO public.buildings(organization_id, name, total_tantiemes)
  VALUES (vorgB, 'M30 B', 1000) RETURNING id INTO vbB;

  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
  VALUES (vbA,'A1','appartement',100) RETURNING id INTO u1;
  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
  VALUES (vbA,'A2','appartement',100) RETURNING id INTO u2;
  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
  VALUES (vbA,'A3','appartement',100) RETURNING id INTO u3;
  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
  VALUES (vbA,'A4','appartement',100) RETURNING id INTO u4;
  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
  VALUES (vbA2,'B1','appartement',100) RETURNING id INTO u5;
  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
  VALUES (vbA2,'B2','appartement',100) RETURNING id INTO u6;
  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
  VALUES (vbA2,'B3','appartement',100) RETURNING id INTO u7;
  INSERT INTO public.units(building_id, label, unit_type, tantiemes)
  VALUES (vbB,'X1','appartement',100) RETURNING id INTO ub;

  INSERT INTO public.owners(organization_id, full_name) VALUES (vorgA,'M30 Eigenaar 1') RETURNING id INTO oA1;
  INSERT INTO public.owners(organization_id, full_name) VALUES (vorgA,'M30 Eigenaar 2') RETURNING id INTO oA2;
  INSERT INTO public.owners(organization_id, full_name) VALUES (vorgA,'M30 Eigenaar 3') RETURNING id INTO oA3;
  INSERT INTO public.owners(organization_id, full_name) VALUES (vorgA,'M30 Eigenaar 4') RETURNING id INTO oA4;
  INSERT INTO public.owners(organization_id, full_name) VALUES (vorgB,'M30 Eigenaar B') RETURNING id INTO oB;

  -- ═══════════════════════════════════════════ L — EERSTE KOPPELING ═══════

  -- L1  eerste koppeling op een lot zonder enige historie
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    ow1 := public.link_first_owner(u1, oA1, vandaag - 100);
    SELECT count(*) INTO n FROM public.ownership
     WHERE id = ow1 AND unit_id = u1 AND owner_id = oA1
       AND share = 1 AND is_primary_debtor AND end_date IS NULL
       AND start_date = vandaag - 100;
    ok := (n = 1);
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  L1  eerste koppeling: volledige primaire rij' || coalesce(' — '||msg,''); msg := NULL;

  -- L2  tweede koppeling op hetzelfde lot is geen "eerste"
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.link_first_owner(u1, oA2, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_HISTORY_EXISTS%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  L2  koppeling met bestaande historie geweigerd';

  -- L3  cross-tenant eigenaar
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.link_first_owner(u2, oB, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_OWNER_INVALID%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  L3  eigenaar uit andere organisatie geweigerd';

  -- L4  reader mag niet schrijven
  BEGIN
    PERFORM set_config('request.jwt.claims', PR, true);
    PERFORM public.link_first_owner(u2, oA1, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_FORBIDDEN%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  L4  reader geweigerd';

  -- L5  onbekend lot geeft dezelfde code als een lot zonder recht: geen orakel
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.link_first_owner(gen_random_uuid(), oA1, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_FORBIDDEN%'); END;
  IF ok THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', PU, true);
      PERFORM public.link_first_owner(ub, oA1, vandaag);   -- lot van organisatie B
      ok := false;
    EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_FORBIDDEN%'); END;
  END IF;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  L5  onbekend en cross-tenant lot geven dezelfde code (geen bestaansorakel)';

  -- L6  toekomstige ingangsdatum
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.link_first_owner(u2, oA1, vandaag + 1);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_DATE_FUTURE%'); END;
  IF ok THEN
    SELECT count(*) INTO n FROM public.ownership WHERE unit_id = u2;
    ok := (n = 0);
  END IF;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  L6  toekomstige eerste koppeling geweigerd, geen rij aangemaakt';

  -- ═══════════════════════════════════════════════════ T — OVERDRACHT ═════

  d_over := vandaag;

  -- ── FINANCIELE FIXTURE ───────────────────────────────────────────────────
  --
  -- Zonder rijen vergelijken F1-F3 md5('') met md5('') en kunnen ze niet falen.
  -- Daarom eerst echte, herkenbare, onderling verschillende rijen. Bewust:
  --
  --   * eigenaar oA4 en lot u5 (gebouw vbA2), NIET oA2/u1/vbA. Anders vuurt bij
  --     C1/C2/C3 eerst de financiele-historieguard uit m18/m22 en bewijzen die
  --     asserties de eigendomsguard niet meer;
  --   * bedragen en referenties zijn synthetisch en bevatten geen
  --     persoonsgegevens.
  INSERT INTO public.charge_allocations
    (organization_id, unit_id, owner_id, amount_cents, label)
  VALUES
    (vorgA, u5, oA4, 125000, 'M30 TEST allocatie A'),
    (vorgA, u5, oA4, 340050, 'M30 TEST allocatie B'),
    (vorgA, u5, oA4,   9900, 'M30 TEST allocatie C');

  INSERT INTO public.payments
    (organization_id, owner_id, amount_cents, paid_on, reference)
  VALUES
    (vorgA, oA4, 125000, vandaag - 40, 'M30-TEST-BET-0001'),
    (vorgA, oA4,  50000, vandaag - 20, 'M30-TEST-BET-0002');

  INSERT INTO public.journal_entries
    (organization_id, entry_date, description, amount_cents)
  VALUES
    (vorgA, vandaag - 40, 'M30 TEST journaalpost 1', 125000),
    (vorgA, vandaag - 20, 'M30 TEST journaalpost 2',  50000),
    (vorgA, vandaag - 10, 'M30 TEST journaalpost 3', 474950),
    (vorgA, vandaag -  5, 'M30 TEST journaalpost 4',  -9900);

  -- Financiele nulmeting VOOR de overdracht: hash EN rijtelling.
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')), count(*)
    INTO md5_ca_voor, n_ca_voor
    FROM public.charge_allocations t WHERE t.organization_id = vorgA;
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')), count(*)
    INTO md5_pay_voor, n_pay_voor
    FROM public.payments t WHERE t.organization_id = vorgA;
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')), count(*)
    INTO md5_je_voor, n_je_voor
    FROM public.journal_entries t WHERE t.organization_id = vorgA;

  -- T1  overdracht op vandaag, exacte grenzen D-1 en D
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    ow2 := public.transfer_ownership(u1, ow1, oA2, d_over);
    SELECT count(*) INTO n FROM public.ownership
     WHERE id = ow1 AND end_date = d_over - 1;
    ok := (n = 1);
    SELECT count(*) INTO n FROM public.ownership
     WHERE id = ow2 AND start_date = d_over AND end_date IS NULL
       AND owner_id = oA2 AND share = 1 AND is_primary_debtor;
    ok := ok AND (n = 1);
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T1  overdracht vandaag: oude periode t/m D-1, nieuwe vanaf D' || coalesce(' — '||msg,''); msg := NULL;

  -- T2  de verdeelmotor volgt dezelfde grenzen
  SELECT owner_id INTO v_rec FROM public.fn_alloc_resolve_owner(u1, d_over - 1);
  ok := (v_rec.owner_id = oA1);
  SELECT owner_id INTO v_rec FROM public.fn_alloc_resolve_owner(u1, d_over);
  ok := ok AND (v_rec.owner_id = oA2);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T2  resolve_owner(D-1)=oud en resolve_owner(D)=nieuw';

  -- T3  precies een actuele primaire eigenaar
  SELECT count(*) INTO n FROM public.ownership
   WHERE unit_id = u1 AND end_date IS NULL AND is_primary_debtor;
  ok := (n = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T3  exact een actuele primaire eigenaar na overdracht';

  -- T4  stale expected-ID: de oude rij mag niet nogmaals worden overgedragen
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u1, ow1, oA3, d_over);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_STALE%'); END;
  IF ok THEN
    SELECT count(*) INTO n FROM public.ownership WHERE unit_id = u1;
    ok := (n = 2);   -- nog steeds twee rijen, niets toegevoegd
  END IF;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T4  verouderd formulier geweigerd (OWNERSHIP_STALE), geen rij erbij';

  -- T5  NULL als expected-ID telt als stale, niet als "sla de controle over"
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u1, NULL, oA3, d_over);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_STALE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T5  ontbrekend expected-ID geweigerd';

  -- T6  toekomstige overdrachtsdatum
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u1, ow2, oA3, vandaag + 1);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_DATE_FUTURE%'); END;
  IF ok THEN
    SELECT count(*) INTO n FROM public.ownership WHERE unit_id = u1;
    ok := (n = 2);
  END IF;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T6  toekomstige overdracht geweigerd, niets gewijzigd';

  -- T7  overdrachtsdatum niet na de huidige startdatum
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u1, ow2, oA3, d_over);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_DATE_NOT_AFTER_START%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T7  overdracht op de startdatum zelf geweigerd';

  -- T8  dezelfde eigenaar
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u1, ow2, oA2, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := (SQLERRM LIKE 'OWNERSHIP_SAME_OWNER%' OR SQLERRM LIKE 'OWNERSHIP_DATE_NOT_AFTER_START%');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T8  overdracht naar dezelfde eigenaar geweigerd';

  -- T9  cross-tenant nieuwe eigenaar
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u1, ow2, oB, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_OWNER_INVALID%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T9  nieuwe eigenaar uit andere organisatie geweigerd';

  -- T10 reader mag niet overdragen
  BEGIN
    PERFORM set_config('request.jwt.claims', PR, true);
    PERFORM public.transfer_ownership(u1, ow2, oA3, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_FORBIDDEN%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T10 reader kan niet overdragen';

  -- T11 lot zonder actuele eigenaar (alleen gesloten historie)
  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, end_date, is_primary_debtor)
  VALUES (u3, oA1, 1, vandaag - 50, vandaag - 10, true);
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u3, gen_random_uuid(), oA2, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_NO_CURRENT%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T11 lot met alleen gesloten historie: geen overdracht';

  -- T11b eerste koppeling op datzelfde lot is ook geen "eerste"
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.link_first_owner(u3, oA2, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_HISTORY_EXISTS%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T11b gesloten historie blokkeert een nieuwe eerste koppeling';

  -- T12 huidige rij niet primair
  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, is_primary_debtor)
  VALUES (u4, oA1, 1, vandaag - 30, false) RETURNING id INTO ow_tmp;
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u4, ow_tmp, oA2, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_NOT_PRIMARY%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T12 niet-primaire eigenaar: geen overdracht';

  -- T13 mede-eigendom: twee actuele rijen
  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, is_primary_debtor)
  VALUES (u4, oA2, 1, vandaag - 30, true);
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u4, ow_tmp, oA3, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_COOWNED%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T13 mede-eigendom: overdracht geweigerd, niet geraden';

  -- T14 gedeeltelijk belang (share < 1)
  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, is_primary_debtor)
  VALUES (u5, oA1, 0.5, vandaag - 30, true) RETURNING id INTO ow_tmp;
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u5, ow_tmp, oA2, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_NOT_FULL%'); END;
  IF ok THEN
    SELECT share INTO v_rec FROM public.ownership WHERE id = ow_tmp;
    ok := (v_rec.share = 0.5);       -- niets genormaliseerd
  END IF;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T14 gedeeltelijk belang geweigerd en NIET stil genormaliseerd';

  -- T15 rollback: overlap met bestaande historie laat de oude rij ongemoeid
  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, is_primary_debtor)
  VALUES (u6, oA1, 1, vandaag - 60, true) RETURNING id INTO ow_tmp;
  -- gesloten periode van dezelfde nieuwe eigenaar die de doelperiode overlapt
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, end_date, is_primary_debtor)
  VALUES (u6, oA2, 1, vandaag - 20, vandaag, false);
  SELECT md5(t::text) INTO md5_row_voor FROM public.ownership t WHERE t.id = ow_tmp;
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u6, ow_tmp, oA2, vandaag - 5);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_OVERLAP%'); END;
  SELECT md5(t::text) INTO md5_row_na FROM public.ownership t WHERE t.id = ow_tmp;
  ok := ok AND (md5_row_voor = md5_row_na);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T15 fout na afsluitpoging: oude rij byte-identiek teruggerold';

  -- T16 overdracht met een datum in het verleden
  -- Op een VERS lot. Opruimen met een DELETE kan niet: de historieguard weigert
  -- elke ownership-delete zolang de organisatie bestaat, en die weigering zou
  -- dit hele testblok afbreken.
  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.ownership(unit_id, owner_id, share, start_date, is_primary_debtor)
  VALUES (u7, oA1, 1, vandaag - 60, true) RETURNING id INTO ow_tmp;
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.transfer_ownership(u7, ow_tmp, oA2, vandaag - 30);
    SELECT count(*) INTO n FROM public.ownership
     WHERE unit_id = u7 AND end_date = vandaag - 31;
    ok := (n = 1);
    SELECT count(*) INTO n FROM public.ownership
     WHERE unit_id = u7 AND start_date = vandaag - 30 AND end_date IS NULL;
    ok := ok AND (n = 1);
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,70); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  T16 overdracht in het verleden werkt met dezelfde grenzen' || coalesce(' — '||msg,''); msg := NULL;

  -- ══════════════════════════════════════════ F — FINANCIEEL ONGEMOEID ════
  --
  -- Elke assertie eist DRIE dingen, zodat een lege verzameling nooit als bewijs
  -- kan passeren:
  --   1. de nulmeting was niet leeg  (n_*_voor > 0 en hash <> md5(''));
  --   2. de rijtelling is onveranderd;
  --   3. de inhoudshash is onveranderd.
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')), count(*)
    INTO md5_ca_na, n_ca_na
    FROM public.charge_allocations t WHERE t.organization_id = vorgA;
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')), count(*)
    INTO md5_pay_na, n_pay_na
    FROM public.payments t WHERE t.organization_id = vorgA;
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')), count(*)
    INTO md5_je_na, n_je_na
    FROM public.journal_entries t WHERE t.organization_id = vorgA;

  ok := (n_ca_voor > 0) AND (md5_ca_voor <> md5_leeg)
    AND (n_ca_voor = n_ca_na) AND (md5_ca_voor = md5_ca_na);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  F1  charge_allocations byte-identiek (' || n_ca_voor || ' -> ' || n_ca_na || ' rijen, niet leeg)';

  ok := (n_pay_voor > 0) AND (md5_pay_voor <> md5_leeg)
    AND (n_pay_voor = n_pay_na) AND (md5_pay_voor = md5_pay_na);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  F2  payments byte-identiek (' || n_pay_voor || ' -> ' || n_pay_na || ' rijen, niet leeg)';

  ok := (n_je_voor > 0) AND (md5_je_voor <> md5_leeg)
    AND (n_je_voor = n_je_na) AND (md5_je_voor = md5_je_na);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  F3  journal_entries byte-identiek (' || n_je_voor || ' -> ' || n_je_na || ' rijen, niet leeg)';

  -- ═══════════════════════════════════════════════════ D — DIRECTE DML ════

  -- D1 authenticated INSERT
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM set_config('role', 'authenticated', true);
    INSERT INTO public.ownership(unit_id, owner_id, share, start_date)
    VALUES (u2, oA1, 1, vandaag);
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLSTATE = '42501');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  D1  authenticated INSERT op ownership: permission denied';

  -- D2 authenticated UPDATE
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM set_config('role', 'authenticated', true);
    UPDATE public.ownership SET end_date = vandaag WHERE id = ow2;
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLSTATE = '42501');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  D2  authenticated UPDATE op ownership: permission denied';

  -- D3 authenticated DELETE
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM set_config('role', 'authenticated', true);
    DELETE FROM public.ownership WHERE id = ow2;
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLSTATE = '42501');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  D3  authenticated DELETE op ownership: permission denied';

  -- D4 service_role heeft geen DML meer
  BEGIN
    PERFORM set_config('role', 'service_role', true);
    DELETE FROM public.ownership WHERE id = ow2;
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLSTATE = '42501');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  D4  service_role DELETE op ownership: permission denied';

  -- D5 anon kan niets, ook niet lezen
  BEGIN
    PERFORM set_config('role', 'anon', true);
    SELECT count(*) INTO n FROM public.ownership;
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLSTATE = '42501');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  D5  anon heeft geen enkel tabelrecht op ownership';

  -- D6 anon kan de RPC niet aanroepen
  BEGIN
    PERFORM set_config('role', 'anon', true);
    PERFORM public.transfer_ownership(u1, ow2, oA3, vandaag);
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLSTATE = '42501');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  D6  anon kan transfer_ownership niet uitvoeren';

  -- ═══════════════════════════════════════ I — HISTORIE-IMMUTABILITY ══════
  PERFORM set_config('role', 'postgres', true);

  -- I1 eigenaar van een bestaande rij herschrijven
  BEGIN
    UPDATE public.ownership SET owner_id = oA3 WHERE id = ow2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_HISTORY_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  I1  owner_id van een eigendomsrij is onwijzigbaar';

  -- I2 gesloten rij heropenen
  BEGIN
    UPDATE public.ownership SET end_date = NULL WHERE id = ow1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_HISTORY_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  I2  een gesloten periode kan niet worden heropend';

  -- I3 gesloten einddatum verschuiven
  BEGIN
    UPDATE public.ownership SET end_date = vandaag - 5 WHERE id = ow1;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_HISTORY_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  I3  een gesloten einddatum kan niet worden verschoven';

  -- I4 startdatum verschuiven op een lopende rij
  BEGIN
    UPDATE public.ownership SET start_date = vandaag - 200 WHERE id = ow2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_HISTORY_IMMUTABLE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  I4  start_date is onwijzigbaar';

  -- I5 toekomstige einddatum zetten
  BEGIN
    UPDATE public.ownership SET end_date = vandaag + 10 WHERE id = ow2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_DATE_FUTURE%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  I5  een einddatum in de toekomst wordt geweigerd';

  -- I6 pure no-op is onschadelijk
  BEGIN
    UPDATE public.ownership SET end_date = end_date WHERE id = ow2;
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,60); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  I6  een no-op UPDATE veroorzaakt geen integriteitsfout' || coalesce(' — '||msg,''); msg := NULL;

  -- ══════════════════════════════════════════ X — EXCLUSION CONSTRAINTS ═══

  -- X1 twee overlappende primaire perioden op hetzelfde lot.
  --
  -- De bestaande primaire periode op u1 is na T1 gesloten op [D-100, D-1]. De
  -- nieuwe rij [D-150, D-50] valt daar ECHT overheen: hij begint eerder en
  -- eindigt binnen die periode. Een eerdere versie gebruikte [D-200, D-150] en
  -- overlapte daarmee niets, waardoor de INSERT terecht slaagde en de assertie
  -- niet kon aantonen wat zij beweerde.
  --
  -- oA3 heeft nog geen rij op u1, dus `ownership_owner_period_excl` en
  -- `ownership_unit_owner_start_key` kunnen hier niet eerst vuren: de weigering
  -- moet van `ownership_primary_period_excl` komen, en dat wordt afgedwongen.
  BEGIN
    INSERT INTO public.ownership(unit_id, owner_id, share, start_date, end_date, is_primary_debtor)
    VALUES (u1, oA3, 1, vandaag - 150, vandaag - 50, true);
    ok := false; v_constraint := '(geen fout)';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    ok := (SQLSTATE = '23P01') AND (v_constraint = 'ownership_primary_period_excl');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  X1  overlappende primaire perioden geweigerd met 23P01 via ' || coalesce(v_constraint,'?');

  -- X2 mede-eigendom blijft mogelijk: niet-primair mag wel overlappen
  BEGIN
    INSERT INTO public.ownership(unit_id, owner_id, share, start_date, is_primary_debtor)
    VALUES (u1, oA4, 0.5, vandaag, false);
    ok := true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,60); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  X2  toegestane mede-eigendom wordt NIET geblokkeerd' || coalesce(' — '||msg,''); msg := NULL;

  -- X2b de zo ontstane mede-eigendom is GELDIG volgens de allocation engine:
  -- twee actieve eigenaars met exact een aangewezen debiteur. create_charge_call
  -- weigert alleen bij n_active > 1 AND n_primary <> 1, dus deze toestand is
  -- toerekenbaar en hoort in de applicatie geen foutmelding op te leveren.
  SELECT n_active, n_primary INTO v_rec
    FROM public.fn_alloc_resolve_owner(u1, vandaag);
  ok := (v_rec.n_active = 2 AND v_rec.n_primary = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  X2b geldige mede-eigendom: n_active=2, n_primary=1 (toerekenbaar)';

  -- X3 dezelfde eigenaar twee keer tegelijk op hetzelfde lot.
  --
  -- X2 gaf oA4 de lopende periode [D, oneindig). Een tweede rij met dezelfde
  -- startdatum zou eerst `ownership_unit_owner_start_key` (UNIQUE uit m12)
  -- raken en 23505 geven — dat is wel een weigering, maar niet van de constraint
  -- die deze assertie bedoelt te bewijzen. Met startdatum D-10 is de combinatie
  -- (unit, eigenaar, startdatum) uniek, terwijl de periode [D-10, oneindig)
  -- wel degelijk overlapt met [D, oneindig).
  --
  -- is_primary_debtor blijft false, zodat `ownership_primary_period_excl` niet
  -- van toepassing is en alleen `ownership_owner_period_excl` kan vuren.
  BEGIN
    INSERT INTO public.ownership(unit_id, owner_id, share, start_date, is_primary_debtor)
    VALUES (u1, oA4, 0.25, vandaag - 10, false);
    ok := false; v_constraint := '(geen fout)';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    ok := (SQLSTATE = '23P01') AND (v_constraint = 'ownership_owner_period_excl');
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  X3  dezelfde eigenaar tegelijk op een lot geweigerd met 23P01 via ' || coalesce(v_constraint,'?');

  -- GEEN opruim-DELETE: de historieguard weigert elke ownership-delete zolang
  -- de organisatie bestaat, en die weigering zou dit testblok afbreken. X2 laat
  -- daarom bewust een geldige mede-eigenaar (oA4) op u1 achter. De cascadetests
  -- hieronder zijn daar ongevoelig voor: C6 en C9 bouwen een EIGEN organisatie
  -- en delen geen enkele rij met dit blok, en C1/C2 vergelijken md5-waarden die
  -- met drie rijen net zo goed werken als met twee.
  PERFORM set_config('role', 'postgres', true);

  -- ═════════════════════════════════════════════════════ C — CASCADES ═════

  -- C1 losse owner-delete met ownership, zonder financiele historie
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) INTO md5_row_voor
    FROM public.ownership t WHERE t.owner_id = oA2;
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM set_config('role', 'authenticated', true);
    DELETE FROM public.owners WHERE id = oA2;
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLERRM LIKE 'OWNERSHIP_DELETE_FORBIDDEN%');
  END;
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) INTO md5_row_na
    FROM public.ownership t WHERE t.owner_id = oA2;
  SELECT count(*) INTO n FROM public.owners WHERE id = oA2;
  ok := ok AND (n = 1) AND (md5_row_voor = md5_row_na);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C1  owner-delete met ownership geblokkeerd; owner en ownership identiek';

  -- C2 losse unit-delete met ownership
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) INTO md5_row_voor
    FROM public.ownership t WHERE t.unit_id = u1;
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM set_config('role', 'authenticated', true);
    DELETE FROM public.units WHERE id = u1;
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLERRM LIKE 'OWNERSHIP_DELETE_FORBIDDEN%');
  END;
  SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) INTO md5_row_na
    FROM public.ownership t WHERE t.unit_id = u1;
  SELECT count(*) INTO n FROM public.units WHERE id = u1;
  ok := ok AND (n = 1) AND (md5_row_voor = md5_row_na);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C2  unit-delete met ownership geblokkeerd; unit en ownership identiek';

  -- C3 building-delete met onderliggende ownership
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM set_config('role', 'authenticated', true);
    DELETE FROM public.buildings WHERE id = vbA;
    PERFORM set_config('role', 'postgres', true);
    ok := false;
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := (SQLERRM LIKE 'OWNERSHIP_DELETE_FORBIDDEN%'
        OR SQLERRM LIKE 'BUILDING_HAS_FINANCIAL_HISTORY%');
  END;
  SELECT count(*) INTO n FROM public.buildings WHERE id = vbA;
  ok := ok AND (n = 1);
  SELECT count(*) INTO n FROM public.units WHERE building_id = vbA;
  ok := ok AND (n = 4);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C3  building-delete met ownership geblokkeerd; gebouwketen intact';

  -- C4 de geblokkeerde poging maakt link_first_owner niet opnieuw mogelijk
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM public.link_first_owner(u1, oA1, vandaag);
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_HISTORY_EXISTS%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C4  na een geblokkeerde cascade blijft het lot "al gekoppeld"';

  -- C5 directe ownership-delete als postgres, organisatie bestaat nog
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    DELETE FROM public.ownership WHERE id = ow2;
    ok := false;
  EXCEPTION WHEN others THEN ok := (SQLERRM LIKE 'OWNERSHIP_DELETE_FORBIDDEN%'); END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C5  postgres kan een eigendomsrij niet los verwijderen';

  -- C6 owner ZONDER ownership en zonder financiele historie blijft verwijderbaar.
  --
  -- Volledig eigen fixture: eigen organisatie, eigen eigenaar. Een eerdere
  -- versie verwijderde oA3 uit organisatie A en ging ervan uit dat die eigenaar
  -- nergens eigendom had. Die aanname hing af van het slagen OF falen van X1 —
  -- toen X1 zijn rij wel wist te plaatsen, viel C6 om zonder dat er iets mis was
  -- met de delete-invariant zelf. Zo'n koppeling hoort er niet te zijn.
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    PERFORM set_config('request.jwt.claims', PU, true);
    vorgC := public.create_organization('M30 ORG C6');
    INSERT INTO public.owners(organization_id, full_name)
    VALUES (vorgC, 'M30 C6 eigenaar zonder eigendom') RETURNING id INTO oC6;

    -- Uitgangssituatie expliciet vastleggen in plaats van aannemen.
    SELECT count(*) INTO n FROM public.ownership WHERE owner_id = oC6;
    ok := (n = 0);
    SELECT count(*) INTO n FROM public.charge_allocations WHERE owner_id = oC6;
    ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.payments WHERE owner_id = oC6;
    ok := ok AND (n = 0);

    PERFORM set_config('role', 'authenticated', true);
    DELETE FROM public.owners WHERE id = oC6;
    PERFORM set_config('role', 'postgres', true);
    SELECT count(*) INTO n FROM public.owners WHERE id = oC6;
    ok := ok AND (n = 0);
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := false; msg := left(SQLERRM,60);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C6  owner zonder ownership blijft verwijderbaar (eigen fixture)' || coalesce(' — '||msg,''); msg := NULL;

  -- C7 unit ZONDER ownership en zonder financiele historie
  BEGIN
    PERFORM set_config('request.jwt.claims', PU, true);
    PERFORM set_config('role', 'authenticated', true);
    DELETE FROM public.units WHERE id = u2;
    PERFORM set_config('role', 'postgres', true);
    SELECT count(*) INTO n FROM public.units WHERE id = u2;
    ok := (n = 0);
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := false; msg := left(SQLERRM,60);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C7  unit zonder ownership blijft verwijderbaar' || coalesce(' — '||msg,''); msg := NULL;

  -- C8 VOLLEDIGE organisatiecascade blijft werken, zonder verweesde rijen
  PERFORM set_config('role', 'postgres', true);
  SELECT count(*) INTO n FROM public.ownership o
    JOIN public.units uu ON uu.id = o.unit_id
   WHERE uu.building_id IN (vbA, vbA2);
  ok := (n > 0);   -- er is echt iets te cascaderen
  BEGIN
    DELETE FROM public.organizations WHERE id = vorgA;
    SET CONSTRAINTS ALL IMMEDIATE;
    ok := ok AND true;
  EXCEPTION WHEN others THEN ok := false; msg := left(SQLERRM,90); END;
  BEGIN SET CONSTRAINTS ALL DEFERRED; EXCEPTION WHEN others THEN NULL; END;
  IF ok THEN
    SELECT count(*) INTO n FROM public.organizations WHERE id = vorgA;           ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.memberships   WHERE organization_id = vorgA; ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.buildings     WHERE organization_id = vorgA; ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.owners        WHERE organization_id = vorgA; ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.units         WHERE building_id IN (vbA, vbA2); ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.ownership     WHERE unit_id IN (u1,u3,u4,u5,u6); ok := ok AND (n = 0);
  END IF;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C8  volledige organisatiecascade ruimt ook ownership op' || coalesce(' — '||msg,''); msg := NULL;

  -- C9 zelfstandige organisatiecascade: begint met BESTAAND eigendom en eindigt
  -- zonder wezen.
  --
  -- Een eerdere versie telde alleen databasebreed het aantal verweesde rijen.
  -- In een dataloze database is dat gegarandeerd nul, en na een MISLUKTE C8 ook,
  -- want dan is er niets gecascadeerd. De assertie kon dus slagen zonder dat er
  -- ooit een cascade had plaatsgevonden. Nu bouwt C9 zijn eigen organisatie op,
  -- bewijst dat er eigendom bestaat, verwijdert de organisatie en controleert
  -- alle vijf de niveaus plus het databasebrede wezencriterium.
  BEGIN
    PERFORM set_config('role', 'postgres', true);
    PERFORM set_config('request.jwt.claims', PU, true);
    vorgD := public.create_organization('M30 ORG C9');
    INSERT INTO public.buildings(organization_id, name, total_tantiemes)
    VALUES (vorgD, 'M30 C9', 1000) RETURNING id INTO vbD;
    INSERT INTO public.units(building_id, label, unit_type, tantiemes)
    VALUES (vbD, 'D1', 'appartement', 100) RETURNING id INTO uD;
    INSERT INTO public.owners(organization_id, full_name)
    VALUES (vorgD, 'M30 C9 eigenaar') RETURNING id INTO oD;
    owD := public.link_first_owner(uD, oD, vandaag - 30);

    -- Er moet echt iets te cascaderen zijn.
    SELECT count(*) INTO n FROM public.ownership WHERE unit_id = uD;
    ok := (n = 1);

    DELETE FROM public.organizations WHERE id = vorgD;

    SELECT count(*) INTO n FROM public.organizations WHERE id = vorgD;      ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.buildings     WHERE id = vbD;        ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.units         WHERE id = uD;         ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.owners        WHERE id = oD;         ok := ok AND (n = 0);
    SELECT count(*) INTO n FROM public.ownership     WHERE id = owD;        ok := ok AND (n = 0);

    -- Databasebreed: geen eigendomsrij zonder eigenaar of zonder lot.
    SELECT count(*) INTO n FROM public.ownership o
     WHERE NOT EXISTS (SELECT 1 FROM public.owners w WHERE w.id = o.owner_id)
        OR NOT EXISTS (SELECT 1 FROM public.units  uu WHERE uu.id = o.unit_id);
    ok := ok AND (n = 0);
  EXCEPTION WHEN others THEN
    PERFORM set_config('role', 'postgres', true);
    ok := false; msg := left(SQLERRM,70);
  END;
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  C9  eigen organisatiecascade met bestaand eigendom, nul wezen' || coalesce(' — '||msg,''); msg := NULL;

  -- ═════════════════════════════════════════════ G — RECHTEN EN OBJECTEN ══
  ok := has_table_privilege('authenticated','public.ownership','SELECT')
    AND NOT has_table_privilege('authenticated','public.ownership','INSERT')
    AND NOT has_table_privilege('authenticated','public.ownership','UPDATE')
    AND NOT has_table_privilege('authenticated','public.ownership','DELETE')
    AND NOT has_table_privilege('anon','public.ownership','SELECT')
    AND NOT has_table_privilege('service_role','public.ownership','INSERT')
    AND NOT has_table_privilege('service_role','public.ownership','UPDATE')
    AND NOT has_table_privilege('service_role','public.ownership','DELETE');
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  G1  tabelgrants op ownership exact zoals bedoeld';

  ok := has_function_privilege('authenticated','public.link_first_owner(uuid,uuid,date)','EXECUTE')
    AND has_function_privilege('authenticated','public.transfer_ownership(uuid,uuid,uuid,date)','EXECUTE')
    AND NOT has_function_privilege('anon','public.link_first_owner(uuid,uuid,date)','EXECUTE')
    AND NOT has_function_privilege('anon','public.transfer_ownership(uuid,uuid,uuid,date)','EXECUTE')
    AND NOT has_function_privilege('public','public.transfer_ownership(uuid,uuid,uuid,date)','EXECUTE')
    AND NOT has_function_privilege('service_role','public.transfer_ownership(uuid,uuid,uuid,date)','EXECUTE');
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  G2  functiegrants exact zoals bedoeld, geen nutteloze service_role-grant';

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='ownership';
  ok := (n = 1);
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='ownership'
     AND policyname='ownership_select' AND cmd='SELECT';
  ok := ok AND (n = 1);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  G3  uitsluitend ownership_select als policy';

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid='public.ownership'::regclass
     AND tgname='trig_01_ownership_history' AND tgenabled='O';
  ok := (n = 1);
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='public.ownership'::regclass
     AND conname IN ('ownership_primary_period_excl','ownership_owner_period_excl');
  ok := ok AND (n = 2);
  IF ok THEN pass:=pass+1; ELSE fail:=fail+1; END IF;
  rep := rep || E'\n' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END
      || '  G4  historieguard actief en beide exclusion constraints aanwezig';

  -- ═══════════════════════════════════════════════════════ RAPPORT ════════
  RAISE EXCEPTION E'\n=== m30 ownership transfer ===\n%\n\n%  geslaagd, %  gefaald\n(deze exceptie rolt alle testdata terug)',
    rep, pass, fail;
END $test$;

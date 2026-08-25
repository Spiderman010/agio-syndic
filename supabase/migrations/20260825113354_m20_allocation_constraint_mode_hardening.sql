-- m20 — Flexible allocation engine: constraint-mode hardening
--
-- PROBLEEM
-- `SET CONSTRAINTS ALL IMMEDIATE` geldt voor de REST van de transactie. Heeft
-- een caller (een andere RPC, een migratie, een testharnas, een DBA-sessie) die
-- modus eerder in dezelfde transactie gezet, dan vuren onze uitgestelde
-- controles al tijdens de opbouw van de lastenoproep in plaats van bij commit:
--   * trig_zz_cc_alloc_total vuurt direct na de charge_calls-INSERT, dus
--     voordat er ook maar een allocatie bestaat  -> "telt op tot 0 centen";
--   * trig_zz_ca_alloc_total vuurt per allocatierij, dus al na de eerste;
--   * trig_journal_entry_complete vuurt direct na de journal_entries-INSERT,
--     dus voordat de regels bestaan -> "heeft 0 regel(s)";
--   * trig_journal_balance_check vuurt na de eerste journaalregel, die per
--     definitie nog niet in balans is.
-- De RPC zou dan hard falen op een correcte invoer.
--
-- OPLOSSING
-- De RPC dwingt zijn eigen vereiste constraint-mode af voordat hij iets
-- schrijft. Bewust GEEN `SET CONSTRAINTS ALL DEFERRED`: alleen de vier
-- controles die deze functie zelf opbouwt worden uitgesteld. Wat de caller
-- verder aan constraints op IMMEDIATE heeft staan blijft ongemoeid, en
-- trig_zz_rule_complete_w blijft eveneens ongemoeid — die bewaakt
-- allocation_rule_weights, en die tabel raakt deze functie niet aan.
--
-- Empirisch vastgesteld (teruggerolde transactie op deze database): met alleen
-- de twee allocatie-constraints uitgesteld faalt de RPC alsnog op
-- trig_journal_entry_complete. Alle vier zijn nodig, en niet meer dan vier.
--
-- De controles zelf worden NIET zwakker: uitstellen betekent dat ze bij COMMIT
-- draaien, precies zoals bedoeld. Een onjuiste verdeling faalt onverminderd.
--
-- Dit is de enige wijziging ten opzichte van m17; de rest van de functie is
-- woordelijk gelijk.
CREATE OR REPLACE FUNCTION public.create_charge_call(
  p_fiscal_year_id     uuid,
  p_type               public.charge_call_type,
  p_total_amount       numeric,
  p_call_date          date,
  p_due_date           date    DEFAULT NULL,
  p_period             text    DEFAULT NULL,
  p_label              text    DEFAULT NULL,
  p_resolution_ref     text    DEFAULT NULL,
  p_allocation_rule_id uuid    DEFAULT NULL,
  p_manual_lines       jsonb   DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_org        uuid;
  v_building   uuid;
  v_fy_year    int;
  v_fy_status  public.fiscal_year_status;
  v_rule       public.allocation_rules%ROWTYPE;
  v_block_code text;
  v_cents      bigint;
  v_units      uuid[];
  v_weights    bigint[];
  v_n          int;
  v_den        bigint;
  v_rtot       int;
  v_call       uuid;
  v_missing    text;
  v_sum_t      bigint;
  v_partial    boolean := false;
  v_entry      uuid;
  v_sum_alloc  bigint;
BEGIN
  -- ---- 1. boekjaar, gebouw en organisatie -------------------------------
  SELECT fy.organization_id, fy.building_id, fy.year, fy.status
    INTO v_org, v_building, v_fy_year, v_fy_status
    FROM public.fiscal_years fy WHERE fy.id = p_fiscal_year_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ALLOC_FY_NOT_FOUND: boekjaar bestaat niet' USING ERRCODE = '23514';
  END IF;

  -- ---- 2. autorisatie ----------------------------------------------------
  IF NOT public.can_write(v_org) THEN
    RAISE EXCEPTION 'ALLOC_FORBIDDEN: u heeft geen schrijfrechten in deze organisatie'
      USING ERRCODE = '42501';
  END IF;

  IF v_fy_status = 'closed' THEN
    RAISE EXCEPTION 'ALLOC_FY_CLOSED: boekjaar is afgesloten; aanmaken van een lastenoproep is niet toegestaan'
      USING ERRCODE = '23514';
  END IF;

  -- ---- 3. locks ----------------------------------------------------------
  -- Serialiseert het aanmaken van lastenoproepen per gebouw en bevriest de
  -- gewichten voor de duur van deze transactie. Zonder deze locks kan een
  -- gelijktijdige `UPDATE units SET tantiemes` tussen de controle en het
  -- wegschrijven committen, waardoor een oproep met de ene set gevalideerd en
  -- met de andere weggeschreven zou worden.
  -- m20: eigen constraint-mode afdwingen vóór de eerste write. Zie de kop van
  -- de migratie voor de motivering en voor waarom het precies deze vier zijn.
  SET CONSTRAINTS public.trig_zz_cc_alloc_total,
                  public.trig_zz_ca_alloc_total,
                  public.trig_journal_entry_complete,
                  public.trig_journal_balance_check DEFERRED;
  PERFORM 1 FROM public.buildings WHERE id = v_building FOR UPDATE;
  PERFORM 1 FROM public.units WHERE building_id = v_building ORDER BY id FOR UPDATE;

  -- ---- 4. verdeelregel ---------------------------------------------------
  IF p_allocation_rule_id IS NULL THEN
    SELECT * INTO v_rule FROM public.allocation_rules
     WHERE building_id = v_building AND is_default AND status = 'active'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ALLOC_NO_DEFAULT_RULE: dit gebouw heeft geen actieve standaard-verdeelregel'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO v_rule FROM public.allocation_rules
     WHERE id = p_allocation_rule_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ALLOC_RULE_NOT_FOUND: verdeelregel bestaat niet' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_rule.building_id <> v_building THEN
    RAISE EXCEPTION 'ALLOC_RULE_WRONG_BUILDING: verdeelregel hoort bij een ander gebouw'
      USING ERRCODE = '23514';
  END IF;
  IF v_rule.status <> 'active' THEN
    RAISE EXCEPTION 'ALLOC_RULE_INACTIVE: verdeelregel "%" is niet actief', v_rule.label
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.allocation_rule_weights WHERE rule_id = v_rule.id ORDER BY id FOR UPDATE;

  -- ---- 5. bedrag ---------------------------------------------------------
  IF p_total_amount IS NULL OR p_total_amount <= 0 OR NOT (p_total_amount < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'ALLOC_AMOUNT_INVALID: het bedrag van de lastenoproep moet groter dan nul zijn'
      USING ERRCODE = '23514';
  END IF;
  v_cents := round(p_total_amount * 100)::bigint;

  -- ---- 6. deelnemersverzameling -----------------------------------------
  IF v_rule.uncovered_unit_policy = 'fail' THEN
    SELECT string_agg(u.label, ', ' ORDER BY u.label) INTO v_missing
      FROM public.fn_alloc_uncovered_units(v_rule.id) x JOIN public.units u ON u.id = x.unit_id;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'ALLOC_UNCOVERED_UNITS: deze lots vallen buiten verdeelregel "%": %. Voeg ze toe of sluit ze uit.',
        v_rule.label, v_missing USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT array_agg(x.unit_id ORDER BY x.unit_id) INTO v_units
    FROM public.fn_alloc_scope_units(v_rule.id) x;

  v_n := coalesce(array_length(v_units, 1), 0);
  IF v_n = 0 THEN
    IF v_rule.scope = 'block' THEN
      RAISE EXCEPTION 'ALLOC_EMPTY_BLOCK: het gekozen blok bevat geen lots' USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'ALLOC_NO_PARTICIPANTS: geen enkel lot neemt deel aan verdeelregel "%"', v_rule.label
      USING ERRCODE = '23514';
  END IF;

  -- ---- 7. gewichten per methode -----------------------------------------
  -- Geen enkele tak kent een stille terugval: een ontbrekend of nul gewicht is
  -- altijd een harde fout, nooit een impliciete uitsluiting.
  IF v_rule.method = 'equal' THEN
    SELECT array_agg(1000000::bigint) INTO v_weights FROM unnest(v_units);

  ELSIF v_rule.weight_source = 'unit_tantiemes' THEN
    SELECT string_agg(u.label, ', ' ORDER BY u.label) INTO v_missing
      FROM public.units u WHERE u.id = ANY(v_units) AND coalesce(u.tantiemes, 0) <= 0;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'ALLOC_WEIGHT_MISSING: deze deelnemende lots hebben geen tantième: %. Vul die in of sluit ze uit.',
        v_missing USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(u.tantiemes::bigint * 1000000 ORDER BY u.id) INTO v_weights
      FROM public.units u WHERE u.id = ANY(v_units);

  ELSIF v_rule.weight_source = 'rule_weights' THEN
    SELECT string_agg(u.label, ', ' ORDER BY u.label) INTO v_missing
      FROM public.units u
     WHERE u.id = ANY(v_units)
       AND NOT EXISTS (SELECT 1 FROM public.allocation_rule_weights w
                        WHERE w.rule_id = v_rule.id AND w.unit_id = u.id);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'ALLOC_WEIGHT_MISSING: deze deelnemende lots hebben geen gewicht in verdeelregel "%": %.',
        v_rule.label, v_missing USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(round(w.weight * 1000000)::bigint ORDER BY w.unit_id) INTO v_weights
      FROM public.allocation_rule_weights w
     WHERE w.rule_id = v_rule.id AND w.unit_id = ANY(v_units);

  ELSIF v_rule.method = 'manual' THEN
    IF p_manual_lines IS NULL OR jsonb_typeof(p_manual_lines) <> 'array' THEN
      RAISE EXCEPTION 'ALLOC_MANUAL_MISSING: bij een handmatige verdeling moeten bedragen per lot worden meegegeven'
        USING ERRCODE = '23514';
    END IF;
    -- Een lot buiten de scope is een harde fout, geen stille uitsluiting.
    SELECT string_agg(l.unit_id::text, ', ') INTO v_missing
      FROM jsonb_to_recordset(p_manual_lines) AS l(unit_id uuid, amount_cents bigint)
     WHERE NOT (l.unit_id = ANY(v_units));
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'ALLOC_MANUAL_OUT_OF_SCOPE: deze lots vallen buiten de gekozen reikwijdte: %', v_missing
        USING ERRCODE = '23514';
    END IF;
    SELECT string_agg(u.label, ', ' ORDER BY u.label) INTO v_missing
      FROM public.units u
     WHERE u.id = ANY(v_units)
       AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_manual_lines) AS l(unit_id uuid, amount_cents bigint)
                        WHERE l.unit_id = u.id);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'ALLOC_MANUAL_MISSING_UNIT: deze deelnemende lots hebben geen bedrag: %', v_missing
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_manual_lines) AS l(unit_id uuid, amount_cents bigint)
                WHERE l.amount_cents IS NULL OR l.amount_cents < 0) THEN
      RAISE EXCEPTION 'ALLOC_MANUAL_NEGATIVE: een handmatig bedrag mag niet negatief zijn' USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM (SELECT l.unit_id FROM jsonb_to_recordset(p_manual_lines)
          AS l(unit_id uuid, amount_cents bigint) GROUP BY l.unit_id HAVING count(*) > 1) q) > 0 THEN
      RAISE EXCEPTION 'ALLOC_MANUAL_DUPLICATE: een lot komt meer dan een keer voor in de handmatige verdeling'
        USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(l.amount_cents ORDER BY l.unit_id) INTO v_weights
      FROM jsonb_to_recordset(p_manual_lines) AS l(unit_id uuid, amount_cents bigint);
    IF (SELECT sum(x) FROM unnest(v_weights) x) <> v_cents THEN
      RAISE EXCEPTION 'ALLOC_MANUAL_SUM: de handmatige bedragen tellen op tot % MAD, de lastenoproep is % MAD. Verschil % MAD.',
        to_char((SELECT sum(x) FROM unnest(v_weights) x)::numeric/100, 'FM999999990.00'),
        to_char(p_total_amount, 'FM999999990.00'),
        to_char((v_cents - (SELECT sum(x) FROM unnest(v_weights) x))::numeric/100, 'FM999999990.00')
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'ALLOC_METHOD_UNSUPPORTED: onbekende combinatie van methode en gewichtsbron' USING ERRCODE = '23514';
  END IF;

  -- ---- 8. noemer en controlewaarde --------------------------------------
  SELECT sum(x) INTO v_den FROM unnest(v_weights) x;
  IF v_den IS NULL OR v_den <= 0 THEN
    RAISE EXCEPTION 'ALLOC_ZERO_DENOMINATOR: de som van de gewichten is nul of negatief' USING ERRCODE = '23514';
  END IF;

  IF v_rule.method = 'percentage' AND v_den <> 100000000 THEN
    RAISE EXCEPTION 'ALLOC_PCT_SUM: de percentages tellen op tot % procent in plaats van 100 procent',
      to_char(v_den::numeric/1000000, 'FM999990.000000') USING ERRCODE = '23514';
  END IF;

  -- F09 — controlewaarde uit het règlement. Geldt uitsluitend voor een
  -- tantième-verdeling over het HELE gebouw op units.tantiemes: alleen dan
  -- bestaat er een verklaarde controlewaarde voor exact deze verzameling.
  IF v_rule.method = 'tantieme'
     AND v_rule.scope = 'whole_building'
     AND v_rule.weight_source = 'unit_tantiemes' THEN
    SELECT b.total_tantiemes::bigint * 1000000 INTO v_sum_t
      FROM public.buildings b WHERE b.id = v_building;
    IF v_den <> v_sum_t THEN
      IF v_rule.partial_denominator_until_year IS NOT NULL
         AND v_fy_year <= v_rule.partial_denominator_until_year THEN
        v_partial := true;
      ELSE
        RAISE EXCEPTION
          'ALLOC_CONTROL_TOTAL: de som van de tantièmes van de deelnemende lots (%) wijkt af van de vastgestelde tantièmes van het gebouw (%). Vul de ontbrekende lots aan, of leg een onderbouwde afwijking vast.',
          (v_den / 1000000)::text, (v_sum_t / 1000000)::text USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  -- ---- 9. eigenaarscontrole ----------------------------------------------
  SELECT string_agg(u.label, ', ' ORDER BY u.label) INTO v_missing
    FROM public.units u
    LEFT JOIN LATERAL public.fn_alloc_resolve_owner(u.id, p_call_date) o ON true
   WHERE u.id = ANY(v_units) AND o.owner_id IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ALLOC_NO_OWNER: deze lots hebben geen eigenaar op %: %. Leg de eigenaar vast.',
      to_char(p_call_date, 'DD-MM-YYYY'), v_missing USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(u.label, ', ' ORDER BY u.label) INTO v_missing
    FROM public.units u
    JOIN LATERAL public.fn_alloc_resolve_owner(u.id, p_call_date) o ON true
   WHERE u.id = ANY(v_units) AND o.n_active > 1 AND o.n_primary <> 1;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ALLOC_AMBIGUOUS_OWNER: deze lots hebben meerdere actieve eigenaars zonder aangewezen debiteur: %. Wijs per lot een debiteur aan.',
      v_missing USING ERRCODE = '23514';
  END IF;

  -- ---- 10. snapshotkop ----------------------------------------------------
  SELECT bl.code INTO v_block_code FROM public.blocks bl WHERE bl.id = v_rule.scope_block_id;

  SELECT r.remainder_total INTO v_rtot
    FROM public.fn_alloc_distribute(v_units, v_weights, v_cents) r LIMIT 1;

  INSERT INTO public.charge_calls (
    organization_id, fiscal_year_id, building_id, type, period, label,
    total_amount, call_date, due_date, resolution_ref,
    allocation_rule_id, alloc_method, alloc_scope, alloc_weight_source,
    alloc_rule_code, alloc_rule_label, alloc_rule_revision,
    alloc_block_id, alloc_block_code,
    alloc_total_cents, alloc_denominator, alloc_unit_count, alloc_remainder_cents,
    alloc_tie_breaker, alloc_algo_version, alloc_partial_denominator
  ) VALUES (
    v_org, p_fiscal_year_id, v_building, p_type, p_period, p_label,
    p_total_amount, p_call_date, p_due_date, p_resolution_ref,
    v_rule.id, v_rule.method, v_rule.scope, v_rule.weight_source,
    v_rule.code, v_rule.label, v_rule.revision,
    v_rule.scope_block_id, v_block_code,
    v_cents, v_den, v_n, v_rtot,
    'remainder_desc_unit_id_asc', 1, v_partial
  ) RETURNING id INTO v_call;

  -- ---- 11. handmatige brondocumentregels ---------------------------------
  IF v_rule.method = 'manual' THEN
    INSERT INTO public.charge_call_lines (organization_id, building_id, charge_call_id, unit_id, amount_cents)
    SELECT v_org, v_building, v_call, l.unit_id, l.amount_cents
      FROM jsonb_to_recordset(p_manual_lines) AS l(unit_id uuid, amount_cents bigint);
  END IF;

  -- ---- 12. allocaties -----------------------------------------------------
  -- Elk deelnemend lot krijgt een rij, ook bij nul centen: alleen dan is
  -- count(charge_allocations) = alloc_unit_count een echte gelijkheidstoets en
  -- kan geen lot stilzwijgend uit de verdeelstaat vallen.
  INSERT INTO public.charge_allocations (
    organization_id, building_id, charge_call_id, unit_id, owner_id,
    amount, settled_amount, weight_micro, base_cents, remainder, remainder_rank,
    extra_cent, amount_cents, call_total_cents, call_denominator, call_remainder_cents,
    ownership_id, ownership_share_ppm
  )
  SELECT v_org, v_building, v_call, d.unit_id, o.owner_id,
         d.amount_cents::numeric / 100, 0,
         d.weight_micro, d.base_cents, d.remainder, d.remainder_rank,
         d.extra_cent, d.amount_cents, v_cents, v_den, v_rtot,
         o.ownership_id, o.share_ppm
    FROM public.fn_alloc_distribute(v_units, v_weights, v_cents) d
    JOIN LATERAL public.fn_alloc_resolve_owner(d.unit_id, p_call_date) o ON true;

  -- ---- 13. somcontrole ----------------------------------------------------
  SELECT sum(amount_cents) INTO v_sum_alloc
    FROM public.charge_allocations WHERE charge_call_id = v_call;
  IF v_sum_alloc IS DISTINCT FROM v_cents THEN
    RAISE EXCEPTION 'ALLOC_SUM_MISMATCH: de verdeling telt op tot % centen in plaats van %. De lastenoproep is niet vastgelegd.',
      coalesce(v_sum_alloc, 0)::text, v_cents::text USING ERRCODE = '23514';
  END IF;

  -- ---- 14. journaalpost uit de SUBADMINISTRATIE --------------------------
  -- Niet uit total_amount: door hier de som van de allocaties te boeken is de
  -- aansluiting tussen 4111 en de subadministratie een definitie in plaats van
  -- een toevalligheid.
  INSERT INTO public.journal_entries (
    organization_id, building_id, fiscal_year_id, entry_date, source, source_id, description
  ) VALUES (
    v_org, v_building, p_fiscal_year_id, p_call_date, 'charge', v_call,
    coalesce(p_label, 'Lastenoproep ' || to_char(p_call_date, 'DD-MM-YYYY'))
  ) RETURNING id INTO v_entry;

  INSERT INTO public.journal_lines (organization_id, journal_entry_id, account_id, debit, credit, description)
  VALUES
    (v_org, v_entry, public.require_account_id(v_org, '4111'),
     v_sum_alloc::numeric / 100, 0, 'Vordering copropriétaires'),
    (v_org, v_entry, public.require_account_id(v_org, '7011'),
     0, v_sum_alloc::numeric / 100,
     'Lastenoproep' || CASE WHEN p_period IS NOT NULL THEN ' ' || p_period ELSE '' END);

  RETURN v_call;
END $fn$;

REVOKE ALL     ON FUNCTION public.create_charge_call(uuid, public.charge_call_type, numeric, date, date, text, text, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_charge_call(uuid, public.charge_call_type, numeric, date, date, text, text, text, uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.create_charge_call(uuid, public.charge_call_type, numeric, date, date, text, text, text, uuid, jsonb) IS
  'Enig schrijfpad voor een lastenoproep. Doet validatie, resolutie, snapshot, centverdeling, somcontrole en journaalpost in een transactie, en dwingt zelf de vereiste constraint-mode af zodat de caller die niet kan breken. Faalt hard bij elke onvolledigheid; kent geen stille terugval.';
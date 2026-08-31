-- m26 — Financial Reversal Engine: RPC's, views en rechten
--
-- Tweede helft van de engine. m25 legt het schema, de guards en de hulpfuncties vast; dit
-- bestand voegt de vier aanroepbare RPC's toe, de twee integriteitsviews en de rechten.
--
-- WAAROM GESPLITST VAN m25
-- Niet omdat het technisch moest, maar omdat de twee helften een verschillende levensduur
-- hebben. m25 is structuur - tabellen, constraints en triggers die je zelden aanraakt. Dit
-- bestand is gedrag: de RPC's zullen bij een volgende ronde eerder wijzigen (gedeeltelijke
-- storno, verrekening van 4419). Een CREATE OR REPLACE op een functie is dan een schone
-- diff, zonder dat het schemabestand meebeweegt.
--
-- De REVOKE's op de hulp- en triggerfuncties uit m25 staan bewust hier, bij de rest van het
-- rechtenblok, zodat er een enkele plek is waar het volledige rechtenbeeld van de engine
-- staat. m25 en m26 draaien altijd achter elkaar; daartussen kan niemand verbinden.
--
-- VOLGORDE
-- Dit bestand is hard afhankelijk van m24 (enum-waarde 'reversal') en m25 (tabellen,
-- fn_reversal_target_fy, fn_reversal_authorize, fn_reversal_mirror_journal).

-- =========================================================================
-- 9. betalingen: storno en correctie
-- =========================================================================
-- De kern zit in een interne functie zodat correct_payment hem hergebruikt en er maar EEN
-- implementatie van de storno-logica bestaat. p_correction_id wordt door correct_payment
-- vooraf gegenereerd en hier meegegeven, zodat financial_reversals in EEN INSERT compleet is
-- en nooit hoeft te worden bijgewerkt.
CREATE OR REPLACE FUNCTION public.fn_reverse_payment_core(
  p_payment_id    uuid,
  p_reason        text,
  p_correction_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_pay       public.payments%ROWTYPE;
  v_orig_je   uuid;
  v_orig_fy   uuid;
  v_n         int;
  v_target_fy uuid;
  v_rev_id    uuid := gen_random_uuid();
  v_new_je    uuid := gen_random_uuid();
  v_eff       date := current_date;
  v_reason    text;
  v_alloc     RECORD;
  v_neut      numeric(14,2) := 0;
  v_orig_4111 numeric(14,2);
BEGIN
  -- 1. reden. De CHECK op de tabel dekt dit ook af; deze controle levert de nette foutcode.
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION
      'REVERSAL_REASON_REQUIRED: geef een reden van 10 tot 500 tekens op. Een financiele storno zonder opgegeven reden is geen auditspoor.'
      USING ERRCODE = '23514';
  END IF;
  v_reason := btrim(p_reason);

  -- 2. bronrij vergrendelen VOOR elke controle. Dit sluit het TOCTOU-venster met een
  --    gelijktijdige tweede storno: die wacht hier, en ziet daarna in stap 5 de vastgelegde
  --    reversal (READ COMMITTED geeft elk statement een verse snapshot).
  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: deze betaling bestaat niet.' USING ERRCODE = '23514';
  END IF;

  -- 3. de originele journaalpost is de boekhoudkundige waarheid over deze betaling.
  SELECT count(*) INTO v_n
    FROM public.journal_entries WHERE source = 'payment' AND source_id = p_payment_id;
  IF v_n = 0 THEN
    RAISE EXCEPTION
      'PAYMENT_NOT_JOURNALED: deze betaling heeft geen journaalpost en hoeft niet te worden gestorneerd.'
      USING ERRCODE = '23514';
  ELSIF v_n > 1 THEN
    RAISE EXCEPTION
      'PAYMENT_AMBIGUOUS_JOURNAL: deze betaling heeft % journaalposten; storneren zou raden zijn.',
      v_n USING ERRCODE = '23514';
  END IF;

  SELECT id, fiscal_year_id INTO v_orig_je, v_orig_fy
    FROM public.journal_entries WHERE source = 'payment' AND source_id = p_payment_id;

  -- 4. autorisatie op het boekjaar van de ORIGINELE post.
  PERFORM public.fn_reversal_authorize(v_pay.organization_id, v_orig_fy);

  -- 5. nette voorcontrole op dubbele storno. De harde garantie is de unique index in stap 8.
  IF EXISTS (SELECT 1 FROM public.financial_reversals
              WHERE source_type = 'payment' AND source_id = p_payment_id) THEN
    RAISE EXCEPTION
      'ALREADY_REVERSED: deze betaling is al gestorneerd; een storno kan niet nogmaals worden geboekt.'
      USING ERRCODE = '23505';
  END IF;

  -- 6. doelboekjaar: nooit een gesloten jaar.
  v_target_fy := public.fn_reversal_target_fy(v_pay.building_id, v_orig_fy);

  -- 7. gespiegelde journaalpost. Origineel 5141 D / 4111 C / 4419 C wordt hiermee
  --    5141 C / 4111 D / 4419 D, zonder dat die bedragen ergens opnieuw worden berekend.
  PERFORM public.fn_reversal_mirror_journal(v_orig_je, v_new_je, v_rev_id, v_target_fy, v_eff);

  -- 8. de auditgebeurtenis. De unique index op (source_type, source_id) is hier het echte
  --    slot tegen een gelijktijdige tweede storno.
  BEGIN
    INSERT INTO public.financial_reversals(
      id, organization_id, source_type, source_id, reversal_journal_entry_id,
      correction_source_id, fiscal_year_id, effective_date, reason, created_by)
    VALUES (v_rev_id, v_pay.organization_id, 'payment', p_payment_id, v_new_je,
            p_correction_id, v_target_fy, v_eff, v_reason, auth.uid());
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'ALREADY_REVERSED: deze betaling is al gestorneerd; een storno kan niet nogmaals worden geboekt.'
      USING ERRCODE = '23505';
  END;

  -- 9. neutraliseer elke originele toewijzing. De originele payment_allocations zijn de enige
  --    waarheid over wat deze betaling heeft afgeboekt; er wordt niets herberekend.
  FOR v_alloc IN
    SELECT pa.id, pa.organization_id, pa.charge_allocation_id, pa.amount
      FROM public.payment_allocations pa
     WHERE pa.payment_id = p_payment_id
     ORDER BY pa.id
  LOOP
    -- Vergrendel de vordering voordat we hem verlagen; dit conflicteert met de FOR UPDATE OF
    -- ca die fn_payment_fifo neemt, zodat storno en gelijktijdige betaling serialiseren.
    PERFORM 1 FROM public.charge_allocations WHERE id = v_alloc.charge_allocation_id FOR UPDATE;

    INSERT INTO public.payment_allocation_reversals(
      organization_id, reversal_id, payment_allocation_id, charge_allocation_id, amount)
    VALUES (v_alloc.organization_id, v_rev_id, v_alloc.id,
            v_alloc.charge_allocation_id, v_alloc.amount);

    -- Deze UPDATE komt langs fn_guard_ca_settlement_derived. Hij slaagt uitsluitend omdat de
    -- neutralisatierij hierboven al bestaat.
    UPDATE public.charge_allocations
       SET settled_amount = settled_amount - v_alloc.amount
     WHERE id = v_alloc.charge_allocation_id;

    v_neut := v_neut + v_alloc.amount;
  END LOOP;

  -- 10. sluitcontrole: wat we in de subadministratie hebben teruggedraaid moet exact gelijk
  --     zijn aan wat het grootboek destijds op 4111 afboekte. Loopt dat uiteen, dan is er
  --     buiten de engine om iets veranderd en breken we af in plaats van door te boeken.
  SELECT coalesce(sum(jl.credit), 0) INTO v_orig_4111
    FROM public.journal_lines jl
    JOIN public.accounts a ON a.id = jl.account_id
   WHERE jl.journal_entry_id = v_orig_je AND a.code = '4111';

  IF v_neut IS DISTINCT FROM v_orig_4111 THEN
    RAISE EXCEPTION
      'REVERSAL_ALLOCATION_MISMATCH: geneutraliseerd % wijkt af van de oorspronkelijke afboeking op 4111 van %. De subadministratie en het grootboek liepen al uiteen; storno afgebroken.',
      v_neut, v_orig_4111 USING ERRCODE = '23514';
  END IF;

  RETURN v_rev_id;
END $fn$;

COMMENT ON FUNCTION public.fn_reverse_payment_core(uuid, text, uuid) IS
  'Interne kern van de betalingsstorno. Niet als RPC bedoeld; gebruik reverse_payment of correct_payment.';

CREATE OR REPLACE FUNCTION public.reverse_payment(p_payment_id uuid, p_reason text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  RETURN public.fn_reverse_payment_core(p_payment_id, p_reason, NULL);
END $fn$;

COMMENT ON FUNCTION public.reverse_payment(uuid, text) IS
  'Storneert een betaling volledig: neutraliseert elke toewijzing, herstelt de openstaande vordering en boekt een gespiegelde journaalpost in het geldige open boekjaar. Het origineel blijft ongewijzigd bestaan. Retourneert het id van de financial_reversals-rij.';

-- Storno EN vervangende betaling in EEN transactie. Faalt de nieuwe betaling - bijvoorbeeld
-- omdat er geen open boekjaar is - dan rolt ook de storno terug. Er bestaat geen toestand
-- waarin de oude betaling wel is teruggedraaid en de nieuwe ontbreekt.
--
-- VALUTADATUM: p_value_date wordt overgenomen zoals opgegeven. De datum is een BANKFEIT en
-- wordt niet naar het huidige boekjaar verlegd. fn_journal_from_payment boekt de nieuwe
-- betaling vervolgens in het meest recente OPEN boekjaar, precies zoals bij elke andere
-- betaling. Wijken die twee af, dan is dat een correctie over de jaargrens; die is
-- herkenbaar via v_financial_reversals.is_correctie_vorig_boekjaar.
--
-- Eigenaar en gebouw staan bewust NIET in de signatuur: een andere debiteur of een ander
-- gebouw is geen correctie van deze betaling maar een andere transactie.
CREATE OR REPLACE FUNCTION public.correct_payment(
  p_payment_id uuid,
  p_amount     numeric,
  p_value_date date,
  p_method     public.payment_method,
  p_reference  text,
  p_reason     text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_pay    public.payments%ROWTYPE;
  v_new_id uuid := gen_random_uuid();
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION
      'CORRECTION_AMOUNT_INVALID: het gecorrigeerde bedrag moet groter dan nul zijn. Gebruik reverse_payment wanneer de betaling in het geheel niet had mogen worden geboekt.'
      USING ERRCODE = '23514';
  END IF;
  IF p_value_date IS NULL THEN
    RAISE EXCEPTION 'CORRECTION_VALUE_DATE_REQUIRED: een valutadatum is verplicht.'
      USING ERRCODE = '23514';
  END IF;
  IF p_method IS NULL THEN
    RAISE EXCEPTION 'CORRECTION_METHOD_REQUIRED: een betaalwijze is verplicht.'
      USING ERRCODE = '23514';
  END IF;

  -- Storno eerst, inclusief alle autorisatie- en toestandscontroles.
  PERFORM public.fn_reverse_payment_core(p_payment_id, p_reason, v_new_id);

  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id;

  -- De vervangende betaling is een doodgewone rij: trig_01_payment_fifo en
  -- trig_02_payment_journal doen hun werk ongewijzigd. Geen duplicatie van FIFO-logica.
  INSERT INTO public.payments(
    id, organization_id, building_id, owner_id, amount, method, value_date, reference)
  VALUES (v_new_id, v_pay.organization_id, v_pay.building_id, v_pay.owner_id,
          p_amount, p_method, p_value_date, p_reference);

  RETURN v_new_id;
END $fn$;

COMMENT ON FUNCTION public.correct_payment(uuid, numeric, date, public.payment_method, text, text) IS
  'Storneert een betaling volledig en boekt in dezelfde transactie een vervangende betaling met de gecorrigeerde gegevens. Retourneert het id van de nieuwe betaling. Faalt er iets, dan rolt de hele correctie terug.';

-- =========================================================================
-- 10. uitgaven: storno en correctie
-- =========================================================================
CREATE OR REPLACE FUNCTION public.fn_reverse_expense_core(
  p_expense_id    uuid,
  p_reason        text,
  p_correction_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_exp       public.expenses%ROWTYPE;
  v_orig_je   uuid;
  v_orig_fy   uuid;
  v_n         int;
  v_target_fy uuid;
  v_rev_id    uuid := gen_random_uuid();
  v_new_je    uuid := gen_random_uuid();
  v_eff       date := current_date;
  v_reason    text;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION
      'REVERSAL_REASON_REQUIRED: geef een reden van 10 tot 500 tekens op. Een financiele storno zonder opgegeven reden is geen auditspoor.'
      USING ERRCODE = '23514';
  END IF;
  v_reason := btrim(p_reason);

  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND: deze uitgave bestaat niet.' USING ERRCODE = '23514';
  END IF;

  -- Een uitgave zonder boekjaar krijgt van fn_journal_from_expense geen journaalpost. Die is
  -- gewoon nog verwijderbaar (m23) en heeft geen storno nodig.
  SELECT count(*) INTO v_n
    FROM public.journal_entries WHERE source = 'expense' AND source_id = p_expense_id;
  IF v_n = 0 THEN
    RAISE EXCEPTION
      'EXPENSE_NOT_JOURNALED: deze uitgave heeft geen journaalpost en hoeft niet te worden gestorneerd; hij kan gewoon worden ingetrokken.'
      USING ERRCODE = '23514';
  ELSIF v_n > 1 THEN
    RAISE EXCEPTION
      'EXPENSE_AMBIGUOUS_JOURNAL: deze uitgave heeft % journaalposten; storneren zou raden zijn.',
      v_n USING ERRCODE = '23514';
  END IF;

  SELECT id, fiscal_year_id INTO v_orig_je, v_orig_fy
    FROM public.journal_entries WHERE source = 'expense' AND source_id = p_expense_id;

  PERFORM public.fn_reversal_authorize(v_exp.organization_id, v_orig_fy);

  IF EXISTS (SELECT 1 FROM public.financial_reversals
              WHERE source_type = 'expense' AND source_id = p_expense_id) THEN
    RAISE EXCEPTION
      'ALREADY_REVERSED: deze uitgave is al gestorneerd; een storno kan niet nogmaals worden geboekt.'
      USING ERRCODE = '23505';
  END IF;

  v_target_fy := public.fn_reversal_target_fy(v_exp.building_id, v_orig_fy);

  -- Exact spiegelen: de lastrekening komt uit de HISTORISCHE journaalregel, niet uit de
  -- actuele expenses.account_id of de default van de categorie. Dat is de hele reden dat deze
  -- functie de originele regels leest in plaats van opnieuw af te leiden.
  PERFORM public.fn_reversal_mirror_journal(v_orig_je, v_new_je, v_rev_id, v_target_fy, v_eff);

  BEGIN
    INSERT INTO public.financial_reversals(
      id, organization_id, source_type, source_id, reversal_journal_entry_id,
      correction_source_id, fiscal_year_id, effective_date, reason, created_by)
    VALUES (v_rev_id, v_exp.organization_id, 'expense', p_expense_id, v_new_je,
            p_correction_id, v_target_fy, v_eff, v_reason, auth.uid());
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'ALREADY_REVERSED: deze uitgave is al gestorneerd; een storno kan niet nogmaals worden geboekt.'
      USING ERRCODE = '23505';
  END;

  RETURN v_rev_id;
END $fn$;

COMMENT ON FUNCTION public.fn_reverse_expense_core(uuid, text, uuid) IS
  'Interne kern van de uitgavenstorno. Niet als RPC bedoeld; gebruik reverse_expense of correct_expense.';

CREATE OR REPLACE FUNCTION public.reverse_expense(p_expense_id uuid, p_reason text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  RETURN public.fn_reverse_expense_core(p_expense_id, p_reason, NULL);
END $fn$;

COMMENT ON FUNCTION public.reverse_expense(uuid, text) IS
  'Storneert een gejournaliseerde uitgave met een gespiegelde journaalpost in het geldige open boekjaar. Het bewijsstuk en de originele rij blijven bestaan. Retourneert het id van de financial_reversals-rij.';

CREATE OR REPLACE FUNCTION public.correct_expense(
  p_expense_id   uuid,
  p_amount       numeric,
  p_expense_date date,
  p_account_id   uuid,
  p_category_id  uuid,
  p_supplier     text,
  p_description  text,
  p_receipt_path text,
  p_reason       text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_exp       public.expenses%ROWTYPE;
  v_rev_id    uuid;
  v_new_id    uuid := gen_random_uuid();
  v_target_fy uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION
      'CORRECTION_AMOUNT_INVALID: het gecorrigeerde bedrag moet groter dan nul zijn. Gebruik reverse_expense wanneer de uitgave in het geheel niet had mogen worden geboekt.'
      USING ERRCODE = '23514';
  END IF;
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'CORRECTION_EXPENSE_DATE_REQUIRED: een uitgavedatum is verplicht.'
      USING ERRCODE = '23514';
  END IF;

  v_rev_id := public.fn_reverse_expense_core(p_expense_id, p_reason, v_new_id);

  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  SELECT fiscal_year_id INTO v_target_fy FROM public.financial_reversals WHERE id = v_rev_id;

  -- De vervangende uitgave landt in het GELDIGE doelboekjaar, niet in het originele: dat kan
  -- inmiddels gesloten zijn. fn_journal_from_expense maakt de nieuwe journaalpost.
  -- De composite-FK's (account_id, organization_id) en (category_id, organization_id) op
  -- expenses weigeren een rekening of categorie uit een andere organisatie; die controle
  -- hoeft hier dus niet te worden herhaald.
  INSERT INTO public.expenses(
    id, organization_id, building_id, fiscal_year_id, category_id, account_id,
    supplier, description, amount, expense_date, receipt_path)
  VALUES (v_new_id, v_exp.organization_id, v_exp.building_id, v_target_fy,
          p_category_id, p_account_id, p_supplier, p_description,
          p_amount, p_expense_date, p_receipt_path);

  RETURN v_new_id;
END $fn$;

COMMENT ON FUNCTION public.correct_expense(uuid, numeric, date, uuid, uuid, text, text, text, text) IS
  'Storneert een gejournaliseerde uitgave en boekt in dezelfde transactie een vervangende uitgave in het geldige open boekjaar. Retourneert het id van de nieuwe uitgave. Faalt er iets, dan rolt de hele correctie terug.';

-- =========================================================================
-- 11. integriteits- en rapportageviews
-- =========================================================================
-- security_invoker, zoals v_allocation_integrity en v_reconciliation_4111: de RLS van de
-- aanroeper geldt, dus een lid ziet uitsluitend de eigen organisatie.
CREATE OR REPLACE VIEW public.v_settlement_integrity
WITH (security_invoker = true) AS
SELECT ca.id              AS charge_allocation_id,
       ca.organization_id,
       ca.building_id,
       ca.charge_call_id,
       ca.owner_id,
       ca.amount,
       ca.settled_amount,
       coalesce(pa.som, 0)                        AS toegewezen,
       coalesce(par.som, 0)                       AS gestorneerd,
       coalesce(pa.som, 0) - coalesce(par.som, 0) AS afgeleid,
       ca.settled_amount = coalesce(pa.som, 0) - coalesce(par.som, 0) AS ok
  FROM public.charge_allocations ca
  LEFT JOIN (SELECT charge_allocation_id, sum(amount) AS som
               FROM public.payment_allocations GROUP BY charge_allocation_id) pa
         ON pa.charge_allocation_id = ca.id
  LEFT JOIN (SELECT charge_allocation_id, sum(amount) AS som
               FROM public.payment_allocation_reversals GROUP BY charge_allocation_id) par
         ON par.charge_allocation_id = ca.id;

COMMENT ON VIEW public.v_settlement_integrity IS
  'Controleert per vordering dat settled_amount exact volgt uit de toewijzingen minus de neutralisaties. ok = false betekent drift tussen subadministratie en de onderliggende feiten; dat hoort nooit voor te komen zolang fn_guard_ca_settlement_derived actief is.';

-- Maakt zichtbaar WELKE transacties zijn gestorneerd en of de correctie over een jaargrens
-- heen valt - het scenario dat ontstaat wanneer de oorspronkelijke valutadatum bewaard blijft
-- terwijl de journaalpost in het lopende open boekjaar landt.
CREATE OR REPLACE VIEW public.v_financial_reversals
WITH (security_invoker = true) AS
SELECT fr.id                    AS reversal_id,
       fr.organization_id,
       fr.source_type,
       fr.source_id,
       fr.correction_source_id,
       fr.reversal_journal_entry_id,
       fr.fiscal_year_id        AS storno_boekjaar_id,
       oje.fiscal_year_id       AS origineel_boekjaar_id,
       oje.building_id,
       fr.effective_date,
       fr.reason,
       fr.created_by,
       fr.created_at,
       (fr.correction_source_id IS NOT NULL)                        AS is_correctie,
       (oje.fiscal_year_id IS DISTINCT FROM fr.fiscal_year_id)      AS is_correctie_vorig_boekjaar
  FROM public.financial_reversals fr
  LEFT JOIN public.journal_entries oje
         ON oje.source = fr.source_type::public.journal_source
        AND oje.source_id = fr.source_id;

COMMENT ON VIEW public.v_financial_reversals IS
  'Leesbaar overzicht van storno''s en correcties. is_correctie onderscheidt een kale storno van een correctie met vervangende rij; is_correctie_vorig_boekjaar is waar zodra de storno in een ander boekjaar is geboekt dan het origineel.';

REVOKE ALL ON public.v_settlement_integrity FROM anon;
REVOKE ALL ON public.v_financial_reversals  FROM anon;
GRANT SELECT ON public.v_settlement_integrity TO authenticated;
GRANT SELECT ON public.v_financial_reversals  TO authenticated;

-- =========================================================================
-- 12. rechten
-- =========================================================================
-- Alleen de vier bedoelde RPC's zijn aanroepbaar. De interne kernen, de hulpfuncties en de
-- triggerfuncties horen geen endpoint te zijn: fn_reverse_payment_core met een zelfgekozen
-- p_correction_id zou anders een correctiepointer laten vervalsen.
REVOKE ALL ON FUNCTION public.fn_reverse_payment_core(uuid, text, uuid)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_reverse_expense_core(uuid, text, uuid)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_reversal_target_fy(uuid, uuid)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_reversal_authorize(uuid, uuid)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_reversal_mirror_journal(uuid, uuid, uuid, uuid, date)
                                                                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_ca_settlement_derived()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_payment_immutable()               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_expense_immutable()               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_financial_reversal_immutable()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_par_immutable()                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_par_consistent()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_fr_correction_exists()            FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.reverse_payment(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_expense(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.correct_payment(uuid, numeric, date, public.payment_method, text, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.correct_expense(uuid, numeric, date, uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.reverse_payment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_expense(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_payment(uuid, numeric, date, public.payment_method, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_expense(uuid, numeric, date, uuid, uuid, text, text, text, text)
  TO authenticated;

-- m28 — Financial Reversal Engine: vier bevindingen uit de adversariële review
--
-- Alle vier gevonden door de adversariële review op m24–m27, alle vier bewezen met een
-- rollback-probe op de live database, alle vier hier gesloten. Geen ervan is een regressie
-- van een oudere migratie; drie zijn gaten die m25/m26 zelf introduceerden en één is een
-- pre-existente zwakte die de nieuwe guard zichtbaar maakte.

-- ============ P1-A. de settlement-guard leunde op een onbewaakte optelling ============
-- fn_guard_ca_settlement_derived leidt settled_amount af uit
--     SUM(payment_allocations.amount) - SUM(payment_allocation_reversals.amount).
-- De kop van m25 sectie 6 claimde: "Er is geen context om te vervalsen, want er wordt geen
-- context gelezen." Dat was te sterk geformuleerd. Er wordt geen context gelezen, maar wel
-- DATA — en die data was even onbewaakt als de kolom die de guard beschermt.
--
-- payment_allocations kende namelijk GEEN enkele invariant die de som per betaling koppelt
-- aan payments.amount. Bewezen: een extra toewijzing van 600,00 bijschrijven op een BESTAANDE
-- betaling van 400,00 werd nergens tegengehouden, waarna settled_amount legitiem naar 1000,00
-- kon worden getild. Een vordering van 1000,00 stond dan volledig afgeboekt terwijl er 400,00
-- was ontvangen en het grootboek 4111 met slechts 400,00 was gecrediteerd.
--
-- Erger nog was het detectiegat: v_settlement_integrity stelt exact dezelfde vergelijking en
-- rapporteerde daardoor ok = true. Geen preventie EN geen detectie.
--
-- De fix bindt de tweede operand op dezelfde manier als de reversal-zijde al gebonden was:
-- de toewijzingen van een betaling kunnen samen nooit meer zijn dan de betaling zelf.
--
-- BEWUST NIET DEFERRED. fn_payment_fifo wijst per iteratie hoogstens het resterende bedrag
-- toe, dus de som blijft bij ELKE tussenstap onder het betaalde bedrag; een uitgestelde
-- controle zou hier niets extra's toestaan en zou wél onzichtbaar blijven in de testharnas,
-- die bewust nooit commit.
CREATE OR REPLACE FUNCTION public.fn_guard_pa_within_payment()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_betaald    numeric(14,2);
  v_toegewezen numeric(14,2);
BEGIN
  SELECT amount INTO v_betaald FROM public.payments WHERE id = NEW.payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ALLOCATION_UNKNOWN_PAYMENT: de toewijzing verwijst naar een betaling die niet bestaat.'
      USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_toegewezen
    FROM public.payment_allocations WHERE payment_id = NEW.payment_id;

  IF v_toegewezen > v_betaald THEN
    RAISE EXCEPTION
      'ALLOCATION_EXCEEDS_PAYMENT: de toewijzingen van deze betaling tellen op tot % terwijl er % is ontvangen.',
      v_toegewezen, v_betaald USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trig_zz_pa_within_payment ON public.payment_allocations;
CREATE TRIGGER trig_zz_pa_within_payment
  AFTER INSERT OR UPDATE ON public.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_pa_within_payment();

-- Detectie naast preventie, zodat drift meetbaar is en niet alleen onmogelijk hoort te zijn.
CREATE OR REPLACE VIEW public.v_payment_allocation_integrity
WITH (security_invoker = true) AS
SELECT p.id AS payment_id, p.organization_id, p.building_id, p.owner_id,
       p.amount,
       coalesce(sum(pa.amount), 0)            AS toegewezen,
       p.amount - coalesce(sum(pa.amount), 0) AS vooruitontvangen,
       coalesce(sum(pa.amount), 0) <= p.amount AS ok
  FROM public.payments p
  LEFT JOIN public.payment_allocations pa ON pa.payment_id = p.id
 GROUP BY p.id;

COMMENT ON VIEW public.v_payment_allocation_integrity IS
  'Controleert per betaling dat de toewijzingen samen niet meer zijn dan het ontvangen bedrag. Het verschil is per definitie het vooruitontvangen deel (4419). ok = false hoort nooit voor te komen zolang fn_guard_pa_within_payment actief is.';

REVOKE ALL ON public.v_payment_allocation_integrity FROM anon, authenticated;
GRANT SELECT ON public.v_payment_allocation_integrity TO authenticated;

-- ====== P1-B. een gebruiker verwijderen die ooit een storno boekte was onmogelijk ======
-- financial_reversals.created_by is `REFERENCES auth.users(id) ON DELETE SET NULL`. PostgreSQL
-- voert die RI-actie uit als een UPDATE op de kindrij — en fn_guard_financial_reversal_immutable
-- weigerde ELKE UPDATE onvoorwaardelijk, nog vóór de parent-escape werd bereikt.
--
-- Gevolg: zodra een gebruiker één keer reverse_payment/correct_payment/reverse_expense/
-- correct_expense had aangeroepen, faalde `DELETE FROM auth.users WHERE id = <die gebruiker>`
-- met 23514. Dat is precies het statement dat Supabase GoTrue's admin deleteUser uitvoert, dus
-- het offboarden van een vertrokken manager of accountant én elk AVG-verwijderverzoek liepen
-- hard vast op de database. De handmatige omweg (`UPDATE ... SET created_by = NULL`) werd door
-- diezelfde tak geblokkeerd.
--
-- De fix laat exact één overgang toe: created_by naar NULL, uitsluitend wanneer de gebruiker
-- daadwerkelijk niet meer bestaat, en met alle overige kolommen aantoonbaar ongewijzigd. Het
-- auditspoor blijft daarmee volledig intact — reden, tijdstip, bedrag en bestemming staan er
-- nog — en alleen de verwijzing naar het verwijderde account vervalt. Dat is precies wat
-- anonimisering hoort te betekenen.
--
-- DEZELFDE FOUT BESTAAT PRE-EXISTENT op public.fiscal_year_closings.closed_by, dat ook
-- ON DELETE SET NULL is en door fn_guard_fy_closing_immutable onvoorwaardelijk wordt geweigerd.
-- Die valt buiten de scope van de reversal-engine en is NIET hier gerepareerd; zolang dat open
-- staat blijft het verwijderen van een gebruiker die ooit een boekjaar afsloot geblokkeerd.
-- Vastgelegd in docs/known-issues.md.
CREATE OR REPLACE FUNCTION public.fn_guard_financial_reversal_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.created_by IS NULL
       AND OLD.created_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.created_by)
       AND NEW.id                        =         OLD.id
       AND NEW.organization_id           =         OLD.organization_id
       AND NEW.source_type               =         OLD.source_type
       AND NEW.source_id                 =         OLD.source_id
       AND NEW.reversal_journal_entry_id =         OLD.reversal_journal_entry_id
       AND NEW.correction_source_id IS NOT DISTINCT FROM OLD.correction_source_id
       AND NEW.fiscal_year_id            =         OLD.fiscal_year_id
       AND NEW.effective_date            =         OLD.effective_date
       AND NEW.reason                    =         OLD.reason
       AND NEW.created_at                =         OLD.created_at THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'FINANCIAL_REVERSAL_IMMUTABLE: een vastgelegde storno is auditdata en kan niet worden gewijzigd.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations   WHERE id = OLD.organization_id)
  OR NOT EXISTS (SELECT 1 FROM public.fiscal_years    WHERE id = OLD.fiscal_year_id)
  OR NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE id = OLD.reversal_journal_entry_id) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'FINANCIAL_REVERSAL_IMMUTABLE: een vastgelegde storno is auditdata en kan niet worden verwijderd zolang het boekjaar en de journaalpost bestaan.'
    USING ERRCODE = '23514';
END $fn$;

-- ======= P1-C. de gespiegelde journaalpost wissen sloopte de hele audittrail =======
-- financial_reversals_je_org_fk staat op ON DELETE CASCADE. Het verwijderen van de
-- storno-journaalpost nam daardoor de financial_reversals-rij mee, en die nam via cascade de
-- payment_allocation_reversals mee — terwijl settled_amount verlaagd bleef staan.
--
-- Resultaat: de vordering stond afgeboekt zonder ook maar één rij die uitlegde waarom, en
-- omdat de afgeleide waarde niet meer klopte weigerde fn_guard_ca_settlement_derived
-- vervolgens ELKE nieuwe betaling van die eigenaar op die vordering. De vordering was
-- daarmee permanent onbruikbaar, en alleen te "repareren" met een rauwe UPDATE die de storno
-- spoorloos ongedaan maakt.
--
-- Bereikbaar via service_role, de SQL-editor of een migratiescript: precies de actoren die
-- m22, m23 en m25 expliciet als binnen het dreigingsmodel aanmerken.
--
-- De FK blijft CASCADE — dat is nodig voor het opruimen van een organisatie of gebouw. In
-- plaats daarvan komt er een guard op journal_entries die het los verwijderen van een
-- storno-post weigert, met de gebruikelijke parent-cascade-escape zodat offboarding blijft
-- werken.
CREATE OR REPLACE FUNCTION public.fn_guard_reversal_entry_delete()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF OLD.source <> 'reversal' THEN
    RETURN OLD;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id)
  OR NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
  OR NOT EXISTS (SELECT 1 FROM public.fiscal_years  WHERE id = OLD.fiscal_year_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (SELECT 1 FROM public.financial_reversals WHERE reversal_journal_entry_id = OLD.id) THEN
    RAISE EXCEPTION
      'REVERSAL_ENTRY_IMMUTABLE: deze journaalpost is het bewijs van een vastgelegde storno en kan niet worden verwijderd; het zou de audittrail wissen en de openstaande positie ontregelen.'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

-- trig_01, dus NA trig_00_je_closed_fy: een post in een afgesloten boekjaar houdt de
-- duidelijkere gesloten-melding.
DROP TRIGGER IF EXISTS trig_01_je_reversal_delete ON public.journal_entries;
CREATE TRIGGER trig_01_je_reversal_delete BEFORE DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_reversal_entry_delete();

-- ===== P1-D. een correctie kon over twee OPEN boekjaren worden gesplitst =====
-- Twee verschillende regels bepaalden waar de twee helften van één atomaire correctie landden:
--
--   * fn_reversal_target_fy gaf het ORIGINELE boekjaar terug zolang dat open was;
--   * fn_journal_from_payment boekt de vervangende betaling altijd in het MEEST RECENTE open
--     boekjaar — dat is bestaand gedrag sinds m2 en blijft ongewijzigd.
--
-- Stond er een nieuwer open boekjaar naast het originele, dan landde de storno in 2025 en de
-- correctie in 2026. De balans van 2025 werd dan wél met de storno belast maar niet met de
-- vervangende ontvangst, en de detector v_financial_reversals.is_correctie_vorig_boekjaar
-- meldde `false` omdat hij storno-jaar met origineel-jaar vergelijkt — precies de situatie die
-- hij zichtbaar had moeten maken.
--
-- De fix is één argument: voor BETALINGEN wordt p_original_fy nu bewust NULL doorgegeven,
-- zodat fn_reversal_target_fy meteen doorschakelt naar het meest recente open boekjaar en
-- exact dezelfde regel volgt als fn_journal_from_payment. Storno en correctie landen daardoor
-- per definitie in hetzelfde jaar.
--
-- Voor UITGAVEN blijft "origineel jaar als dat nog open is" wél gelden: fn_journal_from_expense
-- boekt op expenses.fiscal_year_id, en correct_expense geeft dat doelboekjaar expliciet mee aan
-- de vervangende uitgave. Daar kunnen de twee helften dus niet uiteenlopen.
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
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION
      'REVERSAL_REASON_REQUIRED: geef een reden van 10 tot 500 tekens op. Een financiele storno zonder opgegeven reden is geen auditspoor.'
      USING ERRCODE = '23514';
  END IF;
  v_reason := btrim(p_reason);

  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: deze betaling bestaat niet.' USING ERRCODE = '23514';
  END IF;

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

  -- AUTORISATIE blijft op het boekjaar van de ORIGINELE post: staat die in een afgesloten
  -- jaar, dan is het een owner/admin-ingreep. Dat is losstaand van waar de storno landt.
  PERFORM public.fn_reversal_authorize(v_pay.organization_id, v_orig_fy);

  IF EXISTS (SELECT 1 FROM public.financial_reversals
              WHERE source_type = 'payment' AND source_id = p_payment_id) THEN
    RAISE EXCEPTION
      'ALREADY_REVERSED: deze betaling is al gestorneerd; een storno kan niet nogmaals worden geboekt.'
      USING ERRCODE = '23505';
  END IF;

  -- Bewust NULL: zie P1-D hierboven. Betalingen volgen altijd het meest recente open boekjaar.
  v_target_fy := public.fn_reversal_target_fy(v_pay.building_id, NULL);

  PERFORM public.fn_reversal_mirror_journal(v_orig_je, v_new_je, v_rev_id, v_target_fy, v_eff);

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

  FOR v_alloc IN
    SELECT pa.id, pa.organization_id, pa.charge_allocation_id, pa.amount
      FROM public.payment_allocations pa
     WHERE pa.payment_id = p_payment_id
     ORDER BY pa.id
  LOOP
    PERFORM 1 FROM public.charge_allocations WHERE id = v_alloc.charge_allocation_id FOR UPDATE;

    INSERT INTO public.payment_allocation_reversals(
      organization_id, reversal_id, payment_allocation_id, charge_allocation_id, amount)
    VALUES (v_alloc.organization_id, v_rev_id, v_alloc.id,
            v_alloc.charge_allocation_id, v_alloc.amount);

    UPDATE public.charge_allocations
       SET settled_amount = settled_amount - v_alloc.amount
     WHERE id = v_alloc.charge_allocation_id;

    v_neut := v_neut + v_alloc.amount;
  END LOOP;

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

-- ============================== rechten ==============================
REVOKE ALL ON FUNCTION public.fn_guard_pa_within_payment()              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_reversal_entry_delete()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_reverse_payment_core(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

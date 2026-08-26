-- m23 — financial integrity completion
--
-- Sluit de drie resterende PRE-EXISTENTE integriteitsgaten die de adversariele review op
-- PR #4 bewees, plus een privilege-opruiming. Geen van deze punten is een regressie van m22;
-- twee ervan werden juist zichtbaar doordat m22 de omliggende routes dichtzette.
--
--   P1-A  Een gebouw met bank_accounts + bank_transactions was nog direct verwijderbaar,
--         omdat fn_building_direct_history_summary die historie niet meetelde. Bewezen als
--         gewone manager: gebouw zonder boekjaar met 2 banktransacties van samen 165.000 MAD
--         verwijderd, transacties over: 0. De COMMENT van die functie zette bank_accounts
--         bovendien ten onrechte weg als "stamdata zonder bedragen" — dat klopt voor de
--         rekening zelf, maar niet voor de mutaties erop (amount en direction zijn NOT NULL).
--   P1-B  `UPDATE fiscal_years SET status='closed'` slaagde met nul afsluitrecords. Wat m22
--         garandeerde was smaller dan de commit-boodschap claimde: een BESTAAND afsluitbewijs
--         kan niet verdwijnen, maar niets dwong af dat er ooit een werd aangemaakt.
--   P1-C  Een uitgave met journaalpost was direct verwijderbaar; de journaalpost bleef staan.
--         Bewezen: journaalposten voor 1 (2 regels), na 1. 6110 debet en 4411 credit blijven
--         dan staan zonder brondocument — de spiegelvorm van P1-B uit m22, die daar voor
--         betalingen wel werd gesloten en voor uitgaven niet.
--   P2-D  TRIGGER en REFERENCES stonden nog open voor anon en authenticated: 61 grants elk.
--
-- ROLMODEL
-- Net als m21/m22 zijn dit FINANCIELE INVARIANTEN, geen autorisatiekeuzes. De guards draaien
-- voor iedereen, ook owner/admin en service_role. Geen rol-shortcut, geen auth.uid()-escape.
--
-- WAAROM EEN RPC EN NIET ALLEEN EEN TRIGGER (P1-B)
-- Een BEFORE UPDATE-guard alleen zou de invariant "closed => afsluitbewijs" wel afdwingen,
-- maar de legitieme route dan opsplitsen in twee losse statements: eerst het afsluitbewijs
-- INSERTen, dan de status UPDATEn. PostgREST kent geen transactie over twee requests, dus
-- daar ontstaat precies het halve-afsluiting-venster dat we willen uitsluiten, en niets zou
-- de boekhoudkundige voorwaarden valideren. close_fiscal_year() doet validatie, vergrendeling,
-- het afsluitbewijs en de statuswijziging in EEN transactie. Dat volgt het patroon dat
-- create_charge_call sinds m15 al hanteert: de RPC is het enige schrijfpad en de directe route
-- staat dicht. De trigger blijft ernaast bestaan als vangnet, zodat de invariant ook geldt
-- wanneer iemand de RPC omzeilt.
--
-- OMGEKEERDE RICHTING
-- "afsluitbewijs aanwezig => status consistent" volgt uit de constructie: sinds deze migratie
-- kan alleen close_fiscal_year() een afsluitbewijs aanmaken (RLS op INSERT staat op false), en
-- die zet de status in dezelfde transactie. m22 hield UPDATE al onvoorwaardelijk dicht en
-- DELETE geguard. Nagemeten op productie voor toepassing: 0 gesloten jaren zonder afsluitbewijs
-- en 0 afsluitbewijzen bij een open jaar, dus geen backfill nodig.
--
-- GRENZEN, eerlijk benoemd
--  * Toestandscontroles ("heeft nu historie"), geen "heeft ooit historie gehad".
--  * Met session_replication_role = replica is elke trigger te omzeilen; buiten het
--    dreigingsmodel, net als bij m18-m22.
--  * Zet NOOIT FORCE ROW LEVEL SECURITY op de betrokken tabellen: de guards lezen
--    SECURITY DEFINER en RLS-blind.
--  * Geen storno- of correctieflow. Er wordt niets teruggerekend en niets gestorneerd.
--    Voor uitgaven geldt vanaf nu hetzelfde als voor betalingen sinds m22: corrigeren hoort
--    via een expliciete toekomstige correctieflow te lopen, niet via DELETE.

-- ==================== 1. bankhistorie in de gebouwguard (P1-A) ====================
-- Alleen de teller wordt uitgebreid; fn_guard_building_delete_history zelf blijft ongewijzigd
-- en erft de bredere dekking automatisch.
CREATE OR REPLACE FUNCTION public.fn_building_direct_history_summary(p_building_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  n_calls   bigint; n_pay bigint; n_exp bigint;
  n_journal bigint; n_doc bigint; n_closing bigint; n_fundmv bigint; n_banktx bigint;
  onderdelen text[] := ARRAY[]::text[];
BEGIN
  SELECT count(*) INTO n_calls   FROM public.charge_calls          WHERE building_id = p_building_id;
  SELECT count(*) INTO n_pay     FROM public.payments              WHERE building_id = p_building_id;
  SELECT count(*) INTO n_exp     FROM public.expenses              WHERE building_id = p_building_id;
  SELECT count(*) INTO n_journal FROM public.journal_entries       WHERE building_id = p_building_id;
  SELECT count(*) INTO n_closing FROM public.fiscal_year_closings  WHERE building_id = p_building_id;

  SELECT count(*) INTO n_doc
    FROM public.documents WHERE building_id = p_building_id AND status <> 'concept';

  SELECT count(*) INTO n_fundmv
    FROM public.fund_movements fm
    JOIN public.funds f ON f.id = fm.fund_id
   WHERE f.building_id = p_building_id;

  -- Banktransacties hangen via bank_accounts aan het gebouw en dragen amount en direction.
  -- Een LEGE bankrekening blijft stamdata; de mutaties erop zijn dat nadrukkelijk niet.
  SELECT count(*) INTO n_banktx
    FROM public.bank_transactions bt
    JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
   WHERE ba.building_id = p_building_id;

  IF n_calls   > 0 THEN onderdelen := onderdelen || format('%s lastenoproep(en)',   n_calls);   END IF;
  IF n_pay     > 0 THEN onderdelen := onderdelen || format('%s betaling(en)',       n_pay);     END IF;
  IF n_exp     > 0 THEN onderdelen := onderdelen || format('%s uitgave(n)',         n_exp);     END IF;
  IF n_journal > 0 THEN onderdelen := onderdelen || format('%s journaalpost(en)',   n_journal); END IF;
  IF n_closing > 0 THEN onderdelen := onderdelen || format('%s jaarafsluiting(en)', n_closing); END IF;
  IF n_doc     > 0 THEN onderdelen := onderdelen || format('%s document(en)',       n_doc);     END IF;
  IF n_fundmv  > 0 THEN onderdelen := onderdelen || format('%s fondsmutatie(s)',    n_fundmv);  END IF;
  IF n_banktx  > 0 THEN onderdelen := onderdelen || format('%s banktransactie(s)',  n_banktx);  END IF;

  IF array_length(onderdelen, 1) IS NULL THEN RETURN NULL; END IF;
  RETURN array_to_string(onderdelen, ', ');
END $fn$;

COMMENT ON FUNCTION public.fn_building_direct_history_summary(uuid) IS
  'Retourneert NULL wanneer een gebouw geen financiele historie heeft, anders een leesbare opsomming. Telt rechtstreeks op building_id, en banktransacties via bank_accounts. Bewust NIET geteld: units, blocks, ownership, allocation_rules en compliance_deadlines (stamdata en administratieve termijnen zonder bedragen), een LEGE bank_accounts-rij (stamdata: rekeningnummer zonder mutaties), en charge_allocations/charge_call_lines/journal_lines/bank_accounts (kunnen niet bestaan zonder een geteld ouderrecord of dragen zelf geen bedrag).';

-- ============ 2. gesloten boekjaar vereist een afsluitbewijs (P1-B) ============
-- Vangnet naast de RPC. Vuurt bewust als trig_02, dus NA trig_00_fy_immutable, zodat de
-- bestaande meldingen over een afgesloten boekjaar en over heropenen voorrang houden.
CREATE OR REPLACE FUNCTION public.fn_guard_fy_close_requires_closing()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF NOT EXISTS (SELECT 1 FROM public.fiscal_year_closings WHERE fiscal_year_id = NEW.id) THEN
      RAISE EXCEPTION
        'FY_CLOSE_REQUIRES_CLOSING: een boekjaar kan alleen worden afgesloten via close_fiscal_year(), zodat er een afsluitbewijs wordt vastgelegd.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trig_02_fy_close_requires_closing ON public.fiscal_years;
CREATE TRIGGER trig_02_fy_close_requires_closing BEFORE UPDATE ON public.fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fy_close_requires_closing();

-- Het enige legitieme afsluitpad. Alles in een transactie: valideren, vergrendelen,
-- afsluitbewijs schrijven, status zetten. Faalt er iets, dan is er geen half afgesloten jaar.
--
-- AUTORISATIE: can_write, dus dezelfde kring die ook lastenoproepen en uitgaven boekt.
-- Bewust NIET beperkt tot owner/admin: afsluiten is een operationele boekhoudhandeling,
-- terwijl HEROPENEN (het weer losmaken van vastgelegde historie) de uitzonderlijke ingreep is
-- die via fn_guard_fiscal_year_immutable aan owner/admin voorbehouden blijft. De
-- auth.uid()-check wordt overgeslagen wanneer er geen JWT is, zodat migraties, tests en
-- service_role-onderhoud blijven werken; de financiele voorwaarden hieronder gelden altijd.
CREATE OR REPLACE FUNCTION public.close_fiscal_year(
  p_fiscal_year_id uuid,
  p_notes          text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_fy      public.fiscal_years%ROWTYPE;
  v_debit   numeric;
  v_credit  numeric;
  v_charges numeric;
  v_income  numeric;
  v_closing uuid;
BEGIN
  -- FOR UPDATE voor de controles: zonder dit slot kunnen twee gelijktijdige aanroepen beide
  -- "status is open" lezen en allebei een afsluitbewijs schrijven.
  SELECT * INTO v_fy FROM public.fiscal_years WHERE id = p_fiscal_year_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FY_NOT_FOUND: boekjaar bestaat niet' USING ERRCODE = '23514';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.can_write(v_fy.organization_id) THEN
    RAISE EXCEPTION 'FY_CLOSE_FORBIDDEN: onvoldoende rechten om dit boekjaar af te sluiten'
      USING ERRCODE = '42501';
  END IF;

  IF v_fy.status <> 'open' THEN
    RAISE EXCEPTION 'FY_NOT_OPEN: boekjaar % heeft status % en kan niet worden afgesloten',
      v_fy.year, v_fy.status USING ERRCODE = '23514';
  END IF;

  -- Een HEROPEND boekjaar heeft nog zijn oude afsluitbewijs. fiscal_year_closings kent
  -- UNIQUE (fiscal_year_id) en is sinds m22 onwijzigbaar, dus opnieuw afsluiten via deze RPC
  -- zou dat bewijs moeten overschrijven. Dat weigeren we; zie de bekende beperking in
  -- docs/known-issues.md. De invariant blijft intact: het jaar heeft al een afsluitbewijs.
  IF EXISTS (SELECT 1 FROM public.fiscal_year_closings WHERE fiscal_year_id = p_fiscal_year_id) THEN
    RAISE EXCEPTION
      'FY_CLOSING_EXISTS: boekjaar % heeft al een onwijzigbaar afsluitbewijs uit een eerdere afsluiting en kan niet opnieuw via deze RPC worden afgesloten',
      v_fy.year USING ERRCODE = '23505';
  END IF;

  -- Boekhoudkundige afsluitvoorwaarde. trig_journal_balance_check bewaakt de balans al per
  -- journaalpost; deze controle is de jaarbrede vangnetvariant en kost een enkele scan.
  SELECT coalesce(sum(jl.debit),0), coalesce(sum(jl.credit),0)
    INTO v_debit, v_credit
    FROM public.journal_lines jl
    JOIN public.journal_entries je ON je.id = jl.journal_entry_id
   WHERE je.fiscal_year_id = p_fiscal_year_id;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'FY_JOURNAL_UNBALANCED: het journaal van boekjaar % sluit niet (debet %, credit %)',
      v_fy.year, v_debit, v_credit USING ERRCODE = '23514';
  END IF;

  -- Resultaat volgens PCSI: klasse 7 (opbrengsten) minus klasse 6 (lasten).
  SELECT coalesce(sum(jl.debit - jl.credit),0) INTO v_charges
    FROM public.journal_lines jl
    JOIN public.journal_entries je ON je.id = jl.journal_entry_id
    JOIN public.accounts a ON a.id = jl.account_id
   WHERE je.fiscal_year_id = p_fiscal_year_id AND a.code LIKE '6%';

  SELECT coalesce(sum(jl.credit - jl.debit),0) INTO v_income
    FROM public.journal_lines jl
    JOIN public.journal_entries je ON je.id = jl.journal_entry_id
    JOIN public.accounts a ON a.id = jl.account_id
   WHERE je.fiscal_year_id = p_fiscal_year_id AND a.code LIKE '7%';

  INSERT INTO public.fiscal_year_closings(
    organization_id, building_id, fiscal_year_id, result_amount, closed_by, notes)
  VALUES (v_fy.organization_id, v_fy.building_id, p_fiscal_year_id,
          round(v_income - v_charges, 2), auth.uid(), p_notes)
  RETURNING id INTO v_closing;

  UPDATE public.fiscal_years SET status = 'closed' WHERE id = p_fiscal_year_id;

  RETURN v_closing;
END $fn$;

REVOKE ALL ON FUNCTION public.close_fiscal_year(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_fiscal_year(uuid, text) TO authenticated;

-- Sinds m22 is een afsluitbewijs onwijzigbaar en niet verwijderbaar zolang het boekjaar
-- bestaat. Hiermee wordt ook het AANMAKEN voorbehouden aan de RPC, zodat "afsluitbewijs
-- aanwezig => status closed" per constructie geldt. Zelfde patroon als charge_calls sinds m15.
DROP POLICY IF EXISTS fiscal_year_closings_insert ON public.fiscal_year_closings;
CREATE POLICY fiscal_year_closings_insert ON public.fiscal_year_closings
  FOR INSERT TO authenticated WITH CHECK (false);

-- ================= 3. uitgave met journaalpost (P1-C) =================
-- Spiegelt de betalingsguard uit m22. Bewust GEEN opruiming van de journaalpost: dat zou de
-- historie herschrijven. journal_entries.source_id heeft geen FK, dus zonder deze guard blijft
-- er letterlijk niets over dat de wees aan iets koppelt.
--
-- Een uitgave ZONDER boekjaar krijgt van fn_journal_from_expense geen journaalpost en blijft
-- dus verwijderbaar. Dat is precies de herstelroute die m22's EXPENSE_FY_LATE_ASSIGNMENT
-- aanwijst, en die blijft daarmee schoon.
CREATE OR REPLACE FUNCTION public.fn_guard_expense_delete_history()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE n_journal bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
  OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  PERFORM 1 FROM public.expenses WHERE id = OLD.id FOR UPDATE;

  SELECT count(*) INTO n_journal
    FROM public.journal_entries WHERE source = 'expense' AND source_id = OLD.id;

  IF n_journal > 0 THEN
    RAISE EXCEPTION
      'EXPENSE_HAS_FINANCIAL_HISTORY: deze uitgave heeft % journaalpost(en) en kan niet worden verwijderd. Boek een correctie in plaats van te wissen.',
      n_journal USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

-- Vuurt NA trig_00_exp_closed_fy (alfabetisch: closed_fy < delete_history), zodat een uitgave
-- in een afgesloten boekjaar de duidelijkere gesloten-melding houdt.
DROP TRIGGER IF EXISTS trig_00_exp_delete_history ON public.expenses;
CREATE TRIGGER trig_00_exp_delete_history BEFORE DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_expense_delete_history();

-- ================= 4. TRIGGER / REFERENCES privileges (P2-D) =================
-- Noodzaakanalyse: PostgREST heeft USAGE op het schema, SELECT/INSERT/UPDATE/DELETE op de
-- tabellen en EXECUTE op de RPC's nodig. RLS vraagt niets extra's. TRIGGER en REFERENCES zijn
-- DDL-nabije rechten: het eerste laat een niet-eigenaar een trigger op de tabel plaatsen, het
-- tweede een foreign key ernaartoe leggen. Geen van beide wordt door de stack gebruikt, en
-- anon/authenticated hebben geen CREATE op schema public, dus ze kunnen er vandaag niets mee.
-- Least privilege: intrekken, ook voor toekomstige tabellen.
REVOKE TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;

-- ============================== rechten =====================================
-- De twee nieuwe triggerfuncties horen geen RPC-endpoint te zijn. close_fiscal_year staat hier
-- bewust NIET tussen: die moet juist door authenticated aanroepbaar zijn.
REVOKE ALL ON FUNCTION public.fn_guard_fy_close_requires_closing() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_expense_delete_history()    FROM PUBLIC, anon, authenticated;

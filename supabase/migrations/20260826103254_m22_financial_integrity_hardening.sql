-- m22 — financial integrity hardening
--
-- Sluit de resterende financiele en security-routes die de adversariele review op PR #3
-- bewees. Alle punten hieronder zijn PRE-EXISTENT; geen ervan is een regressie van m21.
--
--   P1-A  TRUNCATE stond open voor anon en authenticated op financiele kerntabellen.
--         Bewezen: `SET ROLE authenticated; TRUNCATE public.expenses` slaagde, RLS-blind,
--         over alle tenants heen. De bescherming van fiscal_years berustte enkel op een
--         toevallige cascade naar charge_calls, waar het recht wel was ingetrokken.
--   P1-B  Een betaling met allocaties was direct verwijderbaar. payment_allocations
--         cascadeerden weg, settled_amount bleef staan en de journaalpost bleef staan:
--         het grootboek bleef 600 ontvangst boeken zonder brondocument.
--   P1-C  Een jaarafsluiting was direct verwijderbaar terwijl fiscal_years.status op
--         'closed' bleef staan. UPDATE was al onvoorwaardelijk geblokkeerd, DELETE niet.
--   P1-D  fn_guard_building_delete_history keek uitsluitend via fiscal_years. Een gebouw
--         zonder boekjaar maar met 75.000 aan uitgaven, 30.000 fondsmutatie en een
--         definitief document was gewoon te verwijderen.
--   P2-E  is_org_member() gebruikte een ongekwalificeerde `from memberships` zonder pg_temp.
--   P2-F  Vijf closed-fy guards misten de parent-cascade escape; offboarding werkte alleen
--         doordat de interne RI-triggers van fiscal_years toevallig vooraan in de
--         aanmaakvolgorde staan.
--   P2-G  (test) T19 raakte maar een boekjaar; gerepareerd in de testsuite, niet hier.
--   P2-H  Een definitief document kon terug naar 'concept' en ontsloot zo het boekjaar.
--   P2-I  expenses.fiscal_year_id kon naar NULL of naar een ander jaar.
--
-- ROLMODEL
-- Alles hieronder zijn FINANCIELE INVARIANTEN, geen autorisatiekeuzes. Ze gelden voor
-- reader, manager, accountant, admin, owner en service_role gelijk. Geen rol-shortcut,
-- geen auth.uid()-escape. Correcties horen via intrekken/heropenen/storneren te lopen.
--
-- GRENZEN, eerlijk benoemd
--  * Toestandscontroles ("heeft nu historie"), geen "heeft ooit historie gehad".
--  * Met session_replication_role = replica is elke trigger te omzeilen; dat valt buiten
--    het dreigingsmodel, net als bij m18-m21.
--  * Zet NOOIT FORCE ROW LEVEL SECURITY op buildings, organizations, fiscal_years of
--    payments: de guards lezen SECURITY DEFINER en RLS-blind.
--  * Geen impliciete reparatie bij DELETE. Er wordt niets teruggerekend en niets
--    gestorneerd; een reversal/refund-flow is aparte functionaliteit.

-- ============================ 1. TRUNCATE (P1-A) =============================
-- Bestaande tabellen.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Toekomstige tabellen. Alle 32 tabellen in public zijn eigendom van `postgres` en elke
-- migratie draait als `postgres`, dus dit is de default-ACL die er werkelijk toe doet.
-- Geverifieerd: na deze regel erft een nieuw door postgres aangemaakte tabel wel SELECT/
-- INSERT/UPDATE/DELETE voor anon en authenticated, maar geen TRUNCATE meer.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;

-- Er bestaat een TWEEDE default-ACL voor public, met grantor `supabase_admin`. Die geldt
-- alleen voor tabellen die supabase_admin zelf in public aanmaakt. Wij kunnen hem niet
-- aanpassen: `postgres` is geen lid van `supabase_admin` en de poging faalt met
-- "permission denied to change default privileges". Bewust NIET als dode SQL opgenomen.
-- Zolang alle projecttabellen door postgres worden aangemaakt is dit niet bereikbaar.

-- =============== 2. gedeelde telling: directe gebouwhistorie (P1-D) ==========
-- Waarom een tweede tellerfunctie naast fn_fy_history_summary, en geen uitbreiding daarvan:
-- fn_fy_history_summary beantwoordt "heeft DIT BOEKJAAR historie". Voor een gebouw is de
-- juiste vraag "hangt er ENIG geld aan dit gebouw", ook geld dat aan geen enkel boekjaar
-- hangt. Dat is precies wat P1-D blootlegde.
--
-- Deze directe telling DOMINEERT de oude per-boekjaar-lus volledig. Elke categorie die
-- fn_fy_history_summary telt is via building_id bereikbaar: charge_calls, journal_entries,
-- expenses, fiscal_year_closings en documents hebben building_id; fondsmutaties hangen via
-- funds.building_id; charge_allocations en payment_allocations kunnen niet bestaan zonder
-- een lastenoproep, die building_id heeft. Daarbovenop vangt deze telling payments (die in
-- de boekjaartelling helemaal niet voorkwamen) en alles met fiscal_year_id IS NULL.
-- De building guard hoeft daardoor GEEN lus meer over alle boekjaren te doen: acht tellingen
-- per boekjaar worden zeven tellingen per gebouw. Sneller en breder tegelijk.
CREATE OR REPLACE FUNCTION public.fn_building_direct_history_summary(p_building_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  n_calls   bigint; n_pay bigint; n_exp bigint;
  n_journal bigint; n_doc bigint; n_closing bigint; n_fundmv bigint;
  onderdelen text[] := ARRAY[]::text[];
BEGIN
  SELECT count(*) INTO n_calls   FROM public.charge_calls          WHERE building_id = p_building_id;
  SELECT count(*) INTO n_pay     FROM public.payments              WHERE building_id = p_building_id;
  SELECT count(*) INTO n_exp     FROM public.expenses              WHERE building_id = p_building_id;
  SELECT count(*) INTO n_journal FROM public.journal_entries       WHERE building_id = p_building_id;
  SELECT count(*) INTO n_closing FROM public.fiscal_year_closings  WHERE building_id = p_building_id;

  -- Concepten tellen niet mee; definitief en geannuleerd wel. Exact dezelfde regel als in
  -- fn_fy_history_summary, zodat de twee tellers niet uiteen kunnen lopen.
  SELECT count(*) INTO n_doc
    FROM public.documents WHERE building_id = p_building_id AND status <> 'concept';

  -- Fondsmutaties hebben geen building_id; ze hangen via het fonds. Hier bewust ZONDER
  -- periodefilter: de vraag is of er ooit geld door dit gebouw is gegaan, niet of het
  -- binnen een specifiek boekjaar viel.
  SELECT count(*) INTO n_fundmv
    FROM public.fund_movements fm
    JOIN public.funds f ON f.id = fm.fund_id
   WHERE f.building_id = p_building_id;

  IF n_calls   > 0 THEN onderdelen := onderdelen || format('%s lastenoproep(en)',   n_calls);   END IF;
  IF n_pay     > 0 THEN onderdelen := onderdelen || format('%s betaling(en)',       n_pay);     END IF;
  IF n_exp     > 0 THEN onderdelen := onderdelen || format('%s uitgave(n)',         n_exp);     END IF;
  IF n_journal > 0 THEN onderdelen := onderdelen || format('%s journaalpost(en)',   n_journal); END IF;
  IF n_closing > 0 THEN onderdelen := onderdelen || format('%s jaarafsluiting(en)', n_closing); END IF;
  IF n_doc     > 0 THEN onderdelen := onderdelen || format('%s document(en)',       n_doc);     END IF;
  IF n_fundmv  > 0 THEN onderdelen := onderdelen || format('%s fondsmutatie(s)',    n_fundmv);  END IF;

  IF array_length(onderdelen, 1) IS NULL THEN RETURN NULL; END IF;
  RETURN array_to_string(onderdelen, ', ');
END $fn$;

COMMENT ON FUNCTION public.fn_building_direct_history_summary(uuid) IS
  'Retourneert NULL wanneer een gebouw geen financiele historie heeft, anders een leesbare opsomming. Telt rechtstreeks op building_id en is daarmee onafhankelijk van boekjaren. Bewust NIET geteld: units, blocks, ownership, allocation_rules, bank_accounts en compliance_deadlines (stamdata en administratieve termijnen zonder bedragen), en charge_allocations/charge_call_lines/journal_lines (kunnen niet bestaan zonder een geteld ouderrecord).';

-- ==================== 3. betalingen: delete guard (P1-B) =====================
-- Een betaling is een brondocument. Zodra er iets aan hangt is direct verwijderen geen
-- correctie maar het wissen van bewijs terwijl het grootboek de ontvangst blijft boeken.
--
-- LET OP, expliciet gevolg: fn_journal_from_payment maakt bij ELKE INSERT een journaalpost.
-- Daardoor heeft in de praktijk elke betaling meteen financiele historie en is geen enkele
-- betaling nog direct verwijderbaar. Dat is de bedoelde uitkomst van deze regel, geen
-- neveneffect: het alternatief zou zijn de journaalpost mee op te ruimen, en dat is
-- impliciete reparatie bij DELETE. Corrigeren hoort via een storno-/refundflow te lopen.
--
-- BEWUST GEEN escape op `owners`. owners is wel een cascade-ouder van payments, maar heeft
-- zelf geen delete-guard; een escape daarop zou de guard gratis omzeilbaar maken door de
-- eigenaar te verwijderen. Dat is exact de les van de spiegelguard in m21. Gevolg: een
-- eigenaar met betalingen is niet meer direct verwijderbaar. Offboarding blijft werken
-- omdat de organisatiecascade eerst `buildings` opruimt, waarna de escape hieronder vuurt.
CREATE OR REPLACE FUNCTION public.fn_guard_payment_delete_history()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  n_alloc bigint; n_journal bigint; n_bank bigint;
  onderdelen text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
  OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  -- Vergrendel de betalingsrij voordat er wordt geteld. Zonder dit slot leest de teller op
  -- READ COMMITTED een oudere snapshot en kan een gelijktijdige INSERT van een
  -- payment_allocation alsnog worden weggecascadeerd. Zie de TOCTOU-notitie bij de
  -- boekjaar- en gebouwguard verderop.
  PERFORM 1 FROM public.payments WHERE id = OLD.id FOR UPDATE;

  SELECT count(*) INTO n_alloc   FROM public.payment_allocations WHERE payment_id = OLD.id;
  SELECT count(*) INTO n_journal FROM public.journal_entries
   WHERE source = 'payment' AND source_id = OLD.id;
  SELECT count(*) INTO n_bank    FROM public.bank_transactions   WHERE matched_payment_id = OLD.id;

  IF n_alloc   > 0 THEN onderdelen := onderdelen || format('%s toewijzing(en)',     n_alloc);   END IF;
  IF n_journal > 0 THEN onderdelen := onderdelen || format('%s journaalpost(en)',   n_journal); END IF;
  IF n_bank    > 0 THEN onderdelen := onderdelen || format('%s bankkoppeling(en)',  n_bank);    END IF;

  IF array_length(onderdelen, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'PAYMENT_HAS_FINANCIAL_HISTORY: deze betaling heeft financiele historie (%) en kan niet worden verwijderd. Boek een correctie of storno in plaats van te wissen.',
      array_to_string(onderdelen, ', ') USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS trig_00_payment_delete_history ON public.payments;
CREATE TRIGGER trig_00_payment_delete_history BEFORE DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_payment_delete_history();

-- ================ 4. jaarafsluiting: delete guard (P1-C) =====================
-- UPDATE was al onvoorwaardelijk geblokkeerd door fn_guard_fy_closing_immutable met als
-- reden "audit trail". DELETE stond volledig open. Dat is nu symmetrisch: zolang het
-- boekjaar bestaat is de afsluiting onaanraakbaar; verdwijnt het boekjaar via de
-- toegestane cascade, dan mag de afsluiting mee.
CREATE OR REPLACE FUNCTION public.fn_guard_fy_closing_delete()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  -- Escape op alle drie de cascade-ouders. fiscal_years is het normale pad; building en
  -- organization staan erbij omdat fyc_building_org_fk alleen org-breed is en het schema
  -- daarmee een afsluiting toestaat waarvan het gebouw afwijkt van dat van het boekjaar.
  IF NOT EXISTS (SELECT 1 FROM public.fiscal_years  WHERE id = OLD.fiscal_year_id)
  OR NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
  OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'FISCAL_YEAR_CLOSING_IMMUTABLE: een vastgelegde jaarafsluiting is auditdata en kan niet worden verwijderd zolang het boekjaar bestaat. Heropen het boekjaar als een correctie nodig is.'
    USING ERRCODE = '23514';
END $fn$;

DROP TRIGGER IF EXISTS trig_00_fyc_delete_immutable ON public.fiscal_year_closings;
CREATE TRIGGER trig_00_fyc_delete_immutable BEFORE DELETE ON public.fiscal_year_closings
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fy_closing_delete();

-- ============ 5. gebouwguard verbreed + rijvergrendeling (P1-D) ==============
-- Twee wijzigingen ten opzichte van m21:
--   (1) de per-boekjaar-lus met fn_fy_history_summary is vervangen door een goedkope
--       gesloten-jaar-check plus fn_building_direct_history_summary. Dat is strikt breder
--       (vangt nu ook geld zonder boekjaar) en goedkoper;
--   (2) expliciete rijvergrendeling voor het tellen.
CREATE OR REPLACE FUNCTION public.fn_guard_building_delete_history()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_jaar int; v_hist text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  PERFORM 1 FROM public.buildings WHERE id = OLD.id FOR UPDATE;

  SELECT fy.year INTO v_jaar
    FROM public.fiscal_years fy
   WHERE fy.building_id = OLD.id AND fy.status = 'closed'
   ORDER BY fy.year
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'BUILDING_HAS_FINANCIAL_HISTORY: dit gebouw heeft een afgesloten boekjaar (%) en kan niet worden verwijderd.',
      v_jaar USING ERRCODE = '23514';
  END IF;

  v_hist := public.fn_building_direct_history_summary(OLD.id);
  IF v_hist IS NOT NULL THEN
    RAISE EXCEPTION
      'BUILDING_HAS_FINANCIAL_HISTORY: dit gebouw heeft financiele historie (%) en kan niet worden verwijderd.',
      v_hist USING ERRCODE = '23514';
  END IF;

  RETURN OLD;
END $fn$;

-- ============== 6. boekjaarguard: rijvergrendeling (TOCTOU) ==================
-- De m21-review stelde analytisch een race vast en dat klopt met de locksemantiek van
-- PostgreSQL: een BEFORE ROW-trigger draait VOOR het verwerven van de tuple-lock. Zonder
-- eigen slot telt de guard op READ COMMITTED nul kinderen, blokkeert daarna op de FOR KEY
-- SHARE-lock die de gelijktijdige INSERT op de boekjaarrij houdt, en gaat na diens commit
-- alsnog verder zonder de trigger opnieuw te vuren. De cascade wist dan zojuist vastgelegde
-- financiele data.
--
-- FOR UPDATE bovenaan sluit dat venster: het slot conflicteert met FOR KEY SHARE, dus de
-- verwijderaar wacht VOOR de telling en ziet na afloop de nieuwe rij. Bewust een gewone
-- rij-lock en geen advisory lock: het gaat om precies deze rij en de lock hoort bij de
-- transactie.
--
-- Het slot staat NA de escape, zodat cascadepaden geen onnodige locks nemen.
CREATE OR REPLACE FUNCTION public.fn_guard_fy_delete_history()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_hist text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
  OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  PERFORM 1 FROM public.fiscal_years WHERE id = OLD.id FOR UPDATE;

  v_hist := public.fn_fy_history_summary(OLD.id);
  IF v_hist IS NOT NULL THEN
    RAISE EXCEPTION
      'FY_HAS_FINANCIAL_HISTORY: boekjaar % heeft financiele historie (%) en kan niet worden verwijderd. Trek de onderliggende posten eerst in, of sluit het boekjaar af.',
      OLD.year, v_hist USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

-- ============ 7. closed-fy guards: parent-cascade escapes (P2-F) =============
-- Deze vijf guards misten de escape die m18/m19/m21 wel kregen. Dat het vandaag toch goed
-- gaat komt doordat de interne RI-trigger van fiscal_years op zowel organizations als
-- buildings VOOR die van charge_calls, charge_allocations, payment_allocations,
-- journal_lines en fund_movements staat: het boekjaar is dan al weg en fn_assert_fy_open
-- returnt stil op een onvindbaar jaar.
--
-- Die volgorde volgt uit de aanmaakvolgorde van de foreign keys en staat nergens vast.
-- Wordt fiscal_years_organization_id_fkey ooit gedropt en opnieuw aangemaakt (routine bij
-- het wijzigen van een delete-regel), dan schuift hij naar achteren en deadlockt de
-- offboarding van elke organisatie die ooit een boekjaar heeft afgesloten. Met een
-- expliciete escape is cascade-correctheid niet langer afhankelijk van die volgorde.
--
-- pg_temp wordt hier meteen aan het search_path toegevoegd; alle relatieverwijzingen in
-- deze functies waren al public-gekwalificeerd.
CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_charge_calls()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.fiscal_years  WHERE id = OLD.fiscal_year_id)
    OR NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'verwijderen van een lastenoproep');
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.fn_assert_fy_open(OLD.fiscal_year_id, 'wijzigen van een lastenoproep');
  END IF;
  PERFORM public.fn_assert_fy_open(NEW.fiscal_year_id, 'aanmaken of wijzigen van een lastenoproep');
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_charge_allocations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_fy uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.charge_calls  WHERE id = OLD.charge_call_id)
    OR NOT EXISTS (SELECT 1 FROM public.buildings     WHERE id = OLD.building_id)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    SELECT cc.fiscal_year_id INTO v_fy FROM public.charge_calls cc WHERE cc.id = OLD.charge_call_id;
    PERFORM public.fn_assert_fy_open(v_fy, 'verwijderen van een vastgestelde verdeelregel');
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT cc.fiscal_year_id INTO v_fy FROM public.charge_calls cc WHERE cc.id = NEW.charge_call_id;
    PERFORM public.fn_assert_fy_open(v_fy, 'toevoegen van een verdeelregel');
    RETURN NEW;
  END IF;

  IF NEW.amount          IS DISTINCT FROM OLD.amount
  OR NEW.charge_call_id  IS DISTINCT FROM OLD.charge_call_id
  OR NEW.unit_id         IS DISTINCT FROM OLD.unit_id
  OR NEW.owner_id        IS DISTINCT FROM OLD.owner_id
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    SELECT cc.fiscal_year_id INTO v_fy FROM public.charge_calls cc WHERE cc.id = NEW.charge_call_id;
    PERFORM public.fn_assert_fy_open(v_fy, 'wijzigen van een vastgestelde verdeelregel');
  END IF;

  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_payment_allocations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_fy uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.payments           WHERE id = OLD.payment_id)
    OR NOT EXISTS (SELECT 1 FROM public.charge_allocations WHERE id = OLD.charge_allocation_id)
    OR NOT EXISTS (SELECT 1 FROM public.organizations      WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  SELECT cc.fiscal_year_id INTO v_fy
    FROM public.charge_allocations ca
    JOIN public.charge_calls cc ON cc.id = ca.charge_call_id
   WHERE ca.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.charge_allocation_id
                      ELSE NEW.charge_allocation_id END;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.fn_assert_fy_open(v_fy, 'terugdraaien van een betalingstoewijzing');
    RETURN OLD;
  END IF;

  PERFORM public.fn_assert_fy_open(v_fy, 'wijzigen van een betalingstoewijzing');
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_journal_lines()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_fy uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE id = OLD.journal_entry_id)
    OR NOT EXISTS (SELECT 1 FROM public.organizations   WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    SELECT je.fiscal_year_id INTO v_fy FROM public.journal_entries je WHERE je.id = OLD.journal_entry_id;
    PERFORM public.fn_assert_fy_open(v_fy, 'verwijderen van een journaalregel');
    RETURN OLD;
  END IF;
  SELECT je.fiscal_year_id INTO v_fy FROM public.journal_entries je WHERE je.id = NEW.journal_entry_id;
  PERFORM public.fn_assert_fy_open(v_fy, 'aanmaken of wijzigen van een journaalregel');
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_guard_closed_fy_fund_movements()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_fund uuid;
  v_date date;
  v_fy   uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.funds         WHERE id = OLD.fund_id)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    v_fund := OLD.fund_id; v_date := OLD.movement_date;
  ELSE
    v_fund := NEW.fund_id; v_date := NEW.movement_date;
  END IF;

  SELECT fy.id INTO v_fy
    FROM public.funds f
    JOIN public.fiscal_years fy ON fy.building_id = f.building_id
   WHERE f.id = v_fund
     AND v_date BETWEEN fy.start_date AND fy.end_date
   LIMIT 1;

  PERFORM public.fn_assert_fy_open(v_fy, 'boeken of wijzigen van een fondsmutatie');

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;

-- ================== 8. documenten: onveranderlijkheid (P2-H) =================
-- Zodra een document de conceptfase verlaat is het bewijsmateriaal met een extern
-- verifieerbaar nummer. Terugzetten naar 'concept' haalde het uit de historietelling en
-- ontsloot zo het boekjaar; dat is de bewezen bypass.
--
-- Vastgezet: de statusrichting (nooit terug naar concept), verification_number, de drie
-- koppelingen (fiscal_year_id, building_id, organization_id), het documenttype, en de
-- integriteitsankers content_hash en pdf_url - die laatste twee alleen wanneer ze al
-- gevuld zijn, zodat een PDF die na afronding wordt gegenereerd nog ingevuld mag worden.
-- Bewust vrij gelaten: title en meta, dat is presentatie en annotatie.
-- definitief -> geannuleerd blijft toegestaan: geannuleerd telt nog steeds als historie,
-- dus die route opent geen bypass.
CREATE OR REPLACE FUNCTION public.fn_guard_document_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF OLD.status = 'concept' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'concept' THEN
    RAISE EXCEPTION
      'DOCUMENT_IMMUTABLE: een vastgelegd document (%) kan niet worden teruggezet naar concept.',
      OLD.verification_number USING ERRCODE = '23514';
  END IF;

  IF NEW.verification_number IS DISTINCT FROM OLD.verification_number
  OR NEW.fiscal_year_id      IS DISTINCT FROM OLD.fiscal_year_id
  OR NEW.building_id         IS DISTINCT FROM OLD.building_id
  OR NEW.organization_id     IS DISTINCT FROM OLD.organization_id
  OR NEW.document_type_id    IS DISTINCT FROM OLD.document_type_id
  OR (OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash)
  OR (OLD.pdf_url      IS NOT NULL AND NEW.pdf_url      IS DISTINCT FROM OLD.pdf_url) THEN
    RAISE EXCEPTION
      'DOCUMENT_IMMUTABLE: nummer, koppeling, type en inhoud van een vastgelegd document (%) liggen vast.',
      OLD.verification_number USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trig_00_document_immutable ON public.documents;
CREATE TRIGGER trig_00_document_immutable BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_document_immutable();

-- ============ 9. uitgaven: boekjaarkoppeling vastzetten (P2-I) ===============
-- Twee routes, met verschillende oorzaken.
--
-- (a) LOSKOPPELEN OF VERPLAATSEN. fn_journal_from_expense draait AFTER INSERT en zet
--     journal_entries.fiscal_year_id vast op het jaar van dat moment. journal_entries kan
--     daarna niet mee (RLS: UPDATE en DELETE staan op USING (false) voor authenticated).
--     Het boekjaar van de uitgave losmaken of verplaatsen laat uitgave en journaalpost dus
--     gegarandeerd uiteenlopen, en haalt de uitgave permanent uit de afsluitbescherming.
--
-- (b) LATE TOEWIJZING. fn_journal_from_expense is AFTER INSERT ONLY en keert bovendien
--     meteen terug wanneer fiscal_year_id NULL is. Een uitgave die pas via UPDATE aan een
--     boekjaar wordt gekoppeld krijgt daardoor NOOIT een journaalpost: het bedrag zit dan
--     wel in het boekjaar maar niet in het grootboek. Dat is een bestaande integriteitsfout
--     en niet alleen een bypass. De veiligste minimale regel is die UPDATE te weigeren; de
--     werkroute is de uitgave verwijderen (mag, het jaar is open) en opnieuw invoeren MET
--     boekjaar, wat wel een correcte journaalpost oplevert. Alsnog journaliseren bij UPDATE
--     zou impliciete reparatie zijn en valt buiten deze ronde.
CREATE OR REPLACE FUNCTION public.fn_guard_expense_fy_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.fiscal_year_id IS NOT DISTINCT FROM OLD.fiscal_year_id THEN
    RETURN NEW;
  END IF;

  IF OLD.fiscal_year_id IS NOT NULL THEN
    RAISE EXCEPTION
      'EXPENSE_FY_IMMUTABLE: het boekjaar van een geboekte uitgave ligt vast; de journaalpost kan niet meeverhuizen. Trek de uitgave in en boek hem opnieuw.'
      USING ERRCODE = '23514';
  END IF;

  RAISE EXCEPTION
    'EXPENSE_FY_LATE_ASSIGNMENT: een uitgave zonder boekjaar kan niet achteraf worden gekoppeld, omdat er dan geen journaalpost ontstaat. Verwijder de uitgave en boek hem opnieuw met boekjaar.'
    USING ERRCODE = '23514';
END $fn$;

DROP TRIGGER IF EXISTS trig_00_exp_fy_immutable ON public.expenses;
CREATE TRIGGER trig_00_exp_fy_immutable BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_expense_fy_immutable();

-- ==================== 10. is_org_member hardening (P2-E) =====================
-- Twee wijzigingen, beide strikt niet-brekend:
--   * `from memberships` wordt `from public.memberships`;
--   * pg_temp komt expliciet ACHTERAAN in het search_path.
-- Staat pg_temp niet in het pad, dan doorzoekt PostgreSQL het als eerste voor relatienamen,
-- nog voor pg_catalog. Een sessie die een tijdelijke tabel `memberships` kan aanmaken zou
-- daarmee de SELECT-zijde van alle policies die deze functie dragen kunnen openzetten.
-- Grants blijven ongewijzigd: authenticated MOET deze functie kunnen uitvoeren, anders
-- breken de policies.
CREATE OR REPLACE FUNCTION public.is_org_member(org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = org and m.user_id = auth.uid()
  );
$fn$;

-- ============================== rechten =====================================
-- De nieuwe guards zijn triggerfuncties en tellers; geen daarvan hoort als RPC-endpoint
-- te bestaan. is_org_member staat hier bewust NIET tussen.
REVOKE ALL ON FUNCTION public.fn_building_direct_history_summary(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_payment_delete_history()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_fy_closing_delete()             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_document_immutable()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_expense_fy_immutable()          FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- m31 — `charge_calls.call_date` moet binnen zijn boekjaar liggen
-- ============================================================================
--
-- DE INVARIANT
--
--     fiscal_year.start_date <= charge_call.call_date <= fiscal_year.end_date
--
-- Beide grenzen zijn INCLUSIEF.
--
-- ── WAAROM DIT NODIG IS ────────────────────────────────────────────────────
--
-- Tot nu toe was de koppeling tussen een lastenoproep en zijn boekjaar puur
-- relationeel en statusgedreven, nooit temporeel. `create_charge_call` haalt
-- `start_date`/`end_date` niet eens op: die kolommen komen in de hele functie
-- niet in scope (m15, m17 en m20 bevatten die woorden nul keer). De enige
-- boekjaarpoort was `IF v_fy_status = 'closed'`, en een status is geen
-- periode. Een oproep met `call_date` 1999-01-01 in een open boekjaar 2026
-- werd dus zonder protest vastgelegd.
--
-- Dat is niet cosmetisch. `call_date` wordt in dezelfde transactie de
-- `entry_date` van de journaalpost (m20 sectie 14), zodat het journaal een
-- 4111/7011-boeking krijgt die qua datum buiten het jaar valt waarin hij
-- geboekt staat. En de fout is onherstelbaar: `fn_guard_cc_immutable` (m16)
-- bevriest `call_date` bij de eerste UPDATE-poging, terwijl intrekken wordt
-- geweigerd zodra er betalingskoppelingen hangen (`ALLOC_CALL_PAID`, m16).
--
-- ── WAAROM TWEE TRIGGERS EN GEEN CHECK ─────────────────────────────────────
--
-- Een CHECK-constraint kan geen andere tabel lezen; de grenzen staan op
-- `fiscal_years`. Een controle binnen `create_charge_call` alleen is
-- aantoonbaar onvoldoende, om twee onafhankelijke redenen:
--
--   1. DE RPC IS NIET HET ENIGE SCHRIJFPAD. RLS zet directe INSERT/UPDATE dicht
--      voor `authenticated` (m15: `WITH CHECK (false)`), maar RLS geldt niet
--      voor de tabeleigenaar, voor superusers of voor een rol met BYPASSRLS
--      zoals `service_role`. Een trigger geldt wel voor al die rollen.
--   2. DE GRENZEN KUNNEN LATER VERSCHUIVEN. `fn_guard_fiscal_year_immutable`
--      (m21) bevriest de periode alleen bij een GESLOTEN boekjaar. Bij een
--      open boekjaar kon `start_date`/`end_date` vrij worden versmald, waarmee
--      een bestaande, correcte oproep alsnog buiten zijn periode belandt.
--
-- Vandaar precies twee triggers: een op de kindkant (elke schrijfactie op een
-- oproep) en een op de ouderkant (elke periodewijziging van een boekjaar).
-- Samen sluiten ze de invariant in beide richtingen, ongeacht welke rol of
-- welk pad de schrijfactie doet.
--
-- ── WAAROM EEN RIJVERGRENDELING NODIG IS ───────────────────────────────────
--
-- Twee BEFORE-triggers in dezelfde transactie zijn NIET vanzelf racevrij. Dat
-- is atomiciteit, geen serialisatie. Onder READ COMMITTED leest een gewone
-- SELECT uit de andere tabel alleen wat op dat moment ZICHTBAAR is, en dat
-- laat klassieke write skew toe:
--
--   T1  INSERT oproep 2026-06-15   -> kindtrigger leest periode 04-01..09-30,
--                                     keurt goed, transactie blijft open
--   T2  UPDATE boekjaar start=07-01 -> oudertrigger telt oproepen buiten de
--                                     nieuwe periode; T1 is nog niet gecommit
--                                     en dus ONZICHTBAAR, telling 0, goedgekeurd
--   beide COMMIT                    -> een oproep van 15 juni in een boekjaar
--                                     dat op 1 juli begint
--
-- Dit is geen theoretisch scenario: de concurrentiesuite reproduceerde het
-- vijf van de vijf keer, in beide volgordes, met een aantoonbaar geschonden
-- invariant achteraf.
--
-- De oplossing is EEN CONSISTENTE LOCKVOLGORDE per `fiscal_year_id`: elk pad
-- vergrendelt eerst de boekjaarrij, en pas daarna wordt er geteld of
-- geschreven.
--
--   kindkant   `SELECT ... FOR SHARE` op de boekjaarrij;
--   ouderkant  `SELECT ... FOR NO KEY UPDATE` op de eigen rij, EXPLICIET in de
--              trigger, want een BEFORE UPDATE-trigger draait vóórdat de
--              UPDATE zelf de rij vergrendelt. Zonder die expliciete lock telt
--              de oudertrigger nog steeds tegen een oude snapshot.
--
-- FOR SHARE is de zwakste modus die met FOR NO KEY UPDATE conflicteert; FOR
-- KEY SHARE zou te zwak zijn. Twee gelijktijdige oproepen op hetzelfde
-- boekjaar houden elkaar dus NIET op (FOR SHARE conflicteert niet met zichzelf),
-- en verschillende boekjaren raken elkaar helemaal niet: de lock is per rij,
-- niet per tabel.
--
-- Na het wachten krijgt het volgende statement in de triggerfunctie een VERSE
-- snapshot, zodat de zojuist gecommitte tegenpartij wel degelijk wordt gezien.
-- De lockvolgorde is overal dezelfde (eerst `fiscal_years`, dan
-- `charge_calls`), dus er ontstaat geen deadlock door tegengestelde volgorde.
--
-- ── WAT DEZE MIGRATIE UITDRUKKELIJK NIET DOET ──────────────────────────────
--
-- Geen bestaande migratie wordt aangeraakt. `create_charge_call` blijft
-- byte-identiek: de invariant hoort in de database, niet in een kopie van een
-- grote functie. Bestaande data wordt niet gerepareerd, niet verplaatst en
-- niet verwijderd; de preflight breekt af en laat de beslissing aan een mens.
-- ============================================================================

-- ── 1. PREFLIGHT ───────────────────────────────────────────────────────────
--
-- Fail-closed: bestaat er al een oproep buiten zijn boekjaar, dan wordt deze
-- migratie NIET toegepast. Anders zou de invariant vanaf nu gelden terwijl de
-- historie hem stil blijft schenden.
--
-- De uitzondering draagt uitsluitend een AANTAL. Geen id's, geen datums, geen
-- bedragen, geen namen: een migratielog is geen plek voor rijinhoud.
DO $preflight$
DECLARE
  v_aantal bigint;
BEGIN
  -- LEFT JOIN en expliciete NULL-takken, want NULL is hier geen "onbekend maar
  -- waarschijnlijk goed": `NULL < date` is NULL, en een IF op NULL wordt niet
  -- genomen. Zonder deze takken zou een rij zonder datum of zonder leesbaar
  -- boekjaar stil door de preflight glippen en daarna nooit meer worden
  -- getoetst. In dit schema hoort geen van deze gevallen voor te komen; dat is
  -- juist de reden om ze te tellen in plaats van te negeren.
  SELECT count(*) INTO v_aantal
    FROM public.charge_calls cc
    LEFT JOIN public.fiscal_years fy ON fy.id = cc.fiscal_year_id
   WHERE cc.fiscal_year_id IS NULL
      OR fy.id             IS NULL
      OR cc.call_date      IS NULL
      OR fy.start_date     IS NULL
      OR fy.end_date       IS NULL
      OR cc.call_date < fy.start_date
      OR cc.call_date > fy.end_date;

  IF v_aantal > 0 THEN
    RAISE EXCEPTION
      'M31_PREFLIGHT_FAILED: % lastenoproep(en) liggen buiten de periode van hun boekjaar; corrigeer die eerst handmatig',
      v_aantal
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;

-- ── 2. KINDKANT: elke schrijfactie op een lastenoproep ─────────────────────
--
-- SECURITY DEFINER omdat de trigger `fiscal_years` moet kunnen lezen, ook
-- wanneer RLS die rij voor de schrijvende rol zou verbergen. Zonder dat zou de
-- controle fail-OPEN worden precies bij de rol die hem het hardst nodig heeft.
CREATE OR REPLACE FUNCTION public.fn_guard_cc_date_in_fy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_start date;
  v_einde date;
BEGIN
  -- FOR SHARE vergrendelt de boekjaarrij. Twee dingen tegelijk: een
  -- gelijktijdige periodewijziging moet wachten tot deze transactie klaar is,
  -- en als die wijziging er al was, volgt deze SELECT de update-keten en leest
  -- hij de NIEUWE grenzen in plaats van de verouderde.
  SELECT fy.start_date, fy.end_date
    INTO v_start, v_einde
    FROM public.fiscal_years fy
   WHERE fy.id = NEW.fiscal_year_id
     FOR SHARE;

  -- Geen boekjaar gevonden betekent dat we de grenzen niet kennen. De FK
  -- hoort dat al onmogelijk te maken; komt het toch voor, dan weigeren we.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'ALLOC_CALL_DATE_OUTSIDE_FY: boekjaar van de lastenoproep is niet leesbaar'
      USING ERRCODE = '23514';
  END IF;

  -- NULL is hier geen geldige toestand. `NULL < date` levert NULL op, en een
  -- IF op NULL wordt NIET genomen: zonder deze tak zou een oproep zonder datum
  -- of een boekjaar zonder grenzen de invariant stil passeren. Geen van de drie
  -- kolommen hoort NULL te zijn, maar de keten legt dat nergens vast (m1-m5
  -- zijn lege plaatshouders), dus wordt het hier fail-closed afgehandeld.
  IF NEW.call_date IS NULL OR v_start IS NULL OR v_einde IS NULL THEN
    RAISE EXCEPTION
      'ALLOC_CALL_DATE_OUTSIDE_FY: oproepdatum of boekjaarperiode ontbreekt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.call_date < v_start OR NEW.call_date > v_einde THEN
    RAISE EXCEPTION
      'ALLOC_CALL_DATE_OUTSIDE_FY: oproepdatum valt buiten de periode van het boekjaar'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_guard_cc_date_in_fy() FROM PUBLIC, anon, authenticated;

-- `trig_01_` en niet `trig_00_`: zo blijft de bestaande volgorde intact en
-- houden `trig_00_cc_closed_fy` (afgesloten boekjaar) en `trig_00_cc_immutable`
-- (ALLOC_CALL_IMMUTABLE) hun voorrang. Een poging om `call_date` te wijzigen
-- blijft dus melden dat een vastgelegde oproep onwijzigbaar is, niet dat de
-- datum buiten de periode ligt.
DROP TRIGGER IF EXISTS trig_01_cc_date_in_fy ON public.charge_calls;
CREATE TRIGGER trig_01_cc_date_in_fy
  BEFORE INSERT OR UPDATE ON public.charge_calls
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_cc_date_in_fy();

-- ── 3. OUDERKANT: periodewijziging van een boekjaar ────────────────────────
--
-- Zonder deze helft blijft er een omweg open: leg een geldige oproep vast en
-- versmal daarna de periode van het (open) boekjaar. De kindtrigger ziet dat
-- niet, want er wordt niets op `charge_calls` geschreven.
CREATE OR REPLACE FUNCTION public.fn_guard_fy_period_covers_calls()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_aantal bigint;
BEGIN
  -- Alleen als de periode werkelijk verschuift. Een statuswijziging of een
  -- labelwijziging hoeft geen telling over de oproepen te doen.
  IF NEW.start_date IS NOT DISTINCT FROM OLD.start_date
     AND NEW.end_date IS NOT DISTINCT FROM OLD.end_date THEN
    RETURN NEW;
  END IF;

  -- EXPLICIETE rijvergrendeling, vóór de telling. Een BEFORE UPDATE-trigger
  -- draait voordat de UPDATE zelf de rij vergrendelt; zonder deze regel telt
  -- de trigger tegen een snapshot van vóór een gelijktijdige INSERT en glipt
  -- die er alsnog doorheen. FOR NO KEY UPDATE is dezelfde modus die de UPDATE
  -- straks toch neemt, dus dit is geen zwaardere lock - alleen een eerdere.
  PERFORM 1 FROM public.fiscal_years fy WHERE fy.id = OLD.id FOR NO KEY UPDATE;

  -- Dit statement krijgt een VERSE snapshot, dus een tegenpartij die tijdens
  -- het wachten commit, telt hier wel mee.
  IF NEW.start_date IS NULL OR NEW.end_date IS NULL THEN
    RAISE EXCEPTION
      'ALLOC_CALL_DATE_OUTSIDE_FY: een boekjaar zonder begin- of einddatum kan geen lastenoproepen omvatten'
      USING ERRCODE = '23514';
  END IF;

  -- Ook hier telt een ontbrekende datum als schending; zie de toelichting in
  -- de preflight.
  SELECT count(*) INTO v_aantal
    FROM public.charge_calls cc
   WHERE cc.fiscal_year_id = OLD.id
     AND (cc.call_date IS NULL
          OR cc.call_date < NEW.start_date
          OR cc.call_date > NEW.end_date);

  IF v_aantal > 0 THEN
    RAISE EXCEPTION
      'ALLOC_CALL_DATE_OUTSIDE_FY: de nieuwe periode laat % vastgelegde lastenoproep(en) buiten het boekjaar vallen',
      v_aantal
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_guard_fy_period_covers_calls() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trig_01_fy_period_covers_calls ON public.fiscal_years;
CREATE TRIGGER trig_01_fy_period_covers_calls
  BEFORE UPDATE ON public.fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fy_period_covers_calls();

COMMENT ON FUNCTION public.fn_guard_cc_date_in_fy() IS
  'Bewaakt fiscal_year.start_date <= charge_call.call_date <= fiscal_year.end_date bij elke INSERT of UPDATE op charge_calls, ongeacht schrijfpad of rol. Domeinfoutcode ALLOC_CALL_DATE_OUTSIDE_FY.';
COMMENT ON FUNCTION public.fn_guard_fy_period_covers_calls() IS
  'Weigert een periodewijziging van een boekjaar die bestaande lastenoproepen buiten dat boekjaar zou plaatsen. Domeinfoutcode ALLOC_CALL_DATE_OUTSIDE_FY.';

-- ── 4. POSTCHECK ───────────────────────────────────────────────────────────
-- Fail-closed afsluiting: staan beide triggers er werkelijk, dan pas is de
-- invariant actief. Een stil half toegepaste migratie is hier het gevaar.
DO $postcheck$
BEGIN
  -- Niet alleen de NAAM: een trigger met de juiste naam op de verkeerde tabel,
  -- of met een ontbrekende functie erachter, zou de invariant niet afdwingen.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p  ON p.oid = t.tgfoid
     WHERE t.tgname = 'trig_01_cc_date_in_fy'
       AND c.oid = 'public.charge_calls'::regclass
       AND p.proname = 'fn_guard_cc_date_in_fy'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'M31_POSTCHECK_FAILED: kindtrigger ontbreekt of staat op de verkeerde tabel'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p  ON p.oid = t.tgfoid
     WHERE t.tgname = 'trig_01_fy_period_covers_calls'
       AND c.oid = 'public.fiscal_years'::regclass
       AND p.proname = 'fn_guard_fy_period_covers_calls'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'M31_POSTCHECK_FAILED: oudertrigger ontbreekt of staat op de verkeerde tabel'
      USING ERRCODE = '23514';
  END IF;

  -- En de REVOKE moet werkelijk effect hebben gehad. Een triggerfunctie die
  -- rechtstreeks aanroepbaar is voor `anon` of `authenticated` zou een
  -- zelfstandig privilegepad zijn naast de trigger.
  IF has_function_privilege('anon',          'public.fn_guard_cc_date_in_fy()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.fn_guard_cc_date_in_fy()', 'EXECUTE')
  OR has_function_privilege('anon',          'public.fn_guard_fy_period_covers_calls()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.fn_guard_fy_period_covers_calls()', 'EXECUTE') THEN
    RAISE EXCEPTION 'M31_POSTCHECK_FAILED: een triggerfunctie is rechtstreeks aanroepbaar'
      USING ERRCODE = '23514';
  END IF;
END
$postcheck$;

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
-- welk pad de schrijfactie doet. Racegevoelig is dit niet: beide draaien
-- BEFORE, in dezelfde transactie als de schrijfactie zelf.
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
  SELECT count(*) INTO v_aantal
    FROM public.charge_calls cc
    JOIN public.fiscal_years fy ON fy.id = cc.fiscal_year_id
   WHERE cc.call_date < fy.start_date
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
  SELECT fy.start_date, fy.end_date
    INTO v_start, v_einde
    FROM public.fiscal_years fy
   WHERE fy.id = NEW.fiscal_year_id;

  -- Geen boekjaar gevonden betekent dat we de grenzen niet kennen. De FK
  -- hoort dat al onmogelijk te maken; komt het toch voor, dan weigeren we.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'ALLOC_CALL_DATE_OUTSIDE_FY: boekjaar van de lastenoproep is niet leesbaar'
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

  SELECT count(*) INTO v_aantal
    FROM public.charge_calls cc
   WHERE cc.fiscal_year_id = OLD.id
     AND (cc.call_date < NEW.start_date OR cc.call_date > NEW.end_date);

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
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trig_01_cc_date_in_fy')
  OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trig_01_fy_period_covers_calls') THEN
    RAISE EXCEPTION 'M31_POSTCHECK_FAILED: niet beide triggers zijn aangemaakt'
      USING ERRCODE = '23514';
  END IF;
END
$postcheck$;

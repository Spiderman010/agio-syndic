-- m29 — een gebruiker verwijderen zonder de jaarafsluiting te verliezen
--
-- HET DEFECT (pre-existent sinds m9, bewezen vóór deze migratie)
-- fiscal_year_closings.closed_by is `REFERENCES auth.users(id) ON DELETE SET NULL`.
-- PostgreSQL voert die RI-actie uit als een UPDATE op de kindrij. De guard
-- fn_guard_fy_closing_immutable weigerde ELKE UPDATE onvoorwaardelijk — geen
-- TG_OP-check, geen escape, geen uitzondering. Gevolg:
--
--     DELETE FROM auth.users WHERE id = <iemand die ooit afsloot>
--     ERROR: Een vastgelegde jaarafsluiting is onwijzigbaar (audit trail)
--
-- Dat is precies het statement dat Supabase GoTrue's admin deleteUser uitvoert.
-- Het offboarden van een vertrokken manager en elk AVG-verwijderverzoek liepen
-- daarmee hard vast op de database. Gereproduceerd met een rollback-probe: de
-- DELETE faalde en de gebruiker bestond daarna nog.
--
-- Dit is de spiegel van de fout die m28 al voor financial_reversals.created_by
-- sloot. Zelfde oorzaak, zelfde vorm, zelfde oplossing.
--
-- ============================ DE OPLOSSING ============================
-- De guard laat exact één overgang toe: closed_by naar NULL, uitsluitend
-- wanneer de gebruiker daadwerkelijk niet meer bestaat, met alle overige
-- kolommen aantoonbaar ongewijzigd.
--
-- WAAROM DIT GEEN ZWAKKE HEURISTIEK IS
-- Er wordt niet geraden WIE de UPDATE doet. `pg_trigger_depth()` zou dat wel
-- doen en bewijst niets: het meet diepte, niet herkomst. Een transactielokale
-- GUC verplaatst het probleem naar "wie kan die GUC zetten". In plaats daarvan
-- wordt gecontroleerd of de enige legitieme OORZAAK zich werkelijk heeft
-- voorgedaan. Dat is sluitend, en wel hierom:
--
--   1. De foreign key is VALIDATED en NIET DEFERRABLE (nagemeten:
--      convalidated=true, condeferrable=false). Daaruit volgt de invariant:
--      een non-null closed_by verwijst ALTIJD naar een bestaande auth.users-rij.
--      Nagemeten op productie: 0 rijen met een non-null closed_by zonder
--      bijbehorende gebruiker.
--   2. `NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.closed_by)` kan
--      daardoor alleen waar zijn BINNEN het cascadevenster: de ouderrij is in
--      dezelfde transactie net verwijderd en de kind-UPDATE is nog niet klaar.
--      Buiten dat venster is de conditie per definitie onwaar.
--   3. Een client kan dat venster niet zelf maken. Nagemeten: `authenticated`
--      en `anon` hebben GEEN DELETE en zelfs geen SELECT op auth.users.
--
-- Daarmee is de uitzondering niet "een aanroeper die we vertrouwen" maar
-- "een toestand die alleen door de legitieme cascade kan ontstaan".
--
-- WAT ER NIET VERANDERT
--  * De foreign key blijft ON DELETE SET NULL. Optie B (RESTRICT plus een
--    aparte offboardingflow) is afgewogen en afgewezen: het zou een nieuwe
--    schrijfroute op auditdata introduceren en user deletion afhankelijk maken
--    van applicatiecode, terwijl de database het nu zelf afdwingt.
--  * Elke andere UPDATE blijft onvoorwaardelijk geweigerd, inclusief een
--    handmatige `SET closed_by = NULL` — die faalt op conditie 2 hierboven,
--    omdat de gebruiker dan nog bestaat.
--  * De foutmelding blijft WOORDELIJK gelijk, zodat bestaande tests en
--    bestaande UI-teksten niet verschuiven.
--  * DELETE op fiscal_year_closings blijft geregeld door
--    fn_guard_fy_closing_delete (m22), met zijn parent-cascade-escapes. Die
--    functie wordt hier niet aangeraakt.
--  * RLS, grants en tenantgedrag blijven ongewijzigd.
--  * Bestaande closing-data wordt niet herschreven. Op productie bestaan
--    vandaag 0 afsluitbewijzen, dus er is ook niets te migreren.
--
-- pg_temp komt expliciet achteraan het search_path. Dat is de huisstandaard
-- sinds m22; de oude definitie had alleen 'public'. Alle relatieverwijzingen
-- in deze functie zijn bovendien schemagekwalificeerd.
CREATE OR REPLACE FUNCTION public.fn_guard_fy_closing_immutable()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  -- De enige toegestane wijziging: het anonimiseren van de actor nadat zijn
  -- account is verwijderd. Alle financiële auditvelden moeten identiek blijven.
  IF NEW.closed_by IS NULL
     AND OLD.closed_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.closed_by)
     AND NEW.id              =                    OLD.id
     AND NEW.organization_id =                    OLD.organization_id
     AND NEW.building_id     =                    OLD.building_id
     AND NEW.fiscal_year_id  =                    OLD.fiscal_year_id
     AND NEW.closed_at       =                    OLD.closed_at
     AND NEW.created_at      =                    OLD.created_at
     AND NEW.result_amount   IS NOT DISTINCT FROM OLD.result_amount
     AND NEW.notes           IS NOT DISTINCT FROM OLD.notes THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Een vastgelegde jaarafsluiting is onwijzigbaar (audit trail)'
    USING ERRCODE = '23514';
END $fn$;

COMMENT ON FUNCTION public.fn_guard_fy_closing_immutable() IS
  'Houdt een vastgelegde jaarafsluiting onwijzigbaar. Enige uitzondering: closed_by mag naar NULL wanneer de betreffende auth.users-rij niet meer bestaat, met alle overige kolommen ongewijzigd. Dat is de RI-actie van ON DELETE SET NULL en niets anders; een client kan die toestand niet maken omdat authenticated geen DELETE op auth.users heeft.';

-- Deze triggerfunctie hoort geen RPC-endpoint te zijn.
REVOKE ALL ON FUNCTION public.fn_guard_fy_closing_immutable() FROM PUBLIC, anon, authenticated;

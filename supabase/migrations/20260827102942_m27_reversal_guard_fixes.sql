-- m27 — Financial Reversal Engine: correctie op de immutability-guards + rechten op de views
--
-- ===================== 1. DE BUG, EERLIJK BENOEMD =====================
-- fn_guard_payment_immutable en fn_guard_expense_immutable uit m25 bouwden hun lijst van
-- gewijzigde velden op met een ONGETYPEERD stringliteral:
--
--     velden := velden || 'bedrag';        -- fout
--
-- Een kaal literal heeft in PostgreSQL type "unknown". Bij operatorresolutie kiest PostgreSQL
-- dan `anyarray || anyarray` boven `anyarray || anyelement`, probeert 'bedrag' als array-literal
-- te lezen, en werpt:
--
--     malformed array literal: "bedrag"
--
-- GEVOLG, en dat was ernstiger dan een lelijke foutmelding: de guard faalde op de EERSTE regel
-- van het veldenblok, dus VOOR de controle of er uberhaupt een journaalpost bestaat. Daardoor
--   * gaf een geblokkeerde wijziging niet PAYMENT_IMMUTABLE maar een onbegrijpelijke fout, en
--   * werd een volstrekt LEGITIEME wijziging - het bedrag van een uitgave zonder journaalpost -
--     ook geweigerd. De guard was strenger dan bedoeld en tegelijk onbruikbaar.
--
-- Bewezen door de testsuite: A11, A12, A14 en A15 gaven de arrayfout in plaats van de bedoelde
-- melding, en A16 (uitgave zonder journaalpost blijft bewerkbaar) faalde volledig. Vijf van de
-- zeventig tests. Na deze migratie zijn alle zeventig groen.
--
-- m22 loopt hier niet tegenaan omdat het `onderdelen || format('%s ...', n)` gebruikt: format()
-- geeft al text terug, dus daar is de operatorkeuze niet ambigu. Dat verschil is precies de val.
--
-- De fix is de expliciete ::text-cast. De rest van beide functies is ongewijzigd.

CREATE OR REPLACE FUNCTION public.fn_guard_payment_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE velden text[] := ARRAY[]::text[];
BEGIN
  IF NEW.amount      IS DISTINCT FROM OLD.amount      THEN velden := velden || 'bedrag'::text;      END IF;
  IF NEW.owner_id    IS DISTINCT FROM OLD.owner_id    THEN velden := velden || 'eigenaar'::text;    END IF;
  IF NEW.building_id IS DISTINCT FROM OLD.building_id THEN velden := velden || 'gebouw'::text;      END IF;
  IF NEW.value_date  IS DISTINCT FROM OLD.value_date  THEN velden := velden || 'valutadatum'::text; END IF;
  IF NEW.method      IS DISTINCT FROM OLD.method      THEN velden := velden || 'betaalwijze'::text; END IF;

  IF array_length(velden, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.journal_entries
                  WHERE source = 'payment' AND source_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'PAYMENT_IMMUTABLE: % van een geboekte betaling ligt vast. Gebruik correct_payment() zodat de wijziging via een storno en een nieuwe betaling traceerbaar wordt.',
    array_to_string(velden, ', ') USING ERRCODE = '23514';
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_guard_expense_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE velden text[] := ARRAY[]::text[];
BEGIN
  IF NEW.amount       IS DISTINCT FROM OLD.amount       THEN velden := velden || 'bedrag'::text;            END IF;
  IF NEW.account_id   IS DISTINCT FROM OLD.account_id   THEN velden := velden || 'grootboekrekening'::text; END IF;
  IF NEW.category_id  IS DISTINCT FROM OLD.category_id  THEN velden := velden || 'categorie'::text;         END IF;
  IF NEW.expense_date IS DISTINCT FROM OLD.expense_date THEN velden := velden || 'uitgavedatum'::text;      END IF;
  IF NEW.building_id  IS DISTINCT FROM OLD.building_id  THEN velden := velden || 'gebouw'::text;            END IF;

  IF array_length(velden, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.journal_entries
                  WHERE source = 'expense' AND source_id = OLD.id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'EXPENSE_IMMUTABLE: % van een geboekte uitgave ligt vast. Gebruik correct_expense() zodat de wijziging via een storno en een nieuwe uitgave traceerbaar wordt.',
    array_to_string(velden, ', ') USING ERRCODE = '23514';
END $fn$;

REVOKE ALL ON FUNCTION public.fn_guard_payment_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_expense_immutable() FROM PUBLIC, anon, authenticated;

-- ================= 2. schrijfrechten op de nieuwe views intrekken =================
-- Nieuwe views erven de default-ACL van postgres in schema public en kregen daardoor
-- INSERT/UPDATE/DELETE voor authenticated. Beide views zijn NIET auto-updatable - ze hebben
-- meerdere basisrelaties, en information_schema.views bevestigt is_insertable_into = NO - dus
-- die rechten zijn vandaag onbruikbaar. Ze worden toch ingetrokken, om dezelfde reden waarom
-- m23 TRIGGER en REFERENCES introk: een recht dat niemand nodig heeft hoort niet uitgedeeld te
-- zijn, en "vandaag onbruikbaar" is geen garantie voor morgen.
--
-- De twee bestaande views (v_allocation_integrity, v_reconciliation_4111) dragen dezelfde
-- overbodige grants. Die blijven hier BEWUST ongemoeid: ze vallen buiten de scope van de
-- reversal-engine en horen in een eigen opruimronde. Genoteerd in docs/known-issues.md.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.v_settlement_integrity FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.v_financial_reversals  FROM anon, authenticated;
GRANT SELECT ON public.v_settlement_integrity TO authenticated;
GRANT SELECT ON public.v_financial_reversals  TO authenticated;

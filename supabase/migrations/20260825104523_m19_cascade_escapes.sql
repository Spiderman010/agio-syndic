-- m19 — ontbrekende cascade-escapes in twee bestaande guards
--
-- Beide guards stammen uit m9/m11 en zijn hier niet gewijzigd van BEDOELING,
-- alleen van gedrag tijdens een cascade. Ze blokkeerden het verwijderen van een
-- organisatie of van een lastenoproep, omdat ze niet konden zien dat hun eigen
-- ouderrij op dat moment al was verwijderd.
--
-- fn_journal_balance_check had deze escape al; deze twee ontbraken.

-- Een journaalpost die in dezelfde transactie weer is verwijderd (de
-- correctieroute van een lastenoproep doet precies dat) hoeft bij commit niet
-- meer op volledigheid te worden gecontroleerd.
CREATE OR REPLACE FUNCTION public.fn_journal_entry_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE
  v_lines  int;
  v_debit  numeric;
  v_credit numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO v_lines, v_debit, v_credit
    FROM public.journal_lines
   WHERE journal_entry_id = NEW.id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION
      'Journaalpost % heeft % regel(s); minimaal 2 vereist. Controleer het rekeningschema (PCSI).',
      NEW.id, v_lines USING ERRCODE = '23514';
  END IF;

  IF round(v_debit, 2) <> round(v_credit, 2) THEN
    RAISE EXCEPTION
      'Journaalpost % is ongebalanceerd: debet % <> credit %',
      NEW.id, v_debit, v_credit USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $fn$;

-- Een kernrekening mag niet los worden verwijderd, maar moet met de organisatie
-- mee kunnen verdwijnen.
CREATE OR REPLACE FUNCTION public.fn_guard_core_accounts()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE
  v_core text[] := ARRAY['4111','4419','4411','5141','6110','7011'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.code = ANY(v_core) THEN
      RAISE EXCEPTION
        'Kernrekening % van het PCSI-schema kan niet worden verwijderd', OLD.code
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.code = ANY(v_core) AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION
      'De code van kernrekening % kan niet worden gewijzigd', OLD.code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

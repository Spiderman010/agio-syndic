-- m25 — Financial Reversal Engine (Variant C)
--
-- Sluit de laatste FUNCTIONELE P1 uit de reeks m21-m23: er bestond geen gecontroleerde
-- storno-/correctieroute voor betalingen en gejournaliseerde uitgaven. m22 en m23 sloten
-- DELETE af als correctieroute - terecht, wissen is geen correctie - maar lieten daarmee
-- letterlijk geen enkele weg over om een fout te herstellen.
--
-- KERNREGEL
-- Een foutieve financiele transactie wordt NOOIT opgelost door historie te verwijderen of
-- door bestaande financiele feiten stil te overschrijven. Het origineel blijft staan, de
-- correctie is een nieuwe traceerbare gebeurtenis, en subadministratie en grootboek blijven
-- synchroon.
--
-- WAAROM VARIANT C EN GEEN NEGATIEVE RIJEN
-- payments.amount > 0, expenses.amount > 0, payment_allocations.amount > 0 en de strikte
-- debet-XOR-credit op journal_lines zijn de constraints waarop m9 t/m m23 hun bewijzen bouwen.
-- Een storno als negatieve rij zou drie daarvan moeten slopen om een functie toe te voegen.
-- Daarom: alle bedragen blijven positief, de BETEKENIS zit in de tabel waarin ze staan.
--
--   financial_reversals               de auditgebeurtenis (wie, wanneer, waarom, waarheen)
--   payment_allocation_reversals      append-only neutralisatie van elke originele toewijzing
--   journal_entries.source='reversal' de gespiegelde journaalpost in een OPEN boekjaar
--
-- Een gecorrigeerde betaling of uitgave is daarna een doodgewone nieuwe rij. De bestaande
-- FIFO- en journaalmotoren draaien er ongewijzigd overheen; er is GEEN tweede implementatie
-- van de verdeel- of boekingslogica. Dat is de belangrijkste reden voor deze vorm.
--
-- STORNO VAN EEN STORNO IS STRUCTUREEL ONMOGELIJK
-- Een reversal is geen payments- en geen expenses-rij, dus er bestaat geen bron om naar te
-- wijzen. Daarvoor is geen extra constraint nodig; de vorm sluit het uit.
--
-- GRENZEN, eerlijk benoemd
--  * MVP: alleen VOLLEDIGE storno. Gedeeltelijk terugdraaien van een toewijzing bestaat niet;
--    de route is volledig storneren en de juiste transactie opnieuw boeken.
--  * Met session_replication_role = replica is elke trigger te omzeilen; buiten het
--    dreigingsmodel, net als bij m18-m23.
--  * Rapportage die payments.amount of expenses.amount BRUTO sommeert telt origineel en
--    correctie allebei. v_financial_reversals maakt zichtbaar wat gestorneerd is; het netten
--    in de UI is Checkpoint 3.
--  * auth.uid() IS NULL slaat de ROLcontrole over, exact zoals close_fiscal_year sinds m23.
--    Dat houdt migraties, tests en service_role-onderhoud werkend. De FINANCIELE invarianten
--    hieronder gelden altijd, voor iedereen.

-- =========================================================================
-- 1. tenant-composietsleutel op payment_allocations
-- =========================================================================
-- payment_allocations had als enige van de betrokken tabellen geen UNIQUE (id,
-- organization_id) en kon daardoor niet als doel dienen van het composite-FK-patroon waarmee
-- de rest van het schema tenantvermenging op DB-niveau uitsluit. Puur additief.
ALTER TABLE public.payment_allocations
  ADD CONSTRAINT payment_allocations_id_org_uk UNIQUE (id, organization_id);

-- =========================================================================
-- 2. financial_reversals — de auditgebeurtenis
-- =========================================================================
-- Volledig onwijzigbaar: er is GEEN enkele UPDATE-route, ook niet voor het invullen van
-- correction_source_id. Dat lukt doordat de RPC's de id's van de journaalpost en van de
-- correctierij VOORAF genereren, zodat alles in een enkele INSERT past. Bewust: een
-- audittabel met een "alleen dit ene veld mag nog"-uitzondering is geen audittabel meer.
CREATE TABLE public.financial_reversals (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  source_type               text NOT NULL,
  source_id                 uuid NOT NULL,
  reversal_journal_entry_id uuid NOT NULL,
  correction_source_id      uuid,
  fiscal_year_id            uuid NOT NULL,
  effective_date            date NOT NULL,
  reason                    text NOT NULL,
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT financial_reversals_source_type_check
    CHECK (source_type IN ('payment','expense')),
  -- Reden verplicht en betekenisvol, in de DB en niet alleen in de RPC: een storno zonder
  -- opgegeven reden is geen auditspoor.
  CONSTRAINT financial_reversals_reason_check
    CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  -- Een correctie kan nooit naar de gestorneerde rij zelf wijzen.
  CONSTRAINT financial_reversals_correction_differs_check
    CHECK (correction_source_id IS NULL OR correction_source_id <> source_id),

  CONSTRAINT financial_reversals_id_org_uk UNIQUE (id, organization_id),
  CONSTRAINT financial_reversals_org_fk
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT financial_reversals_fy_org_fk
    FOREIGN KEY (fiscal_year_id, organization_id)
    REFERENCES public.fiscal_years(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT financial_reversals_je_org_fk
    FOREIGN KEY (reversal_journal_entry_id, organization_id)
    REFERENCES public.journal_entries(id, organization_id) ON DELETE CASCADE
);

-- DIT is de dubbele-storno-garantie. Niet de EXISTS-check in de RPC - die levert alleen de
-- nette foutcode - maar deze index. Twee gelijktijdige transacties die allebei "nog niet
-- gestorneerd" lezen, kunnen niet allebei committen.
CREATE UNIQUE INDEX financial_reversals_source_uk
  ON public.financial_reversals (source_type, source_id);

CREATE INDEX financial_reversals_correction_idx ON public.financial_reversals (correction_source_id);
CREATE INDEX financial_reversals_fy_idx         ON public.financial_reversals (fiscal_year_id);
CREATE INDEX financial_reversals_org_idx        ON public.financial_reversals (organization_id);

COMMENT ON TABLE public.financial_reversals IS
  'Onwijzigbare auditgebeurtenis per storno of correctie van een betaling of gejournaliseerde uitgave. source_type/source_id wijzen naar het origineel, correction_source_id naar de vervangende rij (NULL bij een kale storno), fiscal_year_id naar het OPEN boekjaar waarin de gespiegelde journaalpost is geboekt. Uitsluitend geschreven door reverse_payment/correct_payment/reverse_expense/correct_expense.';

-- =========================================================================
-- 3. payment_allocation_reversals — append-only neutralisatie
-- =========================================================================
-- Positieve bedragen; de TABEL drukt de richting uit, niet het teken. Een payment_allocation
-- kan hoogstens eenmaal worden geneutraliseerd (UNIQUE), en het bedrag moet exact gelijk zijn
-- aan de originele toewijzing (trigger) - MVP kent geen gedeeltelijke storno.
CREATE TABLE public.payment_allocation_reversals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  reversal_id           uuid NOT NULL,
  payment_allocation_id uuid NOT NULL,
  charge_allocation_id  uuid NOT NULL,
  amount                numeric(14,2) NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_allocation_reversals_amount_check CHECK (amount > 0),
  CONSTRAINT payment_allocation_reversals_pa_once      UNIQUE (payment_allocation_id),

  CONSTRAINT payment_allocation_reversals_org_fk
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT payment_allocation_reversals_rev_org_fk
    FOREIGN KEY (reversal_id, organization_id)
    REFERENCES public.financial_reversals(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT payment_allocation_reversals_pa_org_fk
    FOREIGN KEY (payment_allocation_id, organization_id)
    REFERENCES public.payment_allocations(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT payment_allocation_reversals_ca_org_fk
    FOREIGN KEY (charge_allocation_id, organization_id)
    REFERENCES public.charge_allocations(id, organization_id) ON DELETE CASCADE
);

CREATE INDEX payment_allocation_reversals_rev_idx ON public.payment_allocation_reversals (reversal_id);
CREATE INDEX payment_allocation_reversals_ca_idx  ON public.payment_allocation_reversals (charge_allocation_id);

COMMENT ON TABLE public.payment_allocation_reversals IS
  'Append-only neutralisatie van een betalingstoewijzing, met POSITIEF bedrag. Draagt samen met payment_allocations de invariant charge_allocations.settled_amount = SUM(payment_allocations.amount) - SUM(payment_allocation_reversals.amount), afgedwongen door fn_guard_ca_settlement_derived en zichtbaar in v_settlement_integrity.';

-- =========================================================================
-- 4. onveranderlijkheid van de twee nieuwe tabellen
-- =========================================================================
-- Zelfde patroon als m18-m23: UPDATE onvoorwaardelijk weigeren, DELETE weigeren zolang alle
-- cascade-ouders nog bestaan. De escape is nodig omdat het offboarden van een organisatie
-- anders vastloopt op de eigen auditrijen.
CREATE OR REPLACE FUNCTION public.fn_guard_financial_reversal_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
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

DROP TRIGGER IF EXISTS trig_00_fr_immutable ON public.financial_reversals;
CREATE TRIGGER trig_00_fr_immutable BEFORE UPDATE OR DELETE ON public.financial_reversals
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_financial_reversal_immutable();

CREATE OR REPLACE FUNCTION public.fn_guard_par_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'ALLOCATION_REVERSAL_IMMUTABLE: een vastgelegde neutralisatie kan niet worden gewijzigd.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations        WHERE id = OLD.organization_id)
  OR NOT EXISTS (SELECT 1 FROM public.financial_reversals  WHERE id = OLD.reversal_id)
  OR NOT EXISTS (SELECT 1 FROM public.payment_allocations  WHERE id = OLD.payment_allocation_id)
  OR NOT EXISTS (SELECT 1 FROM public.charge_allocations   WHERE id = OLD.charge_allocation_id) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'ALLOCATION_REVERSAL_IMMUTABLE: een vastgelegde neutralisatie kan niet worden verwijderd zolang de storno en de toewijzing bestaan.'
    USING ERRCODE = '23514';
END $fn$;

DROP TRIGGER IF EXISTS trig_00_par_immutable ON public.payment_allocation_reversals;
CREATE TRIGGER trig_00_par_immutable BEFORE UPDATE OR DELETE ON public.payment_allocation_reversals
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_par_immutable();

-- Een neutralisatierij moet exact bij haar toewijzing horen: zelfde charge_allocation, zelfde
-- bedrag. Zonder deze controle zou een neutralisatie naar een ANDERE vordering kunnen wijzen
-- en daar het openstaande saldo verlagen - een cross-referentie die de composite-FK's niet
-- vangen omdat beide rijen in dezelfde organisatie zitten.
CREATE OR REPLACE FUNCTION public.fn_guard_par_consistent()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_pa public.payment_allocations%ROWTYPE;
BEGIN
  SELECT * INTO v_pa FROM public.payment_allocations WHERE id = NEW.payment_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ALLOCATION_REVERSAL_UNKNOWN_ALLOCATION: toewijzing bestaat niet.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.charge_allocation_id IS DISTINCT FROM v_pa.charge_allocation_id THEN
    RAISE EXCEPTION
      'ALLOCATION_REVERSAL_MISLINKED: de neutralisatie verwijst naar een andere vordering dan de toewijzing die zij terugdraait.'
      USING ERRCODE = '23514';
  END IF;

  -- MVP-regel, hier hard afgedwongen: volledige storno of niets.
  IF NEW.amount IS DISTINCT FROM v_pa.amount THEN
    RAISE EXCEPTION
      'ALLOCATION_REVERSAL_PARTIAL: gedeeltelijk terugdraaien bestaat niet; neutraliseer de volledige toewijzing van %.',
      v_pa.amount USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trig_00_par_consistent ON public.payment_allocation_reversals;
CREATE TRIGGER trig_00_par_consistent BEFORE INSERT ON public.payment_allocation_reversals
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_par_consistent();

-- correction_source_id is polymorf en heeft daarom geen foreign key. Deze DEFERRABLE
-- constraint trigger controleert bij COMMIT dat hij naar een BESTAANDE rij van het juiste
-- type in DEZELFDE organisatie wijst. Uitgesteld, omdat de RPC de id vooraf genereert en de
-- rij pas later in de transactie invoegt.
CREATE OR REPLACE FUNCTION public.fn_guard_fr_correction_exists()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.correction_source_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- Ouderrij is inmiddels weggecascadeerd: niets te controleren.
  IF NOT EXISTS (SELECT 1 FROM public.financial_reversals WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;

  IF NEW.source_type = 'payment' THEN
    IF NOT EXISTS (SELECT 1 FROM public.payments
                    WHERE id = NEW.correction_source_id
                      AND organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION
        'CORRECTION_SOURCE_MISSING: de correctiebetaling bestaat niet in deze organisatie.'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.expenses
                    WHERE id = NEW.correction_source_id
                      AND organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION
        'CORRECTION_SOURCE_MISSING: de correctie-uitgave bestaat niet in deze organisatie.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trig_zz_fr_correction_exists ON public.financial_reversals;
CREATE CONSTRAINT TRIGGER trig_zz_fr_correction_exists
  AFTER INSERT ON public.financial_reversals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_fr_correction_exists();

-- =========================================================================
-- 5. RLS op de nieuwe tabellen
-- =========================================================================
-- Zelfde model als charge_allocations/payment_allocations sinds m11: lezen mag elk
-- organisatielid, schrijven kan uitsluitend via de RPC's. Naast de policies worden de
-- schrijfrechten ook ingetrokken - twee onafhankelijke lagen, niet een.
ALTER TABLE public.financial_reversals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocation_reversals ENABLE ROW LEVEL SECURITY;

CREATE POLICY financial_reversals_select ON public.financial_reversals
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY financial_reversals_insert ON public.financial_reversals
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY financial_reversals_update ON public.financial_reversals
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY financial_reversals_delete ON public.financial_reversals
  FOR DELETE TO authenticated USING (false);

CREATE POLICY payment_allocation_reversals_select ON public.payment_allocation_reversals
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY payment_allocation_reversals_insert ON public.payment_allocation_reversals
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY payment_allocation_reversals_update ON public.payment_allocation_reversals
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY payment_allocation_reversals_delete ON public.payment_allocation_reversals
  FOR DELETE TO authenticated USING (false);

REVOKE ALL ON public.financial_reversals          FROM anon;
REVOKE ALL ON public.payment_allocation_reversals FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.financial_reversals          FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.payment_allocation_reversals FROM authenticated;
GRANT SELECT ON public.financial_reversals          TO authenticated;
GRANT SELECT ON public.payment_allocation_reversals TO authenticated;

-- =========================================================================
-- 6. DE SETTLEMENT-GUARD (P1)
-- =========================================================================
-- Tot nu toe was charge_allocations.settled_amount vrij muteerbaar voor elke SECURITY
-- DEFINER-context en voor service_role. Dat is de kolom waarop de hele debiteurenpositie
-- rust.
--
-- BEWUSTE KEUZE: GEEN IDENTIFICATIE VAN DE AANROEPER.
-- De voor de hand liggende oplossingen zijn allebei zwak:
--
--   * pg_trigger_depth() > 0 bewijst alleen dat er ERGENS een trigger draait, niet WELKE.
--     Elke andere trigger op elke andere tabel die charge_allocations aanraakt voldoet er
--     ook aan. Het is geen autorisatiebewijs maar een dieptemeting, en precies daarom
--     onbruikbaar hier.
--   * Een transactielokale GUC (set_config('agio.x', ..., true)) verplaatst het probleem naar
--     "kan iemand die GUC zetten". Dat moet je dan bewijzen voor elke huidige en toekomstige
--     RPC, voor PostgREST-headers en voor service_role. Bewijslast die nooit afneemt.
--
-- In plaats daarvan dwingt deze guard de INVARIANT ZELF af. Er is geen context om te
-- vervalsen, want er wordt geen context gelezen:
--
--     settled_amount = SUM(payment_allocations.amount)
--                    - SUM(payment_allocation_reversals.amount)
--
-- fn_payment_fifo voldoet er automatisch aan: die INSERT de toewijzing en verhoogt daarna
-- settled_amount met hetzelfde bedrag. De reversal-engine voldoet er automatisch aan: die
-- INSERT de neutralisatie en verlaagt daarna settled_amount met hetzelfde bedrag. Iedere
-- ANDERE UPDATE - los statement, service_role, een toekomstige buggy trigger, een handmatige
-- ingreep in de SQL-editor - faalt, omdat er geen bijbehorende grootboekrij bestaat.
--
-- Alles rekent in numeric(14,2). Geen floating point, dus de vergelijking is exact en niet
-- afhankelijk van afronding.
--
-- Gecontroleerd voor toepassing: 0 charge_allocations en 0 payment_allocations op productie,
-- dus geen bestaande drift die deze guard zou blokkeren, en geen backfill nodig.
CREATE OR REPLACE FUNCTION public.fn_guard_ca_settlement_derived()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_toegewezen  numeric(14,2);
  v_gestorneerd numeric(14,2);
  v_afgeleid    numeric(14,2);
BEGIN
  IF NEW.settled_amount IS NOT DISTINCT FROM OLD.settled_amount THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_toegewezen
    FROM public.payment_allocations WHERE charge_allocation_id = OLD.id;

  SELECT coalesce(sum(amount), 0) INTO v_gestorneerd
    FROM public.payment_allocation_reversals WHERE charge_allocation_id = OLD.id;

  v_afgeleid := v_toegewezen - v_gestorneerd;

  IF NEW.settled_amount IS DISTINCT FROM v_afgeleid THEN
    RAISE EXCEPTION
      'SETTLEMENT_NOT_DERIVED: settled_amount mag alleen volgen uit de toewijzingen. Gevraagd %, afgeleid % (toegewezen % minus gestorneerd %). Boek een betaling of gebruik reverse_payment/correct_payment.',
      NEW.settled_amount, v_afgeleid, v_toegewezen, v_gestorneerd
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $fn$;

-- trig_01, dus NA de m12/m20-guards trig_00_ca_closed_fy en trig_00_ca_snapshot_immutable.
-- Die houden hun eigen, duidelijkere meldingen voor de gevallen die zij dekken.
DROP TRIGGER IF EXISTS trig_01_ca_settlement_derived ON public.charge_allocations;
CREATE TRIGGER trig_01_ca_settlement_derived BEFORE UPDATE ON public.charge_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_ca_settlement_derived();

-- =========================================================================
-- 7. onveranderlijkheid van gejournaliseerde bronrijen
-- =========================================================================
-- Zonder deze twee guards bestaan er twee wegen naar hetzelfde resultaat: de auditeerbare
-- correctieflow, en een stille UPDATE. Dan is de audittrail optioneel, en dat is geen
-- audittrail. payments en expenses staan beide op can_write voor UPDATE (RLS), dus dit was
-- tot nu toe een gewone managerhandeling.
--
-- Bevroren zodra er een journaalpost hangt. Voor betalingen is dat altijd meteen, want
-- fn_journal_from_payment boekt bij elke INSERT. Voor uitgaven alleen wanneer er een boekjaar
-- aan hangt; een uitgave zonder boekjaar heeft geen journaalpost en blijft dus bewerkbaar -
-- diezelfde uitzondering die m22/m23 al kennen.
--
-- BEWUST VRIJ: payments.reference (administratief kenmerk, raakt geen bedrag en geen
-- rekening) en expenses.supplier/description/receipt_url/receipt_path (annotatie en
-- bewijsstuk). Alles wat het GROOTBOEK of de VERDELING raakt ligt vast.
CREATE OR REPLACE FUNCTION public.fn_guard_payment_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE velden text[] := ARRAY[]::text[];
BEGIN
  -- De ::text-cast is NIET cosmetisch. Zonder cast heeft het literal type "unknown" en kiest
  -- PostgreSQL de operator anyarray || anyarray boven anyarray || anyelement; het leest het woord
  -- dan als array-literal en faalt met "malformed array literal". Bewezen door test A11 en A16:
  -- zonder cast wierp deze guard die fout bij ELKE wijziging, ook een volstrekt legitieme, en
  -- verving hij de bedoelde melding door een onbegrijpelijke. m22 ontsnapt hieraan doordat het
  -- format() gebruikt, dat al text teruggeeft.
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

DROP TRIGGER IF EXISTS trig_00_payment_immutable ON public.payments;
CREATE TRIGGER trig_00_payment_immutable BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_payment_immutable();

CREATE OR REPLACE FUNCTION public.fn_guard_expense_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE velden text[] := ARRAY[]::text[];
BEGIN
  -- Zie de toelichting bij fn_guard_payment_immutable: de ::text-cast is verplicht.
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

-- Vuurt NA trig_00_exp_fy_immutable (alfabetisch: exp_fy < exp_immutable), zodat de
-- bestaande, specifiekere boekjaarmelding uit m22 voorrang houdt.
DROP TRIGGER IF EXISTS trig_00_exp_immutable ON public.expenses;
CREATE TRIGGER trig_00_exp_immutable BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_expense_immutable();

-- =========================================================================
-- 8. hulpfuncties van de engine
-- =========================================================================
-- Doelboekjaar voor een storno. Een gesloten boekjaar wordt NOOIT herschreven; de storno
-- landt dan in het lopende open jaar. Is het originele jaar zelf nog open, dan blijft de
-- correctie binnen dat jaar - dat houdt het resultaat van dat jaar kloppend en voorkomt
-- onnodige ruis over de jaargrens heen.
CREATE OR REPLACE FUNCTION public.fn_reversal_target_fy(p_building_id uuid, p_original_fy uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_fy uuid;
BEGIN
  IF p_original_fy IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.fiscal_years WHERE id = p_original_fy AND status = 'open') THEN
    RETURN p_original_fy;
  END IF;

  SELECT id INTO v_fy
    FROM public.fiscal_years
   WHERE building_id = p_building_id AND status = 'open'
   ORDER BY year DESC
   LIMIT 1;

  IF v_fy IS NULL THEN
    RAISE EXCEPTION
      'REVERSAL_NO_OPEN_FISCAL_YEAR: er is geen open boekjaar voor dit gebouw. Open eerst een boekjaar; een storno kan nooit in een afgesloten boekjaar worden geboekt.'
      USING ERRCODE = '23514';
  END IF;
  RETURN v_fy;
END $fn$;

-- Autorisatie. Vastgelegde businessregel:
--   origineel in een OPEN boekjaar   -> can_write (owner/admin/manager/accountant)
--   origineel in een GESLOTEN boekjaar -> can_manage_members (alleen owner/admin)
-- Geen nieuw rollenmodel; de bestaande helpers, dezelfde die m8 t/m m23 gebruiken.
--
-- Bewuste lezing, expliciet vastgelegd: bepalend is het boekjaar van de ORIGINELE
-- JOURNAALPOST. Een betaling in het lopende jaar die een vordering uit een afgesloten jaar
-- afboekte, blijft dus een can_write-handeling. Het herstellen van settled_amount in dat
-- gesloten jaar is een doorlopende debiteurenpositie en geen herschrijving van de
-- jaarrekening - zie docs/accounting-rules.md paragraaf 2.
CREATE OR REPLACE FUNCTION public.fn_reversal_authorize(p_org uuid, p_original_fy uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  IF p_original_fy IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.fiscal_years WHERE id = p_original_fy AND status = 'closed') THEN
    IF NOT public.can_manage_members(p_org) THEN
      RAISE EXCEPTION
        'REVERSAL_FORBIDDEN_CLOSED_FY: deze transactie hoort bij een afgesloten boekjaar; alleen een owner of admin mag hem storneren.'
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;

  IF NOT public.can_write(p_org) THEN
    RAISE EXCEPTION 'REVERSAL_FORBIDDEN: onvoldoende rechten om deze transactie te storneren.'
      USING ERRCODE = '42501';
  END IF;
END $fn$;

-- De gespiegelde journaalpost: EXACT het spiegelbeeld van de originele regels, met debet en
-- credit verwisseld.
--
-- Bewust GEEN herafleiding van rekeningen uit de actuele categorie- of rekeningkoppeling. Is
-- de standaardrekening van een categorie sinds de oorspronkelijke boeking gewijzigd, dan zou
-- herafleiden de storno op een ANDERE rekening zetten dan het origineel, en blijft er saldo
-- achter op de oude rekening. Spiegelen kan die fout per constructie niet maken.
--
-- Hierdoor klopt de balans ook automatisch: het origineel sluit (bewaakt door
-- trig_journal_balance_check), dus de spiegeling sluit ook. En elke regel voldoet aan
-- journal_lines_check, want een regel met debet>0/credit=0 wordt credit>0/debet=0.
CREATE OR REPLACE FUNCTION public.fn_reversal_mirror_journal(
  p_orig_entry uuid,
  p_new_entry  uuid,
  p_reversal   uuid,
  p_target_fy  uuid,
  p_effective  date
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_e public.journal_entries%ROWTYPE; v_n int;
BEGIN
  SELECT * INTO v_e FROM public.journal_entries WHERE id = p_orig_entry;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVERSAL_ORIGINAL_ENTRY_MISSING: originele journaalpost bestaat niet.'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_n FROM public.journal_lines WHERE journal_entry_id = p_orig_entry;
  IF v_n < 2 THEN
    RAISE EXCEPTION
      'REVERSAL_ORIGINAL_ENTRY_INCOMPLETE: de originele journaalpost heeft % regel(s) en kan niet worden gespiegeld.',
      v_n USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.journal_entries(
    id, organization_id, building_id, fiscal_year_id,
    entry_date, source, source_id, description
  ) VALUES (
    p_new_entry, v_e.organization_id, v_e.building_id, p_target_fy,
    p_effective, 'reversal', p_reversal,
    'Storno: ' || coalesce(v_e.description, 'journaalpost ' || p_orig_entry::text)
  );

  INSERT INTO public.journal_lines(
    organization_id, journal_entry_id, account_id, debit, credit, description
  )
  SELECT jl.organization_id, p_new_entry, jl.account_id,
         jl.credit, jl.debit,
         'Storno: ' || coalesce(jl.description, '')
    FROM public.journal_lines jl
   WHERE jl.journal_entry_id = p_orig_entry
   ORDER BY jl.id;
END $fn$;

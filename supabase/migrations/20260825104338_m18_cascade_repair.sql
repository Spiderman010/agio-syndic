-- m18 — Flexible allocation engine, deel 7: cascadeherstel
--
-- Vier beschermende foreign keys blokkeerden niet alleen het verwijderen van
-- EEN unit of eigenaar met historie (bedoeld), maar ook het verwijderen van het
-- hele gebouw of de hele organisatie (niet bedoeld). Een foreign key kent geen
-- uitzondering: hij weet niet of de ouder zelf ook wordt verwijderd.
--
-- Dat is exact de foutklasse die m11 punt 5 eerder moest terugdraaien, en die
-- de adversariële toets van dit ontwerp opnieuw voorspelde. De juiste vorm is
-- niet een strengere FK maar:
--     ON DELETE CASCADE op de FK  +  een BEFORE DELETE-trigger die de losse
--     verwijdering blokkeert ZOLANG de ouder nog bestaat.
-- Bij een cascade is de ouderrij op dat moment al weg, dus de trigger laat hem
-- door. Bij een losse DELETE bestaat de ouder nog en grijpt hij wel in.

-- ------------------------------------------------------------ charge_calls --
-- charge_allocations_cc_org_fk (uit m8) stond op NO ACTION en blokkeerde het
-- intrekken van een lastenoproep die allocaties heeft — dus elke oproep.
ALTER TABLE public.charge_allocations DROP CONSTRAINT charge_allocations_cc_org_fk;
ALTER TABLE public.charge_allocations
  ADD CONSTRAINT charge_allocations_cc_org_fk
    FOREIGN KEY (charge_call_id, organization_id)
    REFERENCES public.charge_calls(id, organization_id) ON DELETE CASCADE;

-- ------------------------------------------------------------------ units ---
ALTER TABLE public.charge_allocations DROP CONSTRAINT ca_unit_building_fk;
ALTER TABLE public.charge_allocations
  ADD CONSTRAINT ca_unit_building_fk
    FOREIGN KEY (unit_id, building_id)
    REFERENCES public.units(id, building_id) ON DELETE CASCADE;

ALTER TABLE public.charge_call_lines DROP CONSTRAINT ccl_unit_fk;
ALTER TABLE public.charge_call_lines
  ADD CONSTRAINT ccl_unit_fk
    FOREIGN KEY (unit_id, building_id)
    REFERENCES public.units(id, building_id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.fn_guard_unit_delete_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  -- Ouder is al weg: dit is een cascade, doorlaten.
  IF NOT EXISTS (SELECT 1 FROM public.buildings WHERE id = OLD.building_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.charge_allocations WHERE unit_id = OLD.id) THEN
    RAISE EXCEPTION
      'ALLOC_UNIT_HAS_HISTORY: dit lot komt voor in een vastgelegde lastenoproep en kan niet worden verwijderd.'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

CREATE TRIGGER trig_00_unit_delete_history BEFORE DELETE ON public.units
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_unit_delete_history();

-- ----------------------------------------------------------------- owners ---
-- Twee identieke FK's op (owner_id, organization_id); een is genoeg.
ALTER TABLE public.charge_allocations DROP CONSTRAINT charge_allocations_owner_org_fk;
ALTER TABLE public.charge_allocations DROP CONSTRAINT ca_owner_org_fk;
ALTER TABLE public.charge_allocations
  ADD CONSTRAINT ca_owner_org_fk
    FOREIGN KEY (owner_id, organization_id)
    REFERENCES public.owners(id, organization_id) ON DELETE CASCADE;

ALTER TABLE public.payments DROP CONSTRAINT payments_owner_id_fkey;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES public.owners(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.fn_guard_owner_delete_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.charge_allocations WHERE owner_id = OLD.id) THEN
    RAISE EXCEPTION
      'ALLOC_OWNER_HAS_HISTORY: deze eigenaar heeft vastgelegde vorderingen en kan niet worden verwijderd.'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments WHERE owner_id = OLD.id) THEN
    RAISE EXCEPTION
      'ALLOC_OWNER_HAS_PAYMENTS: deze eigenaar heeft geregistreerde betalingen en kan niet worden verwijderd.'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $fn$;

CREATE TRIGGER trig_00_owner_delete_history BEFORE DELETE ON public.owners
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_owner_delete_history();

-- ------------------------------------------------------------ memberships ---
-- Dezelfde ontbrekende escape: bij het verwijderen van een organisatie
-- cascadeert memberships weg en vuurde de laatste-owner-guard ten onrechte,
-- waardoor een organisatie helemaal niet verwijderbaar was.
CREATE OR REPLACE FUNCTION public.fn_guard_last_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_owners int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF OLD.role <> 'owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_owners
    FROM public.memberships
   WHERE organization_id = OLD.organization_id
     AND role = 'owner'
     AND id <> OLD.id;

  IF v_owners = 0 THEN
    RAISE EXCEPTION
      'Organisatie % moet minimaal een owner houden', OLD.organization_id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_guard_unit_delete_history()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_owner_delete_history() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_guard_unit_delete_history() IS
  'Blokkeert het verwijderen van EEN lot met historie, maar laat de cascade van een gebouw door: als de gebouwrij al weg is, is dit een cascade en geen losse verwijdering.';

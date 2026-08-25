-- ============================================================================
-- m12 — Flexible allocation engine, deel 1: structuur
-- ============================================================================
--
-- Voegt de blokkenlaag en het verdeelregelmodel toe. Verandert nog NIETS aan
-- de manier waarop een lastenoproep wordt verdeeld; dat gebeurt in m15.
-- Deze migratie is daarmee volledig terugdraaibaar zolang er geen lastenoproep
-- bestaat die naar een verdeelregel verwijst.
--
-- Ontwerpkeuze (Variant A): EEN gewicht per lot (`units.tantiemes`) blijft de
-- standaardbron. De kolom `weight_source` op de verdeelregel is de expliciete
-- discriminator die bepaalt waar de gewichten vandaan komen; kindtabellen zijn
-- daar declaratief aan vastgeankerd, zodat een regel op tantièmes per
-- constructie geen eigen gewichten kan dragen. Geen enkele trigger bewaakt dat.
-- ============================================================================

-- ---------------------------------------------------------------- enums -----
CREATE TYPE public.allocation_method        AS ENUM ('equal','tantieme','percentage','manual');
CREATE TYPE public.allocation_scope         AS ENUM ('whole_building','block','selected_units');
CREATE TYPE public.allocation_weight_source AS ENUM ('none','unit_tantiemes','rule_weights','charge_call_lines');
CREATE TYPE public.allocation_rule_status   AS ENUM ('draft','active','retired');
CREATE TYPE public.uncovered_unit_policy    AS ENUM ('scope_default','fail');

-- ------------------------------------------------- ontbrekende FK-doelen ----
-- `units` heeft vandaag alleen units_pkey: geen organisatiekolom en geen
-- (id, building_id). Daardoor kan geen enkele nieuwe tabel tenant-veilig naar
-- een unit verwijzen. Er is GEEN organization_id op units nodig: de keten
-- units(id, building_id) -> buildings(id, organization_id) levert dezelfde
-- garantie voor de prijs van twee unieke sleutels, en blijft additief.
ALTER TABLE public.units
  ADD CONSTRAINT units_id_building_key UNIQUE (id, building_id);

ALTER TABLE public.fiscal_years
  ADD CONSTRAINT fiscal_years_id_building_key UNIQUE (id, building_id);

-- ---------------------------------------------------------------- blocks ----
CREATE TABLE public.blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id     uuid NOT NULL,
  code            text NOT NULL,
  name            text,
  sort_order      int  NOT NULL DEFAULT 0,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT blocks_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT blocks_building_org_fk
    FOREIGN KEY (building_id, organization_id)
    REFERENCES public.buildings(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT blocks_id_org_key      UNIQUE (id, organization_id),
  CONSTRAINT blocks_id_building_key UNIQUE (id, building_id)
);

-- Hoofdletterongevoelig uniek: in een fr/ar/nl-praktijk mag 'A' niet naast 'a'
-- kunnen bestaan.
CREATE UNIQUE INDEX blocks_building_code_ci_idx
  ON public.blocks (building_id, lower(btrim(code)));
CREATE INDEX blocks_building_idx ON public.blocks (building_id);

-- units.block_id: NULLABLE. Een gebouw zonder blokken houdt NULL op al zijn
-- lots en merkt niets van deze migratie.
ALTER TABLE public.units ADD COLUMN block_id uuid;

-- ON DELETE SET NULL met KOLOMLIJST (PG 15+). Drie redenen waarom dit exact zo
-- moet:
--   * RESTRICT is fout: bij DELETE FROM buildings cascadeert PostgreSQL naar
--     zowel blocks als units, en de volgorde daartussen is niet gegarandeerd.
--     Wordt blocks eerst geraakt, dan vuurt RESTRICT ten onrechte en is het
--     gebouw permanent onverwijderbaar.
--   * Een kale SET NULL zonder kolomlijst is ook fout: die zou beide kolommen
--     nullen, en building_id is NOT NULL.
--   * MATCH SIMPLE (de default) is hier juist: bij block_id IS NULL wordt de
--     check overgeslagen, en dat is precies de betekenis "lot zonder blok".
ALTER TABLE public.units
  ADD CONSTRAINT units_block_building_fk
  FOREIGN KEY (block_id, building_id)
  REFERENCES public.blocks (id, building_id)
  ON DELETE SET NULL (block_id);

CREATE INDEX units_block_idx ON public.units (block_id) WHERE block_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_guard_block_building_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.building_id IS DISTINCT FROM OLD.building_id THEN
    RAISE EXCEPTION 'ALLOC_BLOCK_MOVE: een blok kan niet naar een ander gebouw worden verplaatst'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trig_00_block_building_immutable BEFORE UPDATE ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_block_building_immutable();
CREATE TRIGGER trig_00_org_immutable BEFORE UPDATE ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_org_immutable();

-- ------------------------------------------------------ allocation_rules ----
CREATE TABLE public.allocation_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  building_id           uuid NOT NULL,
  code                  text NOT NULL,
  label                 text NOT NULL,
  method                public.allocation_method        NOT NULL,
  scope                 public.allocation_scope         NOT NULL,
  weight_source         public.allocation_weight_source NOT NULL,
  scope_block_id        uuid,
  uncovered_unit_policy public.uncovered_unit_policy    NOT NULL DEFAULT 'scope_default',
  control_total         numeric(14,4),
  status                public.allocation_rule_status   NOT NULL DEFAULT 'draft',
  revision              int  NOT NULL DEFAULT 1,
  supersedes_rule_id    uuid,
  is_default            boolean NOT NULL DEFAULT false,
  locked_at             timestamptz,
  retired_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Derogatie op de controlewaarde (F09). Bewust GEEN kale boolean: alle vier
  -- de velden zijn verplicht zodra er van de controlewaarde wordt afgeweken,
  -- inclusief een vervalboekjaar, zodat de afwijking niet kan verwateren.
  partial_denominator_reason     text,
  partial_denominator_by         uuid,
  partial_denominator_at         timestamptz,
  partial_denominator_until_year int,

  CONSTRAINT ar_code_not_blank  CHECK (btrim(code) <> ''),
  CONSTRAINT ar_label_not_blank CHECK (btrim(label) <> ''),
  CONSTRAINT ar_revision_ck     CHECK (revision >= 1),

  CONSTRAINT ar_building_org_fk
    FOREIGN KEY (building_id, organization_id)
    REFERENCES public.buildings(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT ar_block_building_fk
    FOREIGN KEY (scope_block_id, building_id)
    REFERENCES public.blocks(id, building_id),
  CONSTRAINT ar_supersedes_fk
    FOREIGN KEY (supersedes_rule_id) REFERENCES public.allocation_rules(id),

  -- FK-doelen. De laatste twee zijn de discriminator-ankers waaraan de
  -- kindtabellen zich vastpinnen; zonder ON UPDATE CASCADE, zodat scope of
  -- gewichtsbron van een regel met kindrijen niet stilzwijgend kan omschakelen.
  CONSTRAINT ar_id_org_key      UNIQUE (id, organization_id),
  CONSTRAINT ar_id_building_key UNIQUE (id, building_id),
  CONSTRAINT ar_id_scope_key    UNIQUE (id, building_id, scope),
  CONSTRAINT ar_id_source_key   UNIQUE (id, building_id, weight_source),

  -- De methode bepaalt eenduidig waar de gewichten vandaan komen.
  CONSTRAINT ar_method_source_ck CHECK (
       (method = 'equal'      AND weight_source = 'none')
    OR (method = 'tantieme'   AND weight_source IN ('unit_tantiemes','rule_weights'))
    OR (method = 'percentage' AND weight_source = 'rule_weights')
    OR (method = 'manual'     AND weight_source = 'charge_call_lines')),

  CONSTRAINT ar_scope_block_ck CHECK ((scope = 'block') = (scope_block_id IS NOT NULL)),

  -- Drievoudige logica dichtgezet: NULL mag hier niet slagen.
  CONSTRAINT ar_pct_control_ck CHECK (
    method <> 'percentage' OR (control_total IS NOT NULL AND control_total = 100)),

  -- Een regel op units.tantiemes mag GEEN bevroren kopie van de controlewaarde
  -- dragen; F09 toetst daar live tegen buildings.total_tantiemes.
  CONSTRAINT ar_tantiemes_control_ck CHECK (
    weight_source <> 'unit_tantiemes' OR control_total IS NULL),

  CONSTRAINT ar_status_retired_ck CHECK ((status = 'retired') = (retired_at IS NOT NULL)),

  -- Alles of niets: een halve derogatie bestaat niet.
  CONSTRAINT ar_partial_ck CHECK (
    (partial_denominator_reason IS NULL AND partial_denominator_by IS NULL
     AND partial_denominator_at IS NULL AND partial_denominator_until_year IS NULL)
    OR (btrim(coalesce(partial_denominator_reason,'')) <> ''
     AND partial_denominator_by IS NOT NULL
     AND partial_denominator_at IS NOT NULL
     AND partial_denominator_until_year IS NOT NULL))
);

CREATE UNIQUE INDEX ar_code_revision_key
  ON public.allocation_rules (building_id, lower(btrim(code)), revision);

-- Precies EEN actieve standaardregel per gebouw. Filter op status='active',
-- niet op retired_at: een default in 'draft' mag geen enkele oproep blokkeren.
CREATE UNIQUE INDEX ar_default_per_building_idx
  ON public.allocation_rules (building_id) WHERE is_default AND status = 'active';

CREATE INDEX ar_building_idx ON public.allocation_rules (building_id);

-- ------------------------------------------------- allocation_rule_units ----
-- Deelname. De betekenis volgt eenduidig uit de scope van de ouderregel:
--   whole_building / block  -> UITSLUITING (dit lot doet niet mee)
--   selected_units          -> INSLUITING (alleen deze lots doen mee)
-- De scope wordt aan de rij vastgepind via een composite FK zonder
-- ON UPDATE CASCADE, zodat de betekenis van bestaande rijen nooit kan kantelen.
CREATE TABLE public.allocation_rule_units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id     uuid NOT NULL,
  rule_id         uuid NOT NULL,
  rule_scope      public.allocation_scope NOT NULL,
  unit_id         uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aru_building_org_fk
    FOREIGN KEY (building_id, organization_id)
    REFERENCES public.buildings(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT aru_rule_fk
    FOREIGN KEY (rule_id, building_id, rule_scope)
    REFERENCES public.allocation_rules(id, building_id, scope) ON DELETE CASCADE,
  CONSTRAINT aru_unit_fk
    FOREIGN KEY (unit_id, building_id)
    REFERENCES public.units(id, building_id) ON DELETE CASCADE,
  CONSTRAINT aru_rule_unit_key UNIQUE (rule_id, unit_id)
);

CREATE INDEX aru_rule_idx ON public.allocation_rule_units (rule_id);

-- ----------------------------------------------- allocation_rule_weights ----
-- Eigen gewichten of percentages per lot. Alleen geldig wanneer de regel
-- expliciet op `rule_weights` staat; die eis is declaratief, niet in een
-- trigger. Een regel op units.tantiemes kan dus per constructie geen eigen
-- gewichten dragen, en kan ook niet omschakelen zolang er rijen bestaan.
CREATE TABLE public.allocation_rule_weights (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  building_id        uuid NOT NULL,
  rule_id            uuid NOT NULL,
  rule_weight_source public.allocation_weight_source NOT NULL,
  unit_id            uuid NOT NULL,
  weight             numeric(14,6) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT arw_source_ck     CHECK (rule_weight_source = 'rule_weights'),
  -- Bovengrens sluit bigint-overflow bij weight x 10^6 x centen structureel uit.
  CONSTRAINT arw_weight_pos_ck CHECK (weight > 0 AND weight <= 1000000),
  CONSTRAINT arw_building_org_fk
    FOREIGN KEY (building_id, organization_id)
    REFERENCES public.buildings(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT arw_rule_fk
    FOREIGN KEY (rule_id, building_id, rule_weight_source)
    REFERENCES public.allocation_rules(id, building_id, weight_source) ON DELETE CASCADE,
  CONSTRAINT arw_unit_fk
    FOREIGN KEY (unit_id, building_id)
    REFERENCES public.units(id, building_id) ON DELETE CASCADE,
  CONSTRAINT arw_rule_unit_key UNIQUE (rule_id, unit_id)
);

CREATE INDEX arw_rule_idx ON public.allocation_rule_weights (rule_id);

-- ------------------------------------------------- ownership-hardening ------
-- Mede-eigendom wordt in deze ronde auditeerbaar gemaakt, niet opgelost: de
-- volledige lot-allocatie gaat naar EEN debiteur. Zonder aanwijzing was die
-- keuze willekeurig (LIMIT 1 zonder ORDER BY); met is_primary_debtor is zij
-- expliciet en herleidbaar. Zie docs/known-issues.md.
ALTER TABLE public.ownership ADD COLUMN is_primary_debtor boolean NOT NULL DEFAULT true;

-- Deduplicatie-backfill VOOR de unieke indexen. Zonder deze stap faalt de
-- migratie op elke omgeving waar een lot twee actieve eigenaars heeft.
WITH gerangschikt AS (
  SELECT id,
         row_number() OVER (PARTITION BY unit_id
                            ORDER BY share DESC, start_date DESC, id ASC) AS rn
    FROM public.ownership
   WHERE end_date IS NULL
)
UPDATE public.ownership o
   SET is_primary_debtor = false
  FROM gerangschikt g
 WHERE o.id = g.id AND g.rn > 1;

-- Harde assertie: als er ná de backfill nog duplicaten zijn, stopt de migratie
-- met een leesbare melding in plaats van een kale 23505.
DO $assert$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT unit_id, owner_id, start_date FROM public.ownership
     GROUP BY unit_id, owner_id, start_date HAVING count(*) > 1) q;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Migratie gestopt: % combinatie(s) (unit, eigenaar, startdatum) komen dubbel voor in ownership. Ruim die eerst op.', n
      USING ERRCODE = '23514';
  END IF;
END $assert$;

ALTER TABLE public.ownership
  ADD CONSTRAINT ownership_unit_owner_start_key UNIQUE (unit_id, owner_id, start_date);

-- Hoogstens EEN aangewezen debiteur per lot binnen een lopende periode.
CREATE UNIQUE INDEX ownership_primary_active_idx
  ON public.ownership (unit_id) WHERE is_primary_debtor AND end_date IS NULL;

CREATE INDEX ownership_unit_period_idx
  ON public.ownership (unit_id, start_date, end_date);

-- ----------------------------------------- standaardregel per gebouw --------
-- Elk gebouw krijgt exact een regel: tantième over het hele gebouw, gewichten
-- uit units.tantiemes. Zo'n regel heeft per definitie NUL kindrijen, dus dit is
-- de complete backfill.
INSERT INTO public.allocation_rules
  (organization_id, building_id, code, label, method, scope, weight_source,
   status, is_default)
SELECT b.organization_id, b.id, 'general', 'Charges générales',
       'tantieme', 'whole_building', 'unit_tantiemes', 'active', true
  FROM public.buildings b;

-- BLOCKER A2: de backfill is eenmalig. Zonder deze trigger krijgt elk NIEUW
-- gebouw geen standaardregel en zou elke lastenoproep daarop hard falen.
CREATE OR REPLACE FUNCTION public.fn_building_default_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.allocation_rules
    (organization_id, building_id, code, label, method, scope, weight_source,
     status, is_default)
  VALUES (NEW.organization_id, NEW.id, 'general', 'Charges générales',
          'tantieme', 'whole_building', 'unit_tantiemes', 'active', true);
  RETURN NEW;
END $$;

CREATE TRIGGER trig_01_building_default_rule AFTER INSERT ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION public.fn_building_default_rule();

CREATE TRIGGER trig_00_org_immutable BEFORE UPDATE ON public.allocation_rules
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_org_immutable();
CREATE TRIGGER trig_00_org_immutable BEFORE UPDATE ON public.allocation_rule_units
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_org_immutable();
CREATE TRIGGER trig_00_org_immutable BEFORE UPDATE ON public.allocation_rule_weights
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_org_immutable();

-- ------------------------------------------------------------- RLS ---------
ALTER TABLE public.blocks                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allocation_rules        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allocation_rule_units   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allocation_rule_weights ENABLE ROW LEVEL SECURITY;

CREATE POLICY blocks_select ON public.blocks FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));
CREATE POLICY blocks_insert ON public.blocks FOR INSERT TO authenticated
  WITH CHECK (public.can_write(organization_id));
CREATE POLICY blocks_update ON public.blocks FOR UPDATE TO authenticated
  USING (public.can_write(organization_id)) WITH CHECK (public.can_write(organization_id));
CREATE POLICY blocks_delete ON public.blocks FOR DELETE TO authenticated
  USING (public.can_write(organization_id));

CREATE POLICY allocation_rules_select ON public.allocation_rules FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));
CREATE POLICY allocation_rules_insert ON public.allocation_rules FOR INSERT TO authenticated
  WITH CHECK (public.can_write(organization_id));
CREATE POLICY allocation_rules_update ON public.allocation_rules FOR UPDATE TO authenticated
  USING (public.can_write(organization_id)) WITH CHECK (public.can_write(organization_id));
CREATE POLICY allocation_rules_delete ON public.allocation_rules FOR DELETE TO authenticated
  USING (public.can_write(organization_id));

CREATE POLICY allocation_rule_units_select ON public.allocation_rule_units FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));
CREATE POLICY allocation_rule_units_insert ON public.allocation_rule_units FOR INSERT TO authenticated
  WITH CHECK (public.can_write(organization_id));
CREATE POLICY allocation_rule_units_update ON public.allocation_rule_units FOR UPDATE TO authenticated
  USING (public.can_write(organization_id)) WITH CHECK (public.can_write(organization_id));
CREATE POLICY allocation_rule_units_delete ON public.allocation_rule_units FOR DELETE TO authenticated
  USING (public.can_write(organization_id));

CREATE POLICY allocation_rule_weights_select ON public.allocation_rule_weights FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));
CREATE POLICY allocation_rule_weights_insert ON public.allocation_rule_weights FOR INSERT TO authenticated
  WITH CHECK (public.can_write(organization_id));
CREATE POLICY allocation_rule_weights_update ON public.allocation_rule_weights FOR UPDATE TO authenticated
  USING (public.can_write(organization_id)) WITH CHECK (public.can_write(organization_id));
CREATE POLICY allocation_rule_weights_delete ON public.allocation_rule_weights FOR DELETE TO authenticated
  USING (public.can_write(organization_id));

REVOKE ALL      ON public.blocks                  FROM anon;
REVOKE ALL      ON public.allocation_rules        FROM anon;
REVOKE ALL      ON public.allocation_rule_units   FROM anon;
REVOKE ALL      ON public.allocation_rule_weights FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.blocks                  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.allocation_rules        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.allocation_rule_units   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.allocation_rule_weights TO authenticated;

REVOKE TRUNCATE ON public.blocks                  FROM authenticated;
REVOKE TRUNCATE ON public.allocation_rules        FROM authenticated;
REVOKE TRUNCATE ON public.allocation_rule_units   FROM authenticated;
REVOKE TRUNCATE ON public.allocation_rule_weights FROM authenticated;

REVOKE ALL ON FUNCTION public.fn_building_default_rule()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_block_building_immutable() FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.buildings.total_tantiemes IS
  'Declaratieve controlewaarde uit het règlement de copropriété. Sinds m15 NIET langer de rekennoemer: die is de som van de gewichten van de daadwerkelijk deelnemende lots binnen de scope.';
COMMENT ON COLUMN public.allocation_rules.weight_source IS
  'Discriminator. Kindtabellen zijn hieraan vastgeankerd via composite FK, zodat een regel op units.tantiemes per constructie geen eigen gewichten kan dragen.';
COMMENT ON COLUMN public.ownership.is_primary_debtor IS
  'Aangewezen debiteur bij mede-eigendom. De volledige lot-allocatie gaat naar deze eigenaar; share wordt vastgelegd maar niet gesplitst. Zie docs/known-issues.md.';

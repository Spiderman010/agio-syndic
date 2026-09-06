-- ============================================================================
-- Agio Syndic — m30: gecontroleerde eigendomsmutaties
-- ============================================================================
--
-- Eigendom (`ownership`) was tot nu toe rechtstreeks muteerbaar via de Data API:
-- `anon` en `authenticated` hadden INSERT, UPDATE en DELETE, en de policies
-- lieten dat toe zolang `can_write` op de gebouworganisatie gold. Daarmee kon
-- een schrijvende gebruiker buiten elke bedoelde regel om een einddatum zetten,
-- een lopende eigendomsrij verwijderen, een lot zonder eigenaar achterlaten of
-- historie herschrijven. Een RPC toevoegen zonder die paden te sluiten is geen
-- beveiliging: "de UI gebruikt de RPC" is een afspraak, geen grens.
--
-- Deze migratie maakt de database de enige plek waar de regels leven.
--
--   1. preflight          — fail-closed op bestaande conflicten, alleen aantallen
--   2. tenantsleutel      — `ownership.organization_id`, onveranderlijk en FK-vast
--   3. btree_gist         — in het bestaande `extensions`-schema
--   4. exclusion          — primaire perioden per lot mogen nooit overlappen
--   5. exclusion          — dezelfde eigenaar nooit twee keer tegelijk op een lot
--   6. historieguard      — DELETE verboden, UPDATE alleen "periode afsluiten"
--   7. link_first_owner   — eerste koppeling van een nog ongekoppeld lot
--   8. transfer_ownership — atomaire overdracht met stale-writebescherming
--   9. rechten            — directe DML dicht, alles via de twee RPC's
--  10. postcheck          — de migratie bewijst haar eigen eindtoestand
--
-- ── DATUMSEMANTIEK ─────────────────────────────────────────────────────────
--
-- Beide grenzen zijn INCLUSIEF. Dat is niet gekozen maar afgelezen uit de
-- bestaande verdeelmotor `fn_alloc_resolve_owner`:
--
--     start_date <= d AND (end_date IS NULL OR end_date >= d)
--
-- `end_date` is dus de LAATSTE eigendomsdag. Een overdracht op datum D sluit de
-- oude periode op D-1 en opent de nieuwe op D.
--
-- ── WAAROM GEEN TOEKOMSTIGE DATUMS ─────────────────────────────────────────
--
-- De applicatie bepaalt "de actuele eigenaar" op drie plaatsen met
-- `end_date IS NULL`, en de bestaande partiele index
-- `ownership_primary_active_idx` doet hetzelfde. Dat is iets anders dan "actief
-- op vandaag". Bij een toekomstgedateerde overdracht lopen die twee uiteen: de
-- nieuwe rij zou al als actuele eigenaar tonen terwijl de verdeelmotor terecht
-- nog de oude aanwijst. In plaats van een vierde waarheid toe te voegen, sluit
-- deze migratie het gat: geen enkele eigendomsrij mag een datum in de toekomst
-- dragen. Daarmee zijn "end_date IS NULL" en "actief op CURRENT_DATE" per
-- constructie hetzelfde. Geplande toekomstige overdrachten vallen bewust buiten
-- deze sprint.
--
-- ── MEDE-EIGENDOM ──────────────────────────────────────────────────────────
--
-- Meerdere gelijktijdige eigenaars per lot blijven STRUCTUREEL toegestaan; zie
-- docs/known-issues.md paragraaf 0. Ze krijgen alleen geen API-pad: beide RPC's
-- maken uitsluitend een volledige, primaire rij, en overdracht bij
-- mede-eigendom wordt geweigerd in plaats van geraden.
-- ============================================================================


-- ─────────────────────────────────────────────────────────── 1. preflight ───
-- Fail-closed. Bestaande conflicten worden NIET automatisch gerepareerd en niet
-- gemaskeerd: de migratie stopt en rapporteert uitsluitend AANTALLEN, zodat er
-- geen identifiers of persoonsgegevens in een migratielog belanden.
DO $preflight$
DECLARE
  n_primair  int;
  n_lots     int;
  n_dubbel   int;
  n_toekomst int;
BEGIN
  SELECT count(*), count(DISTINCT a.unit_id) INTO n_primair, n_lots
    FROM public.ownership a
    JOIN public.ownership b
      ON a.unit_id = b.unit_id
     AND a.id < b.id
     AND a.is_primary_debtor
     AND b.is_primary_debtor
     AND daterange(a.start_date, a.end_date, '[]')
      && daterange(b.start_date, b.end_date, '[]');

  SELECT count(*) INTO n_dubbel
    FROM public.ownership a
    JOIN public.ownership b
      ON a.unit_id  = b.unit_id
     AND a.owner_id = b.owner_id
     AND a.id < b.id
     AND daterange(a.start_date, a.end_date, '[]')
      && daterange(b.start_date, b.end_date, '[]');

  SELECT count(*) INTO n_toekomst
    FROM public.ownership
   WHERE start_date > CURRENT_DATE
      OR (end_date IS NOT NULL AND end_date > CURRENT_DATE);

  IF n_primair > 0 OR n_dubbel > 0 OR n_toekomst > 0 THEN
    RAISE EXCEPTION
      'M30_PREFLIGHT_FAILED: overlappende primaire perioden=% (lots=%), dubbele eigenaarperioden=%, toekomstgedateerde rijen=%. Er is niets gewijzigd; ruim deze rijen eerst op.',
      n_primair, n_lots, n_dubbel, n_toekomst
      USING ERRCODE = '23514';
  END IF;
END $preflight$;


-- ─────────────────────────────────────────────────────── 2. tenantsleutel ───
--
-- WAAROM `ownership` EEN EIGEN `organization_id` KRIJGT
--
-- De historieguard hieronder moet bij een DELETE weten tot welke organisatie de
-- rij hoort. Die vraag werd eerder beantwoord door de OUDERS te bevragen
-- (owners, of units -> buildings). Dat is aantoonbaar onjuist: tijdens een
-- volledige organisatiecascade verwijdert PostgreSQL owners, units en buildings
-- VOORDAT de bijbehorende eigendomsrijen aan de beurt zijn. Beide ouderketens
-- zijn dan al onzichtbaar, de organisatie kan niet meer worden herleid, en de
-- fail-closed-tak blokkeert precies de cascade die had moeten slagen.
--
-- De sleutel staat daarom vanaf nu OP DE RIJ ZELF. `OLD.organization_id` is bij
-- een DELETE altijd beschikbaar, ongeacht wat de cascade al heeft opgeruimd.
--
-- WAAROM DIE KOLOM NIET TE VERVALSEN IS
--
--   1. de samengestelde FK naar `owners (id, organization_id)` maakt het
--      structureel onmogelijk dat de kolom een ANDERE organisatie noemt dan de
--      eigenaar. Dit is het bewezen patroon uit m8 sectie 7 en werkt ongeacht
--      applicatiecode, RLS of rol;
--   2. `trig_00_ownership_tenant_guard` (m8) dwingt al af dat de eigenaar en het
--      lot in dezelfde organisatie zitten. Samen pinnen 1 en 2 de kolom vast op
--      exact een tenant;
--   3. de kolom staat in de immutabiliteitslijst van de UPDATE-tak hieronder en
--      kan dus niet naar een andere organisatie worden omgezet;
--   4. de FK naar `organizations` maakt de tenantcascade expliciet in plaats van
--      impliciet via de ouderketen.
--
-- De oplossing leunt bewust NIET op triggervolgorde, `pg_trigger_depth()`, een
-- instelbare GUC, foutmeldingstekst of een rolnaam. Ze rust uitsluitend op
-- declaratieve constraints plus een waarde die op de rij zelf staat.
ALTER TABLE public.ownership ADD COLUMN IF NOT EXISTS organization_id uuid;

-- Backfill vanuit de eigenaar. m8 garandeert dat de eigenaar en het lot in
-- dezelfde organisatie zitten, dus deze bron is eenduidig.
UPDATE public.ownership o
   SET organization_id = w.organization_id
  FROM public.owners w
 WHERE w.id = o.owner_id
   AND o.organization_id IS DISTINCT FROM w.organization_id;

-- Fail-closed validatie van de backfill. Rapporteert uitsluitend aantallen:
-- geen id's en geen persoonsgegevens in het migratielog.
DO $tenantcheck$
DECLARE n_leeg int; n_mismatch int;
BEGIN
  SELECT count(*) INTO n_leeg
    FROM public.ownership WHERE organization_id IS NULL;
  IF n_leeg > 0 THEN
    RAISE EXCEPTION
      'M30_TENANT_BACKFILL_FAILED: % eigendomsrij(en) zonder herleidbare organisatie.', n_leeg
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO n_mismatch
    FROM public.ownership o
    JOIN public.units u     ON u.id = o.unit_id
    JOIN public.buildings b ON b.id = u.building_id
   WHERE b.organization_id <> o.organization_id;
  IF n_mismatch > 0 THEN
    RAISE EXCEPTION
      'M30_TENANT_MISMATCH: % eigendomsrij(en) waarvan lot en eigenaar in verschillende organisaties zitten.', n_mismatch
      USING ERRCODE = '23514';
  END IF;
END $tenantcheck$;

ALTER TABLE public.ownership ALTER COLUMN organization_id SET NOT NULL;

-- Samengestelde FK: bewakend, NO ACTION. Het ON DELETE-gedrag blijft bij de
-- bestaande enkelvoudige FK op `owner_id`, precies zoals m8 sectie 7 het doet.
ALTER TABLE public.ownership
  DROP CONSTRAINT IF EXISTS ownership_owner_org_fk;
ALTER TABLE public.ownership
  ADD CONSTRAINT ownership_owner_org_fk
  FOREIGN KEY (owner_id, organization_id)
  REFERENCES public.owners (id, organization_id);

-- Expliciete tenantcascade. Hiermee bereikt een organisatieverwijdering de
-- eigendomsrijen ook rechtstreeks, niet alleen via de ouderketen.
ALTER TABLE public.ownership
  DROP CONSTRAINT IF EXISTS ownership_org_fk;
ALTER TABLE public.ownership
  ADD CONSTRAINT ownership_org_fk
  FOREIGN KEY (organization_id)
  REFERENCES public.organizations (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ownership_org_idx ON public.ownership (organization_id);

COMMENT ON COLUMN public.ownership.organization_id IS
  'Tenantsleutel op de rij zelf. Onveranderlijk; door samengestelde FK vastgepind op de organisatie van de eigenaar. Maakt de cascadebeslissing in fn_guard_ownership_history onafhankelijk van ouderrijen die een cascade al heeft verwijderd.';


-- ──────────────────────────────────────────────────────────── 3. extensie ───
-- Projectconventie: extensies staan in `extensions`, niet in `public`
-- (pgcrypto, uuid-ossp en pg_stat_statements staan daar al).
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;


-- ────────────────────────────────────────────── 4/5. exclusion constraints ───
--
-- WAAROM DE EERSTE ALLEEN OVER PRIMAIRE PERIODEN GAAT
--
-- Een constraint over ALLE rijen zou mede-eigendom onmogelijk maken: twee
-- gelijktijdige mede-eigenaars zijn per definitie een overlap. De financiele
-- eenduidigheid hangt uitsluitend aan de AANGEWEZEN DEBITEUR — dat is de rij
-- die `fn_alloc_resolve_owner` kiest en die de volledige vordering draagt. Daar
-- mag nooit overlap zijn, ook niet tussen twee gesloten perioden.
--
-- De bestaande partiele index `ownership_primary_active_idx` dekt alleen het
-- geval "twee OPEN primaire rijen". Deze constraint dekt ook twee gesloten
-- perioden of een gesloten plus een open periode, en is daarmee strikt sterker.
ALTER TABLE public.ownership
  ADD CONSTRAINT ownership_primary_period_excl
  EXCLUDE USING gist (
    unit_id extensions.gist_uuid_ops WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (is_primary_debtor);

-- Dezelfde eigenaar mag niet twee keer tegelijk op hetzelfde lot staan. De
-- bestaande UNIQUE (unit_id, owner_id, start_date) laat dat wel toe zodra de
-- startdatums verschillen; twee overlappende perioden van dezelfde persoon zijn
-- geen mede-eigendom maar een administratieve fout. Een lot terugkopen na een
-- verkoop blijft mogelijk: [jan, jun] en [sep, oneindig) overlappen niet.
ALTER TABLE public.ownership
  ADD CONSTRAINT ownership_owner_period_excl
  EXCLUDE USING gist (
    unit_id  extensions.gist_uuid_ops WITH =,
    owner_id extensions.gist_uuid_ops WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );


-- ─────────────────────────────────────────────────────── 6. historieguard ───
--
-- Databasebreed, dus ook voor `postgres`, de SQL-editor en toekomstige RPC's.
-- De Data API wordt in stap 8 al op grantniveau gesloten; deze trigger
-- beschermt de laag daaronder tegen ONBEDOELDE privileged writes. Hij is
-- uitdrukkelijk GEEN bescherming tegen een kwaadwillende beheerder: de
-- tabeleigenaar kan triggers uitschakelen. Dat is een vertrouwde beheergrens,
-- geen sluitende verdediging.
--
-- ── DE CASCADEBESLISSING ───────────────────────────────────────────────────
--
-- Een DELETE op `ownership` komt zelden rechtstreeks; hij lift mee op een ouder:
--
--     owners        --CASCADE--> ownership
--     units         --CASCADE--> ownership
--     buildings     --CASCADE--> units --CASCADE--> ownership
--     organizations --CASCADE--> owners/buildings --> ... --> ownership
--
-- Een naieve uitzondering ("mijn directe ouder bestaat niet meer, dus dit is een
-- cascade") is precies de bypass die hier wordt gesloten: een schrijvende
-- gebruiker verwijdert dan gewoon de eigenaar of het lot en de eigendomsketen
-- verdampt mee.
--
-- Alleen de VOLLEDIGE tenantverwijdering is veilig, want daarbij verdwijnt de
-- hele organisatie inclusief gebouwen, lots en eigenaars; er blijft geen lot
-- over waarop `link_first_owner()` misleidend kan worden gebruikt. De vraag is
-- dus niet "bestaat mijn directe ouder nog" maar "bestaat de ORGANISATIE nog".
--
-- EERDERE, ONJUISTE AANPAK — bewaard omdat de reden ertoe doet.
--
-- De organisatie werd herleid via de ouderketen, in de veronderstelling dat er
-- per DELETE altijd precies een ouder overleeft. Een lokale integratietest op
-- PostgreSQL 17 weerlegde dat: bij `DELETE FROM organizations` zijn owners,
-- units EN buildings al verwijderd voordat de eigendomsrijen aan de beurt zijn.
-- Beide ketens leveren dan NULL op, de fail-closed-tak sluit, en de volledige
-- organisatiecascade wordt geblokkeerd — terwijl juist die had moeten slagen.
--
-- HUIDIGE AANPAK — de tenantsleutel staat op de rij zelf (sectie 2).
--
--   losse owner-delete    -> OLD.organization_id -> organisatie bestaat -> WEIGEREN
--   losse unit-delete     -> OLD.organization_id -> organisatie bestaat -> WEIGEREN
--   losse building-delete -> OLD.organization_id -> organisatie bestaat -> WEIGEREN
--   organisatiecascade    -> OLD.organization_id -> organisatie is weg   -> TOESTAAN
--
-- `OLD.organization_id` is NOT NULL en staat op de rij, dus de beslissing hangt
-- niet meer af van wat de cascade al heeft opgeruimd. Er is geen ambigue
-- toestand meer waarin de organisatie onherleidbaar is.
--
-- De enige manier waarop de escape opengaat, is dat de organisatierij werkelijk
-- niet meer bestaat. Dat betekent per definitie dat de tenant wordt verwijderd,
-- en die verwijdering neemt via `ownership_org_fk` diezelfde eigendomsrijen mee.
-- Er is dus geen tussentoestand waarin iemand selectief rijen kan wissen.
--
-- De functie moet hiervoor tabellen lezen zonder afhankelijk te zijn van
-- RLS-zichtbaarheid; daarom SECURITY DEFINER met een lege search_path en
-- volledig gekwalificeerde objecten. EXECUTE wordt van iedereen ingetrokken:
-- de functie is uitsluitend als trigger bruikbaar.
CREATE OR REPLACE FUNCTION public.fn_guard_ownership_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  -- ── DELETE ───────────────────────────────────────────────────────────────
  IF TG_OP = 'DELETE' THEN
    -- De tenantsleutel staat op de rij zelf; er wordt GEEN ouder bevraagd, want
    -- die kan door de lopende cascade al verwijderd zijn. Zie sectie 2.
    --
    -- Bestaat de organisatie nog, dan is dit een losse owner-, unit- of
    -- building-delete en mag de eigendomsketen niet worden gewist.
    IF EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'OWNERSHIP_DELETE_FORBIDDEN' USING ERRCODE = '23514';
    END IF;

    -- De organisatie is al verdwenen: dit is een volledige tenantverwijdering.
    RETURN OLD;
  END IF;

  -- ── INSERT ───────────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    IF NEW.start_date > CURRENT_DATE
    OR (NEW.end_date IS NOT NULL AND NEW.end_date > CURRENT_DATE) THEN
      RAISE EXCEPTION 'OWNERSHIP_DATE_FUTURE' USING ERRCODE = '23514';
    END IF;

    -- Comfortinvulling voor schrijvers die de tenantsleutel niet meegeven. Een
    -- WEL meegegeven waarde blijft staan en wordt door `ownership_owner_org_fk`
    -- gecontroleerd; deze tak kan een verkeerde waarde dus niet maskeren.
    IF NEW.organization_id IS NULL THEN
      SELECT w.organization_id INTO NEW.organization_id
        FROM public.owners w WHERE w.id = NEW.owner_id;
    END IF;

    RETURN NEW;
  END IF;

  -- ── UPDATE ───────────────────────────────────────────────────────────────
  -- Alles behalve `end_date` ligt vast. Deze controle staat VOOR de
  -- einddatumtakken, zodat ook een `NULL -> NULL`-wijziging die stiekem een
  -- andere kolom meeneemt wordt geweigerd.
  IF NEW.id                IS DISTINCT FROM OLD.id
  OR NEW.unit_id           IS DISTINCT FROM OLD.unit_id
  OR NEW.owner_id          IS DISTINCT FROM OLD.owner_id
  OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id
  OR NEW.start_date        IS DISTINCT FROM OLD.start_date
  OR NEW.share             IS DISTINCT FROM OLD.share
  OR NEW.is_primary_debtor IS DISTINCT FROM OLD.is_primary_debtor
  OR NEW.created_at        IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OWNERSHIP_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD.end_date IS NOT NULL THEN
    -- Gesloten periode: verschuiven en heropenen allebei geweigerd. Een exacte
    -- no-op mag passeren; die verandert niets en is functioneel overbodig.
    IF NEW.end_date IS DISTINCT FROM OLD.end_date THEN
      RAISE EXCEPTION 'OWNERSHIP_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Lopende periode: end_date mag NULL blijven of eenmalig worden gezet.
  IF NEW.end_date IS NOT NULL AND NEW.end_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'OWNERSHIP_DATE_FUTURE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trig_01_ownership_history ON public.ownership;
CREATE TRIGGER trig_01_ownership_history
  BEFORE INSERT OR UPDATE OR DELETE ON public.ownership
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_ownership_history();


-- ────────────────────────────────────────────────────── 7. eerste koppeling ──
--
-- "Eerste koppeling" betekent hier: er bestaat NOG GEEN ENKELE eigendomsrij voor
-- dit lot. Historie zonder actuele eigenaar is een andere toestand en krijgt
-- bewust geen pad; stilzwijgend een nieuwe historie beginnen zou de bestaande
-- keten onzichtbaar maken.
--
-- Foutcodes zijn vast en onthullen niets. Een onbekend lot en een lot waarvoor
-- de aanroeper geen schrijfrecht heeft geven ALLEBEI `OWNERSHIP_FORBIDDEN`;
-- anders is de functie een bestaansorakel op andermans gegevens. Datzelfde geldt
-- voor een onbekende en een cross-tenant eigenaar.
CREATE OR REPLACE FUNCTION public.link_first_owner(
  p_unit_id    uuid,
  p_owner_id   uuid,
  p_start_date date
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_org       uuid;
  v_owner_org uuid;
  v_id        uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'OWNERSHIP_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  -- Het lot vergrendelen serialiseert alle eigendomsmutaties op dit lot.
  SELECT b.organization_id INTO v_org
    FROM public.units u
    JOIN public.buildings b ON b.id = u.building_id
   WHERE u.id = p_unit_id
     FOR UPDATE OF u;

  IF v_org IS NULL OR NOT public.can_write(v_org) THEN
    RAISE EXCEPTION 'OWNERSHIP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT o.organization_id INTO v_owner_org
    FROM public.owners o WHERE o.id = p_owner_id;
  IF v_owner_org IS NULL OR v_owner_org <> v_org THEN
    RAISE EXCEPTION 'OWNERSHIP_OWNER_INVALID' USING ERRCODE = '23514';
  END IF;

  IF p_start_date IS NULL THEN
    RAISE EXCEPTION 'OWNERSHIP_DATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF p_start_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'OWNERSHIP_DATE_FUTURE' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ownership WHERE unit_id = p_unit_id) THEN
    RAISE EXCEPTION 'OWNERSHIP_HISTORY_EXISTS' USING ERRCODE = '23514';
  END IF;

  -- `organization_id` wordt expliciet gezet, niet aan de comfortinvulling in de
  -- historieguard overgelaten: hier is de tenant al bewezen via can_write().
  INSERT INTO public.ownership
    (owner_id, unit_id, organization_id, share, start_date, end_date, is_primary_debtor)
  VALUES
    (p_owner_id, p_unit_id, v_org, 1, p_start_date, NULL, true)
  RETURNING id INTO v_id;

  RETURN v_id;
END $fn$;


-- ────────────────────────────────────────────────────────── 8. overdracht ────
--
-- ── WAAROM EEN VERWACHTE HUIDIGE RIJ ───────────────────────────────────────
--
-- Twee beheerders kunnen dezelfde pagina openen. Draagt A eerst over en stuurt B
-- daarna een verouderd formulier in, dan zou B de INMIDDELS NIEUWE eigenaar
-- opnieuw overdragen zonder het te merken. `p_expected_current_ownership_id`
-- maakt van die stille fout een expliciete weigering: het lot wordt vergrendeld,
-- de actuele rij wordt DAARNA opnieuw gelezen, en wijkt die af van wat de
-- gebruiker zag, dan gebeurt er niets en volgt `OWNERSHIP_STALE`.
--
-- ── WAAROM ALLEEN VOLLEDIGE ENKELVOUDIGE EIGENDOM ──────────────────────────
--
-- De nieuwe rij krijgt `share = 1` en `is_primary_debtor = true`. Dat mag alleen
-- als de oude situatie aantoonbaar hetzelfde was; anders zou de overdracht een
-- gedeeltelijk of niet-primair belang stilzwijgend promoveren tot volledige
-- eigendom. Er wordt niets genormaliseerd: bij afwijking nul wijzigingen.
--
-- ── WAAROM DE HISTORIE ONGEMOEID BLIJFT ────────────────────────────────────
--
-- `charge_allocations` legt `owner_id`, `ownership_id` en `ownership_share_ppm`
-- vast als snapshot, en `fn_guard_ca_snapshot_immutable` weigert elke wijziging
-- daarvan. `payments.owner_id` ligt na journalisering vast. FIFO matcht op
-- `ca.owner_id = NEW.owner_id`, dus een betaling van de nieuwe eigenaar raakt
-- nooit een open post van de oude. Deze functie schrijft uitsluitend in
-- `ownership` en kan die tabellen dus per constructie niet verplaatsen.
CREATE OR REPLACE FUNCTION public.transfer_ownership(
  p_unit_id                       uuid,
  p_expected_current_ownership_id uuid,
  p_new_owner_id                  uuid,
  p_transfer_date                 date
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_org       uuid;
  v_owner_org uuid;
  v_n         int;
  v_cur       public.ownership%ROWTYPE;
  v_new       uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'OWNERSHIP_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT b.organization_id INTO v_org
    FROM public.units u
    JOIN public.buildings b ON b.id = u.building_id
   WHERE u.id = p_unit_id
     FOR UPDATE OF u;

  IF v_org IS NULL OR NOT public.can_write(v_org) THEN
    RAISE EXCEPTION 'OWNERSHIP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT o.organization_id INTO v_owner_org
    FROM public.owners o WHERE o.id = p_new_owner_id;
  IF v_owner_org IS NULL OR v_owner_org <> v_org THEN
    RAISE EXCEPTION 'OWNERSHIP_OWNER_INVALID' USING ERRCODE = '23514';
  END IF;

  IF p_transfer_date IS NULL THEN
    RAISE EXCEPTION 'OWNERSHIP_DATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF p_transfer_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'OWNERSHIP_DATE_FUTURE' USING ERRCODE = '23514';
  END IF;
  IF p_expected_current_ownership_id IS NULL THEN
    RAISE EXCEPTION 'OWNERSHIP_STALE' USING ERRCODE = '23514';
  END IF;

  -- Pas NA de vergrendeling lezen; anders is de controle zelf verouderd.
  SELECT count(*) INTO v_n
    FROM public.ownership
   WHERE unit_id = p_unit_id AND end_date IS NULL;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'OWNERSHIP_NO_CURRENT' USING ERRCODE = '23514';
  END IF;
  IF v_n > 1 THEN
    RAISE EXCEPTION 'OWNERSHIP_COOWNED' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_cur
    FROM public.ownership
   WHERE unit_id = p_unit_id AND end_date IS NULL
     FOR UPDATE;

  IF v_cur.id <> p_expected_current_ownership_id THEN
    RAISE EXCEPTION 'OWNERSHIP_STALE' USING ERRCODE = '23514';
  END IF;
  IF NOT v_cur.is_primary_debtor THEN
    RAISE EXCEPTION 'OWNERSHIP_NOT_PRIMARY' USING ERRCODE = '23514';
  END IF;
  IF v_cur.share <> 1 THEN
    RAISE EXCEPTION 'OWNERSHIP_NOT_FULL' USING ERRCODE = '23514';
  END IF;
  IF v_cur.owner_id = p_new_owner_id THEN
    RAISE EXCEPTION 'OWNERSHIP_SAME_OWNER' USING ERRCODE = '23514';
  END IF;
  IF p_transfer_date <= v_cur.start_date THEN
    RAISE EXCEPTION 'OWNERSHIP_DATE_NOT_AFTER_START' USING ERRCODE = '23514';
  END IF;

  -- De enige toegestane overgang. Faalt de INSERT, dan rolt het impliciete
  -- subtransactieblok ook de UPDATE terug: het lot blijft nooit zonder eigenaar.
  UPDATE public.ownership
     SET end_date = p_transfer_date - 1
   WHERE id = v_cur.id;

  INSERT INTO public.ownership
    (owner_id, unit_id, organization_id, share, start_date, end_date, is_primary_debtor)
  VALUES
    (p_new_owner_id, p_unit_id, v_org, 1, p_transfer_date, NULL, true)
  RETURNING id INTO v_new;

  RETURN v_new;

EXCEPTION
  WHEN exclusion_violation OR unique_violation THEN
    -- Overlap met bestaande historie. De melding wordt gesaneerd: geen
    -- rijwaarden, geen constraintnaam en geen UUID's naar de client.
    RAISE EXCEPTION 'OWNERSHIP_OVERLAP' USING ERRCODE = '23514';
END $fn$;


-- ───────────────────────────────────────────────────────────── 9. rechten ────
--
-- Een begrijpelijk model: de API LEEST via RLS en SCHRIJFT via de twee RPC's.
-- Privileged paden vallen onder de trigger uit stap 5.
--
-- De REVOKE's zijn niet optioneel: `pg_default_acl` kent nieuwe functies in
-- `public` automatisch EXECUTE toe aan anon, authenticated en service_role.
-- Zonder deze regels ontstaat precies de nutteloze grant die we niet willen —
-- een service-rolecall strandt toch op `auth.uid() IS NULL`.
REVOKE ALL ON FUNCTION public.fn_guard_ownership_history()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.link_first_owner(uuid, uuid, date)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.transfer_ownership(uuid, uuid, uuid, date)
  FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.link_first_owner(uuid, uuid, date)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_ownership(uuid, uuid, uuid, date) TO authenticated;

-- De applicatie gebruikt uitsluitend de anon-key; er bestaat geen
-- service-roleclient. Directe DML is daarmee voor niemand nog nodig.
-- SELECT blijft voor service_role zodat de Supabase-tabeleditor leesbaar blijft.
REVOKE ALL ON public.ownership FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.ownership FROM authenticated, service_role;

-- De writepolicies worden VERWIJDERD in plaats van uitgehold. RLS blijft aan,
-- dus een per ongeluk teruggegeven grant loopt alsnog fail-closed: zonder
-- policy weigert Postgres de rij.
DROP POLICY IF EXISTS ownership_insert ON public.ownership;
DROP POLICY IF EXISTS ownership_update ON public.ownership;
DROP POLICY IF EXISTS ownership_delete ON public.ownership;
-- ownership_select blijft ongewijzigd.

COMMENT ON FUNCTION public.fn_guard_ownership_history() IS
  'Eigendomshistorie is onwijzigbaar. DELETE is verboden zodra de bovenliggende organisatie nog bestaat; dat sluit de bypass waarbij het verwijderen van een owner, unit of building de eigendomsketen meesleepte. Alleen binnen een VOLLEDIGE organisatiecascade mag een eigendomsrij verdwijnen. UPDATE staat uitsluitend end_date NULL -> datum <= CURRENT_DATE toe.';
COMMENT ON FUNCTION public.link_first_owner(uuid, uuid, date) IS
  'Koppelt een eerste eigenaar aan een lot ZONDER enige eigendomshistorie. Vaste foutcodes, geen bestaansorakel. Enige toegestane insertpad voor authenticated.';
COMMENT ON FUNCTION public.transfer_ownership(uuid, uuid, uuid, date) IS
  'Atomaire eigendomsoverdracht: sluit de huidige periode op D-1 en opent een nieuwe op D. Vereist p_expected_current_ownership_id tegen stale writes, en exact een volledige primaire eigenaar. Historische allocaties, betalingen en journaalposten blijven onaangeroerd.';
COMMENT ON CONSTRAINT ownership_primary_period_excl ON public.ownership IS
  'Aangewezen debiteuren mogen per lot nooit overlappende perioden hebben, ook niet tussen gesloten perioden. Mede-eigendom blijft mogelijk: niet-primaire rijen vallen buiten deze constraint.';


-- ─────────────────────────────────────────────────────────── 10. postcheck ────
-- De migratie bewijst haar eigen eindtoestand SEMANTISCH, niet door te tellen.
DO $postcheck$
DECLARE p record; n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'public' AND c.relname = 'ownership' AND c.relrowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION 'M30_POSTCHECK: RLS staat uit op ownership' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'ownership';
  IF n <> 1 THEN
    RAISE EXCEPTION 'M30_POSTCHECK: % policies op ownership, verwacht 1', n USING ERRCODE = '23514';
  END IF;

  SELECT * INTO p FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'ownership';
  IF p.policyname  <> 'ownership_select'
  OR p.cmd         <> 'SELECT'
  OR p.permissive  <> 'PERMISSIVE'
  OR p.roles::text <> '{authenticated}' THEN
    RAISE EXCEPTION 'M30_POSTCHECK: ownership_select wijkt af (%, %, %)',
      p.policyname, p.cmd, p.roles::text USING ERRCODE = '23514';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.ownership', 'SELECT')
  OR has_table_privilege('authenticated', 'public.ownership', 'INSERT')
  OR has_table_privilege('authenticated', 'public.ownership', 'UPDATE')
  OR has_table_privilege('authenticated', 'public.ownership', 'DELETE') THEN
    RAISE EXCEPTION 'M30_POSTCHECK: authenticated heeft niet uitsluitend SELECT' USING ERRCODE = '23514';
  END IF;

  IF has_table_privilege('anon', 'public.ownership', 'SELECT')
  OR has_table_privilege('anon', 'public.ownership', 'INSERT')
  OR has_table_privilege('anon', 'public.ownership', 'UPDATE')
  OR has_table_privilege('anon', 'public.ownership', 'DELETE') THEN
    RAISE EXCEPTION 'M30_POSTCHECK: anon heeft nog tabelprivileges' USING ERRCODE = '23514';
  END IF;

  IF has_table_privilege('service_role', 'public.ownership', 'INSERT')
  OR has_table_privilege('service_role', 'public.ownership', 'UPDATE')
  OR has_table_privilege('service_role', 'public.ownership', 'DELETE') THEN
    RAISE EXCEPTION 'M30_POSTCHECK: service_role heeft nog DML op ownership' USING ERRCODE = '23514';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.link_first_owner(uuid,uuid,date)', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.transfer_ownership(uuid,uuid,uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M30_POSTCHECK: authenticated mist EXECUTE op de ownership-RPC-s' USING ERRCODE = '23514';
  END IF;

  IF has_function_privilege('anon',         'public.link_first_owner(uuid,uuid,date)', 'EXECUTE')
  OR has_function_privilege('anon',         'public.transfer_ownership(uuid,uuid,uuid,date)', 'EXECUTE')
  OR has_function_privilege('public',       'public.link_first_owner(uuid,uuid,date)', 'EXECUTE')
  OR has_function_privilege('public',       'public.transfer_ownership(uuid,uuid,uuid,date)', 'EXECUTE')
  OR has_function_privilege('service_role', 'public.link_first_owner(uuid,uuid,date)', 'EXECUTE')
  OR has_function_privilege('service_role', 'public.transfer_ownership(uuid,uuid,uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M30_POSTCHECK: ongewenst EXECUTE-recht op een ownership-RPC' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.ownership'::regclass
       AND t.tgname  = 'trig_01_ownership_history'
       AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'M30_POSTCHECK: historieguard ontbreekt of staat uit' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.ownership'::regclass
     AND conname IN ('ownership_primary_period_excl', 'ownership_owner_period_excl');
  IF n <> 2 THEN
    RAISE EXCEPTION 'M30_POSTCHECK: exclusion constraint ontbreekt (% van 2)', n USING ERRCODE = '23514';
  END IF;

  -- Tenantsleutel: kolom NOT NULL, beide FK's aanwezig. Zonder deze drie valt de
  -- cascadebeslissing terug op een toestand die aantoonbaar niet werkt.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.ownership'::regclass
       AND attname  = 'organization_id'
       AND attnotnull
       AND NOT attisdropped) THEN
    RAISE EXCEPTION 'M30_POSTCHECK: ownership.organization_id ontbreekt of is nullable' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.ownership'::regclass
     AND contype  = 'f'
     AND conname IN ('ownership_owner_org_fk', 'ownership_org_fk');
  IF n <> 2 THEN
    RAISE EXCEPTION 'M30_POSTCHECK: tenant-FK ontbreekt (% van 2)', n USING ERRCODE = '23514';
  END IF;

  -- De tenantcascade moet echt CASCADE zijn; NO ACTION zou een organisatie
  -- onverwijderbaar maken zodra er eigendom bestaat.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ownership'::regclass
       AND conname  = 'ownership_org_fk'
       AND confdeltype = 'c') THEN
    RAISE EXCEPTION 'M30_POSTCHECK: ownership_org_fk cascadeert niet bij organisatieverwijdering' USING ERRCODE = '23514';
  END IF;
END $postcheck$;

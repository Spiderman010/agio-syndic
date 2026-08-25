-- m14 — Flexible allocation engine, deel 3: pure rekenkern
--
-- Geen enkele functie hier schrijft. fn_alloc_distribute is IMMUTABLE en puur:
-- dezelfde invoer geeft altijd exact dezelfde uitvoer, zonder tabeltoegang.

-- ------------------------------------------------------ centverdeling ------
-- Largest remainder in hele centen. Eerst vermenigvuldigen, dan delen; nergens
-- floating point.
--
-- Bewijs dat de som altijd klopt:
--   Sigma base = (C*D - Sigma rem)/D = C - Sigma rem/D. Zowel Sigma base als C
--   is geheel, dus Sigma rem is deelbaar door D. Met 0 <= rem_i < D volgt
--   0 <= R < n. R is dus nooit negatief (overallocatie is onmogelijk) en er
--   zijn altijd genoeg lots om R centen aan te geven.
--   Sigma amount_cents = (C - R) + R = C, per constructie.
--
-- Tie-breaker: remainder DESC, unit_id ASC. Bewust unit_id en niet label:
-- labelordening is collatie-afhankelijk en daarmee niet reproduceerbaar tussen
-- omgevingen; uuid-vergelijking is bytegewijs en dus stabiel.
CREATE OR REPLACE FUNCTION public.fn_alloc_distribute(
  p_unit_ids    uuid[],
  p_weights     bigint[],
  p_total_cents bigint)
RETURNS TABLE (
  unit_id         uuid,
  weight_micro    bigint,
  base_cents      bigint,
  remainder       bigint,
  remainder_rank  int,
  extra_cent      smallint,
  amount_cents    bigint,
  denominator     bigint,
  remainder_total int)
LANGUAGE sql IMMUTABLE AS $fn$
  WITH src AS (
    SELECT u.uid AS unit_id, w.wgt AS weight
      FROM unnest(p_unit_ids) WITH ORDINALITY AS u(uid, i)
      JOIN unnest(p_weights)  WITH ORDINALITY AS w(wgt, i) USING (i)
  ),
  d AS (SELECT sum(weight)::bigint AS den FROM src),
  calc AS (
    SELECT s.unit_id, s.weight, d.den,
           div(s.weight::numeric * p_total_cents, d.den::numeric)::bigint AS base,
           mod(s.weight::numeric * p_total_cents, d.den::numeric)::bigint AS rem
      FROM src s CROSS JOIN d
  ),
  r AS (
    SELECT c.*,
           (p_total_cents - sum(c.base) OVER ())::int AS rtot,
           row_number() OVER (ORDER BY c.rem DESC, c.unit_id ASC)::int AS rnk
      FROM calc c
  )
  SELECT r.unit_id, r.weight, r.base, r.rem, r.rnk,
         (CASE WHEN r.rnk <= r.rtot THEN 1 ELSE 0 END)::smallint,
         r.base + (CASE WHEN r.rnk <= r.rtot THEN 1 ELSE 0 END),
         r.den, r.rtot
    FROM r;
$fn$;

-- ------------------------------------------------ deelnemersverzameling ----
-- De scope bepaalt wie meedoet. allocation_rule_units betekent UITSLUITING bij
-- whole_building/block en INSLUITING bij selected_units; die betekenis is aan
-- de rij vastgepind via de composite FK op scope, dus zij kan niet kantelen.
CREATE OR REPLACE FUNCTION public.fn_alloc_scope_units(p_rule_id uuid)
RETURNS TABLE (unit_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT u.id
    FROM public.allocation_rules r
    JOIN public.units u ON u.building_id = r.building_id
   WHERE r.id = p_rule_id
     AND (r.scope <> 'block' OR u.block_id IS NOT DISTINCT FROM r.scope_block_id)
     AND (
       (r.scope IN ('whole_building','block')
         AND NOT EXISTS (SELECT 1 FROM public.allocation_rule_units aru
                          WHERE aru.rule_id = r.id AND aru.unit_id = u.id))
       OR
       (r.scope = 'selected_units'
         AND EXISTS (SELECT 1 FROM public.allocation_rule_units aru
                      WHERE aru.rule_id = r.id AND aru.unit_id = u.id))
     );
$fn$;

-- Lots binnen het gebouw (resp. blok) waarover de regel niets zegt. Alleen
-- betekenisvol bij selected_units, waar de scope niet zelfonderhoudend is.
CREATE OR REPLACE FUNCTION public.fn_alloc_uncovered_units(p_rule_id uuid)
RETURNS TABLE (unit_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT u.id
    FROM public.allocation_rules r
    JOIN public.units u ON u.building_id = r.building_id
   WHERE r.id = p_rule_id
     AND r.scope = 'selected_units'
     AND NOT EXISTS (SELECT 1 FROM public.allocation_rule_units aru
                      WHERE aru.rule_id = r.id AND aru.unit_id = u.id);
$fn$;

-- ---------------------------------------------------- eigenaarsresolutie ---
-- Drie reparaties tegenover de oude LIMIT 1 zonder ORDER BY:
--   * het datumfilter dekt nu ook end_date >= call_date, zodat een oproep met
--     terugwerkende kracht na een verkoop de juiste eigenaar vindt;
--   * de ordening eindigt op id ASC en is daarmee TOTAAL;
--   * is_primary_debtor geeft mede-eigendom een expliciete uitweg.
-- n_active wordt meegegeven zodat de aanroeper hard kan falen bij ambiguiteit
-- in plaats van stil een eigenaar te kiezen.
CREATE OR REPLACE FUNCTION public.fn_alloc_resolve_owner(p_unit uuid, p_call_date date)
RETURNS TABLE (ownership_id uuid, owner_id uuid, share_ppm int, n_active int, n_primary int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  WITH act AS (
    SELECT ow.id, ow.owner_id, ow.share, ow.start_date, ow.is_primary_debtor,
           round(ow.share * 1000000)::int AS ppm
      FROM public.ownership ow
     WHERE ow.unit_id = p_unit
       AND ow.start_date <= p_call_date
       AND (ow.end_date IS NULL OR ow.end_date >= p_call_date)
  )
  SELECT a.id, a.owner_id, a.ppm,
         (SELECT count(*) FROM act)::int,
         (SELECT count(*) FROM act WHERE is_primary_debtor)::int
    FROM act a
   ORDER BY a.is_primary_debtor DESC, a.share DESC, a.start_date DESC, a.id ASC
   LIMIT 1;
$fn$;

-- Intern gereedschap: geen van deze functies hoort via PostgREST aanroepbaar te
-- zijn. De preview-RPC in m15 is de enige die authenticated mag aanroepen, en
-- die draagt een eigen tenantcontrole.
REVOKE ALL ON FUNCTION public.fn_alloc_distribute(uuid[], bigint[], bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_alloc_scope_units(uuid)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_alloc_uncovered_units(uuid)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_alloc_resolve_owner(uuid, date)            FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_alloc_distribute(uuid[], bigint[], bigint) IS
  'Pure largest-remainder verdeling in hele centen, algoritmeversie 1. IMMUTABLE: dezelfde invoer geeft altijd exact dezelfde uitvoer. Wijzig deze functie nooit zonder alloc_algo_version te verhogen.';

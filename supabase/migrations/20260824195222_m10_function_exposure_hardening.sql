-- ============================================================================
-- m10_function_exposure_hardening
--
-- Nazorg op m8. De in m8 aangemaakte helperfuncties kregen de standaard
-- EXECUTE-grant aan PUBLIC, die daar niet expliciet werd ingetrokken. Daardoor
-- was met name public.receipt_path_building_ok() als SECURITY DEFINER
-- aanroepbaar door `anon` via /rest/v1/rpc/, wat een existence-oracle opleverde
-- op de relatie gebouw <-> organisatie.
--
-- Twee maatregelen:
--   1. EXECUTE intrekken voor PUBLIC en anon op alle helperfuncties.
--   2. receipt_path_building_ok() antwoordt alleen nog voor organisaties
--      waarvan de aanroeper lid is, zodat de functie ook bij een toekomstige
--      onbedoelde grant geen cross-tenant informatie meer prijsgeeft.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.receipt_path_building_ok(p_name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_org uuid;
  v_bld uuid;
BEGIN
  v_org := public.receipt_path_org(p_name);
  IF v_org IS NULL THEN
    RETURN false;
  END IF;

  -- Geen antwoord over organisaties waar de aanroeper niet bij hoort.
  IF NOT public.is_org_member(v_org) THEN
    RETURN false;
  END IF;

  BEGIN
    v_bld := (storage.foldername(p_name))[2]::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_bld IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.buildings b
     WHERE b.id = v_bld AND b.organization_id = v_org
  );
END;
$fn$;

-- EXECUTE intrekken voor PUBLIC/anon op alle helperfuncties uit m8.
REVOKE ALL ON FUNCTION public.current_org_role(uuid)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_write(uuid)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_manage_members(uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_org_owner(uuid)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receipt_path_org(text)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receipt_path_building_ok(text)    FROM PUBLIC, anon;

-- authenticated houdt EXECUTE: de RLS-policies evalueren deze functies met de
-- rechten van de aanroeper, dus zonder deze grant breken alle policies.
GRANT EXECUTE ON FUNCTION public.current_org_role(uuid)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_write(uuid)                TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_members(uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_owner(uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receipt_path_org(text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.receipt_path_building_ok(text) TO authenticated, service_role;

-- Vangnet: nooit meer een functie in public die door anon aanroepbaar is,
-- op create_organization na (die heeft een eigen auth.uid()-guard).
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname <> 'create_organization'
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;
END $do$;

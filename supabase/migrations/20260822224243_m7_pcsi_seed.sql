-- ============================================================
-- M7: Minimaal PCSI-rekeningschema per organisatie
-- Vijf basisrekeningen nodig voor automatische journaalboekingen:
--   4111  Copropriétaires - charges communes   (actief)
--   7011  Appels de charges communes           (produit)
--   5141  Banques - comptes courants           (actief)
--   4411  Fournisseurs                         (passief)
--   6110  Charges générales de copropriété     (charge)
-- ============================================================

CREATE OR REPLACE FUNCTION public.seed_pcsi(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  INSERT INTO public.accounts(organization_id, code, name, class, type, is_postable)
  VALUES
    (p_org_id, '4111', 'Copropriétaires - charges communes',  4, 'actief',  true),
    (p_org_id, '7011', 'Appels de charges communes',          7, 'produit', true),
    (p_org_id, '5141', 'Banques - comptes courants',          5, 'actief',  true),
    (p_org_id, '4411', 'Fournisseurs',                        4, 'passief', true),
    (p_org_id, '6110', 'Charges générales de copropriété',   6, 'charge',  true)
  ON CONFLICT DO NOTHING;
END;
$$;

-- Breid create_organization uit met automatische PCSI-seed
CREATE OR REPLACE FUNCTION public.create_organization(org_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  new_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd';
  END IF;

  INSERT INTO public.organizations(name) VALUES (org_name) RETURNING id INTO new_id;
  INSERT INTO public.memberships(organization_id, user_id, role)
    VALUES (new_id, auth.uid(), 'owner');
  INSERT INTO public.profiles(id) VALUES (auth.uid()) ON CONFLICT (id) DO NOTHING;

  PERFORM public.seed_pcsi(new_id);

  RETURN new_id;
END;
$$;

-- ============================================================================
-- m32 — `service_role` verliest EXECUTE op de twee m31-triggerfuncties
-- ============================================================================
--
-- WAT DIT REPAREERT
--
-- De productiepostcheck na het toepassen van m31 was op één punt niet groen:
-- `service_role` bleek EXECUTE te houden op beide nieuwe triggerfuncties,
-- terwijl PUBLIC, `anon` en `authenticated` dat wel kwijt waren.
--
-- De oorzaak is niet een fout in m31 maar een verschil tussen de lokale
-- testomgeving en Supabase. In een Supabase-project staan default privileges
-- op schema `public` die EXECUTE op nieuwe functies toekennen aan `anon`,
-- `authenticated` EN `service_role`. De REVOKE-conventie in deze repository
-- luidt overal `FROM PUBLIC, anon, authenticated` en noemt `service_role`
-- niet, dus die derde grant bleef staan. Lokaal viel dat niet op: de
-- testfixture kent die default privileges niet, dus daar was er niets te
-- revoken en stond de controle ten onrechte op groen.
--
-- HOE ERG WAS HET
--
-- Beperkt, en dat is precies waarom deze migratie klein blijft. Een functie
-- die `trigger` teruggeeft is niet rechtstreeks aanroepbaar: PostgreSQL
-- weigert dat met "trigger functions can only be called as triggers". Het
-- EXECUTE-recht was dus praktisch inert, en `service_role` is bovendien de
-- backendrol die al BYPASSRLS en brede tabelrechten heeft — er ontstond geen
-- pad dat die rol niet al had.
--
-- Maar m31 claimt defence in depth: geen enkel zelfstandig aanroeppad naast de
-- trigger. Die claim moet waar zijn, niet bijna waar. Vandaar deze reparatie.
--
-- WAT DEZE MIGRATIE UITDRUKKELIJK NIET DOET
--
-- m31 wordt niet aangeraakt; die is al op productie toegepast en moet
-- byte-identiek blijven. Geen functie of trigger wordt vervangen, verwijderd
-- of opnieuw aangemaakt. Geen tabel, kolom, constraint, RLS-policy of
-- tabelgrant verandert. Geen ALTER DEFAULT PRIVILEGES: dat zou toekomstige
-- objecten raken en valt buiten deze scope. Geen data wordt gelezen of
-- gewijzigd — deze migratie is volledig onafhankelijk van zakelijke rijen.
--
-- De bredere vraag of dezelfde conventie ook bij de oudere guardfuncties uit
-- m8 tot en met m30 moet worden rechtgetrokken, wordt hier BEWUST NIET
-- beantwoord. Dit is een gerichte reparatie voor de twee functies van m31.
--
-- IDEMPOTENTIE
--
-- REVOKE op een privilege dat er niet (meer) is, is een no-op zonder fout.
-- Deze migratie kan dus veilig opnieuw worden toegepast. Zij faalt wel, en
-- terecht, wanneer de rol `service_role` of een van beide functies niet
-- bestaat: dan is de aanname waarop de reparatie steunt niet waar en hoort
-- een mens te kijken in plaats van dat de migratie stil doorloopt.
-- ============================================================================

REVOKE ALL ON FUNCTION public.fn_guard_cc_date_in_fy()
  FROM service_role;

REVOKE ALL ON FUNCTION public.fn_guard_fy_period_covers_calls()
  FROM service_role;

-- ── POSTCHECK ──────────────────────────────────────────────────────────────
--
-- Fail-closed. `has_function_privilege` toetst het EFFECTIEVE recht, niet de
-- ACL-tekst: het verdisconteert rolmembership, een grant via PUBLIC en de
-- superuserstatus. Een REVOKE die alleen cosmetisch een ACL-regel opruimt
-- terwijl het recht langs een andere weg blijft bestaan, wordt hier dus
-- alsnog betrapt.
DO $postcheck$
BEGIN
  IF has_function_privilege('service_role', 'public.fn_guard_cc_date_in_fy()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'M32_POSTCHECK_FAILED: service_role heeft nog steeds EXECUTE op public.fn_guard_cc_date_in_fy()'
      USING ERRCODE = '23514';
  END IF;

  IF has_function_privilege('service_role', 'public.fn_guard_fy_period_covers_calls()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'M32_POSTCHECK_FAILED: service_role heeft nog steeds EXECUTE op public.fn_guard_fy_period_covers_calls()'
      USING ERRCODE = '23514';
  END IF;
END
$postcheck$;

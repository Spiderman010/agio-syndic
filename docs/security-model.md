# Beveiligingsmodel — Agio Syndic

Agio Syndic beheert de administratie en het geld van meerdere, van elkaar
onafhankelijke syndickantoren in één database. Tenant-isolatie is daarmee geen
feature maar de basisvoorwaarde.

## Uitgangspunt: twee lagen, altijd

De anon-key is publiek en rechtstreeks tegen PostgREST te gebruiken. Een
controle in de server action alleen is daarom **nooit** voldoende — die kan
worden omzeild door de API direct aan te roepen.

Elke invariant wordt op twee plaatsen afgedwongen:

| Laag | Waar | Waartegen |
|---|---|---|
| Applicatie | `src/lib/guard.ts`, `src/lib/validation.ts` | vergissingen, nette foutmeldingen |
| Database | RLS-policies, samengestelde FK's, triggers | directe API-toegang, servicecode, SQL-editor |

De databaselaag is leidend. De applicatielaag bestaat om fouten vroeg en
begrijpelijk te melden.

## Rolmodel

Gedefinieerd in `public.org_role`, afgedwongen via drie helperfuncties:

| Functie | Rollen |
|---|---|
| `is_org_member(org)` | owner, admin, manager, accountant, reader |
| `can_write(org)` | owner, admin, manager, accountant |
| `can_manage_members(org)` | owner, admin |
| `is_org_owner(org)` | owner |

Elke org-gescopete tabel heeft vier policies in plaats van één `FOR ALL`:

```
<tabel>_select : is_org_member(organization_id)
<tabel>_insert : can_write(organization_id)
<tabel>_update : can_write(organization_id)
<tabel>_delete : can_write(organization_id)
```

`units` en `ownership` hebben geen eigen `organization_id`; daar loopt de keten
via `building_id → buildings.organization_id`.

**`reader` kan nooit muteren.** Bewezen door test T2.

`manager` en `accountant` hebben in deze ronde dezelfde schrijfrechten. Een
fijnmaziger onderscheid (bijvoorbeeld: alleen `accountant` mag journaalposten
corrigeren) is een productbeslissing en bewust nog niet gemaakt.

## Ledenbeheer

Lidmaatschap kan op precies twee manieren ontstaan:

1. `create_organization(org_name)` — de atomische RPC die organisatie,
   `owner`-lidmaatschap en het PCSI-rekeningschema in één transactie aanmaakt.
2. Een `owner` of `admin` die iemand toevoegt aan de eigen organisatie.

Aanvullende waarborgen:

- `organizations` INSERT staat op `WITH CHECK (false)`. Organisaties ontstaan
  uitsluitend via de RPC, wat weesorganisaties onmogelijk maakt.
- Een gebruiker kan zijn **eigen** membership-rij niet wijzigen of verwijderen
  (`user_id <> auth.uid()` in de policies). Zelf-promotie is daarmee uitgesloten.
- `trig_guard_last_owner` zorgt dat een organisatie altijd minimaal één `owner`
  houdt — ook bij mutaties via `service_role` of de SQL-editor.

## Cross-tenant foreign keys

Elke org-gescopete tabel heeft `UNIQUE (id, organization_id)`. Verwijzende
tabellen dragen een **samengestelde** foreign key op `(fk_id, organization_id)`.

Daardoor is het structureel onmogelijk dat bijvoorbeeld een uitgave van
organisatie A naar een gebouw van organisatie B wijst — ongeacht applicatiecode,
rol of RLS. 27 samengestelde FK's dekken alle org-gescopete relaties.

`ownership` heeft geen `organization_id` en kan dus geen samengestelde FK
gebruiken. Daar bewaakt `trig_00_ownership_tenant_guard` de invariant dat
`owner.organization_id = unit.building.organization_id`.

## Storage: bewijsstukken

Bucket `receipts`, privé, max 10 MB, alleen JPEG/PNG/WEBP/HEIC/PDF.

Padconventie: `{organization_id}/{building_id}/{uuid}.{ext}`

| Policy | Voorwaarde |
|---|---|
| `receipts_select` | lid van de organisatie in het eerste padsegment |
| `receipts_insert` | `can_write` op die organisatie **en** het tweede padsegment is een gebouw van die organisatie |
| `receipts_update` | idem |
| `receipts_delete` | `can_write` **en** (uploader zelf of owner/admin) |

Het MIME-type wordt server-side uit de bestandsextensie afgeleid, niet uit de
door de client aangeleverde `File.type` — die is vervalsbaar.

### Signed URL's

Een Supabase signed URL is een bearer-token dat RLS volledig omzeilt. Daarom:

- er wordt **nooit** een signed URL in de database opgeslagen;
- `expenses.receipt_path` bevat alleen het objectpad;
- `getReceiptUrl()` genereert de URL pas bij het openen, na controle dat de
  uitgave tot de actieve organisatie hoort, met een TTL van **60 seconden**.

De oude kolom `expenses.receipt_url` is gemarkeerd als deprecated maar niet
verwijderd: hij dient als vangnet voor bewijsstukken van vóór de migratie.
`getReceiptUrl()` valt daarop terug wanneer `receipt_path` leeg is. Verwijderen
van de kolom is een aparte, latere stap.

## Functie-rechten

| Functie | Aanroepbaar door |
|---|---|
| `create_organization(text)` | authenticated |
| `is_org_member`, `can_write`, `can_manage_members`, `is_org_owner`, `current_org_role`, `receipt_path_org`, `receipt_path_building_ok` | authenticated (nodig voor policy-evaluatie) |
| `seed_pcsi`, `get_account_id`, `require_account_id`, `fn_assert_fy_open` | niemand — uitsluitend intern |
| alle `fn_*` triggerfuncties | niemand — uitsluitend als trigger |

`PUBLIC` en `anon` hebben op geen enkele functie in `public` nog EXECUTE.
Migratie `m10` bevat daarvoor een vangnet-blok dat elke functie met een
resterende anon-grant intrekt.

### Waarom `authenticated` deze functies wél mag aanroepen

RLS-policyexpressies worden geëvalueerd met de rechten van de aanroeper. Zonder
`EXECUTE` voor `authenticated` breken alle 96 policies. Dat betekent wel dat
PostgREST ze als RPC-endpoint aanbiedt, en de Supabase-linter waarschuwt
daarvoor.

Die blootstelling is beoordeeld en aanvaard: elk van deze functies geeft
uitsluitend informatie over het **eigen** lidmaatschap van de aanroeper terug.
Voor een organisatie waar de aanroeper geen lid van is, retourneren zij `NULL`
of `false`. `receipt_path_building_ok()` had die eigenschap aanvankelijk niet en
fungeerde als existence-oracle op de relatie gebouw ↔ organisatie; sinds `m10`
weigert de functie te antwoorden voor niet-leden.

**Openstaande verbetering.** De structureel schonere oplossing is de helpers naar
een niet-geëxposeerd schema te verplaatsen (bijvoorbeeld `app_private`), zodat
PostgREST ze helemaal niet publiceert. Dat raakt alle 96 policies en is daarom
niet in deze herstelronde meegenomen.

## Tests

`supabase/tests/security_integration.sql` draait echt tegen de database: RLS
wordt afgedwongen door de sessierol op `authenticated` te zetten en
`request.jwt.claims` te vullen, exact zoals PostgREST dat doet. Er wordt niets
gemockt.

Het geheel draait in één transactie die aan het eind een exceptie werpt met het
testrapport, zodat alle testdata gegarandeerd terugrolt.

```bash
psql "$DATABASE_URL" -f supabase/tests/security_integration.sql
```

| # | Test |
|---|---|
| T1 | gebruiker A kan geen membership in organisatie B maken |
| T2 | reader kan niet schrijven, wel lezen |
| T3 | gebruiker A kan bewijsstuk van organisatie B niet lezen |
| T4 | upload onder eigen prefix slaagt, onder prefix van B geweigerd |
| T5 | eigenaar uit B kan niet aan unit uit A worden gekoppeld (RLS én trigger) |
| T6 | vreemde building- en owner-UUID worden geweigerd |
| T7 | insert zonder `organization_id` faalt, mét slaagt |
| T8 | onboarding is atomisch; directe org-insert geblokkeerd |
| T9 | gesloten boekjaar weigert uitgave, lastenoproep en periodewijziging |
| T10 | lege én ongebalanceerde journaalpost worden geweigerd |
| T11 | overbetaling belandt op 4419 |
| T12 | normale geldige flow blijft werken |

# Reproduceerbare demo-omgeving — wat er ontbreekt

Opgesteld tijdens sprint 1 (app shell), 31-08-2026, op `feat/app-shell-foundation`.

**Dit is een analyse, geen implementatie.** Er is in deze sprint bewust geen
migratie voor gemaakt; alles hieronder vraagt om een eigen PR.

De aanleiding is concreet: tijdens de visuele QA van de applicatieschil bleek dat
er geen enkele omgeving bestaat waarin het product te tonen is, behalve productie
zelf. Dat is een blokkade voor het demonstreren aan een echte syndic, en het
raakt ook staging en een tweede klant.

---

## 1. Wat er niet uit Git te bouwen is

### 1.1 Zeven lege plaatshouders

Deze migraties bestaan als bestand maar bevatten geen DDL. Ze doen niets anders
dan een `RAISE NOTICE`:

| Migratie | Wat er destijds in zat |
| --- | --- |
| `20260822175325_m1_foundation_vastgoedstructuur` | organisaties, memberships, gebouwen, units, eigenaars, ownership |
| `20260822180053_m2_boekjaar_lasten_incasso` | boekjaren, lastenoproepen, allocaties, betalingen |
| `20260822193646_m3_uitgaven_bank_boekhoudkern_pcsi` | uitgaven, bankrekeningen, journaal, rekeningschema |
| `20260822203405_m4_documenten_compliance` | documenten, documenttypen, compliance-deadlines |
| `20260822203552_m5_fondsen_jaarafsluiting` | fondsen, fondsmutaties, jaarafsluitingen |
| `20260822204127_util_create_organization_fn` | `create_organization` |
| `20260824161924_create_receipts_bucket_rls` | de `receipts`-bucket en zijn storage-policies |

De keuze om ze niet te reconstrueren is onderbouwd in `docs/migration-drift.md`
en blijft juist: `m8` heeft alle RLS-policies vervangen en 27 samengestelde
foreign keys aangebracht, dus de toestand van vlak ná `m1`–`m5` bestaat niet meer
en is uit de huidige catalogus niet af te leiden. Een plausibel ogende
reconstructie zou bij een replay op `m8` stukbreken.

**Gevolg:** van de 34 tabellen zijn er slechts **zeven** die daadwerkelijk door
een migratie in Git worden aangemaakt — `blocks`, `charge_call_lines`,
`allocation_rules`, `allocation_rule_weights`, `allocation_rule_units`,
`financial_reversals` en `payment_allocation_reversals`. De overige 27 bestaan
alleen live.

### 1.2 Referentiedata die nergens in Git staat

Dit is het punt dat nog niet eerder was vastgelegd, en het is scherper dan het
schemagat: drie tabellen dragen de hele Marokkaanse compliance-propositie en hun
inhoud komt in **nul** migraties voor.

| Tabel | Live inhoud | In Git? |
| --- | --- | --- |
| `tier_thresholds` | 3 rijen: klein ≤ 200.000, midden 200.000–500.000, groot ≥ 500.000 MAD | **nee** |
| `annexe_rules` | 18 rijen: klein → 10/13-1/13-2, midden → 10/11/12, groot → 3 t/m 13-2 | **nee** |
| `document_types` | 17 rijen over vier categorieën (av, financieel, boekhouding, wettelijk) | **nee** |

Wat wél reproduceerbaar is: `accounts` wordt per organisatie geseed door
`seed_pcsi()`, en die functie staat in `m7`. Een verse organisatie krijgt dus
haar zes PCSI-rekeningen automatisch. `expense_categories` is organisatie-eigen
en wordt door de gebruiker aangemaakt; daar hoort geen seed bij.

Geverifieerd: noch `seed_pcsi`, noch `create_organization` raakt een van de drie
tabellen hierboven aan.

**Gevolg:** een verse omgeving start met een leeg `tier_thresholds`,
`annexe_rules` en `document_types`. De tier-afleiding, de bijlagenlijst per
categorie en het documentregister werken daar dus niet — precies de drie dingen
waarop het product zich tegenover Kassaba onderscheidt.

### 1.3 Wat er verder niet in Git staat

- **De schema-baseline zelf.** `supabase/baseline/` bevat een README en een
  inventarisatiescript, maar `schema.sql` en `seed.sql` zijn nooit gegenereerd.
  De README beschrijft de procedure correct; hij is alleen niet uitgevoerd.
- **De storage-bucket.** `receipts` (privé, limiet 10 MB) plus vier
  storage-policies zitten in plaatshouder `20260824161924`.
- **Auth-instellingen.** Wachtwoordbeleid, e-mailsjablonen, redirect-URL's en de
  `leaked password protection` uit `docs/known-issues.md` §1 zijn
  dashboardinstellingen en horen per definitie niet in migraties.

---

## 2. Wat er nodig is voor een volledige rebuild-from-empty

In volgorde. Elke stap is één PR waard.

1. **Baseline genereren en committen.** `supabase db dump --schema public,storage`
   levert `supabase/baseline/schema.sql`. Vereist de Supabase CLI plus het
   databasewachtwoord; beide zitten niet in de repo. Dit is een leesoperatie op
   productie en wijzigt daar niets.
2. **Referentiedata als migratie.** Eén nieuwe migratie die `tier_thresholds`,
   `annexe_rules` en `document_types` seedt, **idempotent**: `ON CONFLICT DO
   NOTHING`, geen enkele bestaande rij muteren. De acceptatie-eis is dubbel — hij
   moet aantoonbaar draaien op een lege database én op een kopie van productie
   zonder rijen te dupliceren of te wijzigen.
3. **Herkomst vastleggen bij die seed.** De annexe-indeling komt overeen met wat
   Kassaba publiceert, maar is **niet geverifieerd tegen de tekst van décret
   2.23.700**; de kolom `annexe_rules.description` is leeg. Leg per rij de bron
   vast (artikel, publicatie, verificatiestatus) vóórdat er een generator op
   wordt gebouwd. Zonder herkomst doet het product een wettelijke uitspraak die
   niemand kan navertellen.
4. **Storage-bucket als migratie.** De `receipts`-bucket en zijn vier policies
   opnieuw declareren, zodat bonnetjes-upload op een verse omgeving werkt.
5. **Rebuild bewijzen.** Op een Supabase-branch of een tweede project: baseline
   inladen, `migration repair` voor de zeven plaatshouders, `supabase db push`
   voor `m6`–`m29`, en daarna de bestaande SQL-suites draaien. Pas als
   243/243 groen is op een omgeving die uit Git is opgebouwd, is dit punt echt
   gesloten.

---

## 3. Minimale veilige route naar een demo-tenant

Volledige reproduceerbaarheid is stap 2 t/m 5 hierboven en kost meerdere PR's.
Er is een kortere route die géén van de bovenstaande blokkades oplost maar wel
snel een toonbare omgeving geeft:

**Optie A — tweede organisatie in het bestaande project (goedkoopst).**
Maak via de bestaande onboarding een organisatie "Démo — Résidence Atlas" aan.
Tenant-isolatie is sinds `m8` bewezen met tests T1 t/m T6, dus demodata raakt de
echte data niet. `seed_pcsi` geeft de nieuwe organisatie automatisch haar
rekeningschema; `tier_thresholds`, `annexe_rules` en `document_types` zijn globale
tabellen die al gevuld zijn. Nadeel: het is en blijft productie, en een reset
betekent handmatig verwijderen.

**Optie B — Supabase-branch.** Een preview-branch van het project krijgt het
schema mee maar niet noodzakelijk de globale referentiedata; die zou dan alsnog
met de hand geladen moeten worden. Wordt pas aantrekkelijk ná stap 2.

**Aanbeveling:** optie A voor de eerste demo's, met een genummerd
demo-organisatie-id dat in het draaiboek staat, en optie B zodra de
seed-migratie er is. Bouw geen wegwerpscript dat rechtstreeks op productie
schrijft.

---

## 4. Wat een aparte PR vereist

| Onderwerp | Waarom apart |
| --- | --- |
| Seed-migratie referentiedata | Schemawijziging; buiten de scope van elke UI-sprint |
| Baseline `schema.sql` | Vereist CLI-toegang en het databasewachtwoord |
| Storage-bucket als migratie | Raakt `storage`-schema en RLS |
| Herkomstkolommen op `annexe_rules` | Schemawijziging, en vraagt eerst een juridische bronverificatie |
| Demodataset (gebouw, lots, eigenaars, betalingen, één storno) | Hoort bij de sprint die de eerste cijferschermen bouwt, niet bij de schil |

---

## 5. Samenvatting

De database is diep en goed getest, maar hij bestaat maar op één plek. Zolang
`schema.sql` ontbreekt en drie referentietabellen alleen live gevuld zijn, is er
geen staging, geen tweede klant en geen resetbare demo. Dat is geen
integriteitsprobleem — de productie-invarianten zijn ongemoeid — maar wel een
leveringsprobleem, en het wordt duurder naarmate er meer op wordt gebouwd.

De goedkoopste eerste stap is de seed-migratie uit §2.2: één bestand, idempotent,
geen risico voor productie, en het haalt de scherpste kant van het probleem weg.

# Boekhoudkundige regels — Agio Syndic

Dit document legt de deterministische boekhoudregels vast die in de database
zijn afgedwongen. Alle rekenkunde die exact moet kloppen zit in PL/pgSQL, nooit
in AI en nooit in de applicatielaag.

Rekeningschema: PCSI (Plan Comptable des Syndicats Immobiliers), geseed door
`seed_pcsi()` bij het aanmaken van elke organisatie.

| Code | Naam | Klasse | Type |
|---|---|---|---|
| 4111 | Copropriétaires - charges communes | 4 | actief |
| 4419 | Copropriétaires - avances et acomptes reçus | 4 | passief |
| 4411 | Fournisseurs | 4 | passief |
| 5141 | Banques - comptes courants | 5 | actief |
| 6110 | Charges générales de copropriété | 6 | charge |
| 7011 | Appels de charges communes | 7 | produit |

---

## 1. Journaalposten: volledig of helemaal niet

**Regel.** Een financiële brontransactie leidt tot een journaalpost mét
sluitende regels, of de hele transactie faalt. Stille gedeeltelijke verwerking
bestaat niet.

**Afdwinging.**

- `require_account_id(org, code)` werpt een exceptie zodra een vereiste
  grootboekrekening ontbreekt. De journaalkop wordt pas geschreven nádat alle
  benodigde rekeningen zijn opgehaald, zodat er nooit een kop zonder regels
  ontstaat.
- `trig_journal_entry_complete` — een `CONSTRAINT TRIGGER ... DEFERRABLE
  INITIALLY DEFERRED` op `journal_entries`. Bij commit wordt gecontroleerd dat
  elke journaalpost minimaal twee regels heeft én dat debet gelijk is aan
  credit. Dit is het vangnet dat ook handmatige of toekomstige boekingsroutes
  afdekt.
- `trig_journal_balance_check` op `journal_lines` bewaakt de balans bij elke
  regelmutatie. Sinds `m11` dekt die trigger óók DELETE: daarvoor kon één regel
  van een tweeregelige post worden verwijderd zonder dat er iets protesteerde.
  Wanneer de kop zelf via cascade verdwijnt slaat de controle over — er valt dan
  niets meer te balanceren.

Omdat de triggers binnen dezelfde transactie als de bron-INSERT draaien, rolt
een mislukte journaalpost automatisch de gehele brontransactie terug. Een aparte
applicatietransactie is daarvoor niet nodig.

**Boekingen.**

| Bron | Debet | Credit |
|---|---|---|
| Lastenoproep | 4111 | 7011 |
| Uitgave | rekening van de categorie, anders 6110 | 4411 |
| Betaling | 5141 | 4111 (toegewezen deel) + 4419 (overschot) |

Een uitgave zónder boekjaar (`fiscal_year_id IS NULL`) is bewust nog niet
toegerekend en levert geen journaalpost op. Zodra er een boekjaar aan hangt,
is de journaalpost verplicht.

---

## 2. Afgesloten boekjaar: wat ligt vast en wat niet

Dit is de kern van de regel, omdat hier twee legitieme belangen botsen: een
vastgestelde jaarrekening mag nooit achteraf veranderen, maar een openstaande
vordering op een eigenaar loopt gewoon door.

**Onwijzigbaar zodra `fiscal_years.status = 'closed'`:**

- `charge_calls` — de vastgestelde lastenoproepen
- `charge_allocations.amount` — de vastgestelde verdeling per lot
- `expenses` met dat boekjaar
- `journal_entries` en `journal_lines` — het historische grootboek
- `fund_movements` waarvan de datum binnen de periode van het boekjaar valt
- `fiscal_years.year`, `start_date`, `end_date` — de periode zelf
- `fiscal_year_closings` — de vastlegging van de afsluiting is niet handmatig
  wijzigbaar; UPDATE is geblokkeerd. DELETE kan alleen als onderdeel van een
  bovenliggende cascade (bijvoorbeeld het verwijderen van de organisatie of het
  gebouw), zodat referentiële opruiming niet vastloopt.

**Wél toegestaan na afsluiting:**

- `charge_allocations.settled_amount`, uitsluitend bijgewerkt door de
  FIFO-trigger — zie hieronder
- `payment_allocations` INSERT door die trigger — het afboeken van een
  doorlopende vordering
- `fiscal_years.status` terugzetten naar `open` (heropenen), voorbehouden aan
  `owner`/`admin` en afgedwongen door `fn_guard_fiscal_year_immutable`

**Afgeleide tabellen zijn niet met de hand te muteren.** `charge_allocations`,
`payment_allocations`, `journal_entries` en `journal_lines` worden uitsluitend
door triggers onderhouden. Sinds `m11` staan hun INSERT-, UPDATE- en
DELETE-policies voor `authenticated` op `false`: de API kan er niets in
schrijven, ook niet in een open boekjaar. De triggerfuncties zijn
`SECURITY DEFINER` en omzeilen RLS, dus de deterministische kern werkt gewoon.

Dat sluit de laatste route waarlangs `settled_amount`, een toewijzing of het
grootboek buiten de rekenkern om verdraaid kon worden.

**Waarom `settled_amount` mag muteren.**

`settled_amount` is géén vastgesteld jaarcijfer maar de actuele stand van de
open post in de subadministratie. Boekhoudkundig correspondeert het met
grootboekrekening 4111, een **doorlopende balansrekening**: het saldo daarvan
gaat als beginbalans mee naar het volgende boekjaar en wordt daar verder
afgeboekt.

Het vastgestelde cijfer van het gesloten boekjaar — het bedrag dat aan de
eigenaar is opgeroepen (`amount`) en het resultaat — verandert dus niet. Alleen
de open-postenlijst wordt bijgewerkt, en dat is precies wat er hoort te
gebeuren.

**Waar de journaalpost landt.**

`fn_journal_from_payment()` boekt een betaling **altijd in het meest recente
OPEN boekjaar** van het gebouw, ook wanneer de betaling een vordering uit een
afgesloten boekjaar afboekt:

```
Debet  5141 Bank                  bedrag
Credit 4111 Vordering eigenaar    toegewezen deel
Credit 4419 Vooruitontvangen      eventueel overschot
```

Daarmee blijven resultaat en balans van het gesloten boekjaar ongewijzigd,
terwijl de vordering in het lopende jaar correct verdwijnt.

**Is er geen open boekjaar, dan faalt de betaling** met de melding dat er eerst
een boekjaar geopend moet worden. Dat is bewust: zonder open boekjaar is er
geen plaats om de ontvangst te verantwoorden.

---

## 3. Overbetaling

**Beslissing: modelleren, niet blokkeren.**

Overwogen alternatief was de betaling te weigeren zodra het bedrag hoger is dan
het totaal openstaande. Dat is afgewezen omdat eigenaars in de praktijk
routinematig afronden of vooruitbetalen; een harde weigering zou de syndic
dwingen de werkelijkheid te vervalsen om een boeking rond te krijgen.

**Werking.** `fn_payment_fifo()` wijst de betaling FIFO toe aan openstaande
posten (oudste vervaldatum eerst). Blijft er een restant over, dan boekt
`fn_journal_from_payment()` dat restant als credit op **4419 — Copropriétaires,
avances et acomptes reçus**: een schuld van de VvE aan de eigenaar.

Het bedrag verdwijnt dus niet en is zichtbaar op de balans. Debet blijft altijd
gelijk aan credit, ook bij gedeeltelijke toewijzing.

**Bewezen door test T11** in `supabase/tests/security_integration.sql`:
openstaand 100,00 en een betaling van 150,00 levert 100,00 aan
`payment_allocations` en 50,00 credit op 4419.

`fn_payment_fifo()` neemt sinds `m11` een `FOR UPDATE`-vergrendeling op de
openstaande posten. Zonder die vergrendeling konden twee gelijktijdige
betalingen dezelfde post afboeken, waarna het teveel alsnog verdween in plaats
van op 4419 te belanden.

**Bekende beperking.** Een bestaand tegoed op 4419 wordt nog niet automatisch
verrekend met een latere lastenoproep. De eigenaar heeft dan tegelijk een
openstaande post (4111) en een tegoed (4419). Het bedrag is zichtbaar en
correct verantwoord, maar de verrekening is nu nog een handmatige actie.
Automatische verrekening is nieuwe productfunctionaliteit en valt buiten deze
herstelronde.

---

## 4. Tantième-verdeling

Ongewijzigd in deze ronde, hier voor de volledigheid vastgelegd.

`fn_charge_call_allocate()` rekent in **hele centen** en gebruikt
largest-remainder-toewijzing: iedere unit krijgt
`floor(tantiemes / total_tantiemes * totaal_in_centen)`, waarna de resterende
centen één voor één worden toegekend op volgorde van `frac DESC, id ASC`.

De verdeling telt daardoor exact op tot het opgeroepen bedrag en is
reproduceerbaar: dezelfde invoer geeft altijd dezelfde uitkomst.

---

## 5. Storno en correctie

**Regel.** Een foutieve financiële transactie wordt nooit hersteld door historie te
verwijderen of door een bestaand financieel feit stil te overschrijven. Het
origineel blijft staan; de correctie is een nieuwe, traceerbare gebeurtenis.

Dat is geen principekwestie alleen: sinds `m22`/`m23` is een betaling of uitgave
met journaalpost ook feitelijk niet meer verwijderbaar. Zonder correctieroute was
er dus letterlijk geen weg meer om een fout te herstellen. `m24`–`m27` sluiten dat
gat.

### Vier ingangen

| RPC | Doet |
|---|---|
| `reverse_payment(id, reden)` | volledige storno van een betaling |
| `correct_payment(id, bedrag, valutadatum, betaalwijze, referentie, reden)` | storno + vervangende betaling, in één transactie |
| `reverse_expense(id, reden)` | volledige storno van een gejournaliseerde uitgave |
| `correct_expense(id, bedrag, datum, rekening, categorie, leverancier, omschrijving, bewijsstuk, reden)` | storno + vervangende uitgave |

Een reden van 10 tot 500 tekens is verplicht, afgedwongen door een CHECK op de
tabel en niet alleen door de RPC. Een financiële storno zonder opgegeven reden is
geen auditspoor.

### Waarom bedragen positief blijven

`payments.amount > 0`, `expenses.amount > 0`, `payment_allocations.amount > 0` en de
strikte debet-XOR-credit op `journal_lines` zijn de constraints waarop de hele
financiële kern rust. Een storno als negatieve rij zou er drie moeten slopen om één
functie toe te voegen.

Daarom draagt niet het teken maar de **tabel** de betekenis:

- `financial_reversals` — de onwijzigbare auditgebeurtenis: wie, wanneer, waarom,
  in welk boekjaar geboekt, en naar welke vervangende rij (`correction_source_id`).
- `payment_allocation_reversals` — append-only neutralisatie per oorspronkelijke
  toewijzing, met een **positief** bedrag.
- `journal_entries.source = 'reversal'` — de gespiegelde journaalpost.

### De gespiegelde journaalpost

De storno is een **letterlijke spiegeling** van de originele regels, met debet en
credit verwisseld. Er wordt niets opnieuw afgeleid.

| | Debet | Credit |
|---|---|---|
| Betaling | 5141 bedrag | 4111 toegewezen + 4419 overschot |
| **Storno betaling** | **4111 toegewezen + 4419 overschot** | **5141 bedrag** |
| Uitgave | lastrekening | 4411 |
| **Storno uitgave** | **4411** | **lastrekening** |

Spiegelen in plaats van herafleiden is een bewuste keuze met een concreet gevolg:
is de standaardrekening van een uitgavecategorie ná de oorspronkelijke boeking
gewijzigd, dan zou herafleiden de storno op een ándere rekening zetten dan het
origineel en saldo achterlaten op de oude. De spiegeling kan die fout per
constructie niet maken. Vastgelegd door test E08.

Omdat het origineel sluit, sluit de spiegeling ook; en een regel met debet>0 en
credit=0 wordt credit>0 en debet=0, dus `journal_lines_check` blijft gelden.

### De settlement-invariant

`charge_allocations.settled_amount` is niet langer vrij te zetten. Sinds `m25` geldt:

```
settled_amount = SUM(payment_allocations.amount)
               - SUM(payment_allocation_reversals.amount)
```

`fn_guard_ca_settlement_derived` weigert elke UPDATE die daarvan afwijkt. De guard
controleert de **invariant**, niet de aanroeper — er is dus geen context om te
vervalsen. `fn_payment_fifo` voldoet er automatisch aan (INSERT toewijzing, dan
verhogen); de reversal-engine ook (INSERT neutralisatie, dan verlagen).
`v_settlement_integrity` maakt eventuele drift zichtbaar.

Alles rekent in `numeric(14,2)`. Geen floating point, dus de vergelijking is exact.

### Afgesloten boekjaar

Twee dingen die uit elkaar gehouden moeten worden.

**Het grootboek van een afgesloten jaar wordt nooit herschreven.** De storno landt
altijd in een OPEN boekjaar. Is het originele jaar zelf nog open, dan blijft de
correctie binnen dat jaar; anders gaat hij naar het lopende jaar.

**De openstaande vordering loopt wél door.** Storneren van een betaling herstelt
`settled_amount`, óók wanneer die vordering in een afgesloten jaar is opgeroepen.
Dat is exact dezelfde redenering als in paragraaf 2: 4111 is een doorlopende
balansrekening, en het vastgestelde jaarcijfer (`amount`, het resultaat) verandert
niet.

Autorisatie volgt die scheiding:

| Origineel staat in | Vereist |
|---|---|
| een open boekjaar | `can_write` (owner, admin, manager, accountant) |
| een afgesloten boekjaar | `can_manage_members` (alleen owner en admin) |

Bepalend is het boekjaar van de **originele journaalpost**. Een betaling in het
lopende jaar die een oude vordering afboekte blijft dus een `can_write`-handeling.

### Valutadatum bij een correctie

`correct_payment` neemt de opgegeven valutadatum over zoals hij is. Die datum is
een **bankfeit** en wordt niet naar het huidige boekjaar verlegd. De journaalpost
van de vervangende betaling landt vervolgens in het meest recente open boekjaar,
precies zoals bij elke andere betaling. Lopen die twee uiteen, dan is dat een
correctie over de jaargrens; `v_financial_reversals.is_correctie_vorig_boekjaar`
maakt dat herkenbaar.

### Grenzen

- **Alleen volledige storno.** Gedeeltelijk terugdraaien bestaat niet; de route is
  volledig storneren en de juiste transactie opnieuw boeken.
- **Storno van een storno is onmogelijk** — een reversal is geen `payments`- en geen
  `expenses`-rij, dus er is geen bron om naar te wijzen. Geen extra constraint nodig.
- **Rapportage telt bruto.** Een correctie van 1000 naar 800 laat een bruto
  betalingstotaal 1800 tonen. Eigenaarsaldi corrigeren zichzelf wel, omdat die uit
  `amount - settled_amount` volgen.
- **Het bewijsstuk blijft.** Een storno verwijdert geen `receipt_path`.
- **De banktransactie blijft aan het origineel gekoppeld.** De bank heeft dat bedrag
  daadwerkelijk ontvangen; dat feit staat los van de boekhoudkundige verwerking.

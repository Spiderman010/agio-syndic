# Bekende problemen en handmatige stappen

Bijgewerkt: 27-08-2026, na de financial reversal engine (`m24`–`m28`).

---

## 0. Mede-eigendom: één debiteur ontvangt de volledige vordering

**Dit is de belangrijkste functionele beperking van deze release.**

De database staat meerdere `ownership`-records per lot toe: een appartement kan
twee of meer gelijktijdige mede-eigenaars hebben, elk met een eigen `share`.

De allocation engine splitst een lot-allocatie echter **niet** over die
eigenaars. Per lot wordt precies één debiteur bepaald — de eigenaar met
`is_primary_debtor = true` — en die krijgt de **volledige** betalingsverplichting
van dat lot. `ownership.share` wordt wél vastgelegd en is auditeerbaar
(`charge_allocations.ownership_id` en `ownership_share_ppm` staan in de
snapshot), maar wordt niet gebruikt om te verdelen.

**Wat dit concreet betekent**

- Bij een 50/50 mede-eigendom ontstaan **géén** twee vorderingen van 50%. Er
  ontstaat één vordering van 100% op de aangewezen debiteur.
- Gebruikers mogen niet aannemen dat het invoeren van twee eigenaars met
  `share = 0.5` automatisch tot een gedeelde facturatie leidt.
- De keuze is wel expliciet en herleidbaar in plaats van willekeurig: zijn er
  meerdere actieve eigenaars en is er géén (of meer dan één) aangewezen
  debiteur, dan **faalt de lastenoproep hard** met `ALLOC_AMBIGUOUS_OWNER` in
  plaats van stilzwijgend iemand te kiezen. Vóór `m14` koos de oude code met
  `LIMIT 1` zonder `ORDER BY` een willekeurige eigenaar.
- Een partiële index (`ownership_primary_active_idx`) staat hoogstens één
  aangewezen debiteur per lot binnen een lopende periode toe.

**Toekomstige productfunctionaliteit**

Echte share-based debtor splitting is nog te ontwerpen en te bouwen. Het raakt
meer dan de verdeling alleen:

- `charge_allocations` heeft `UNIQUE (charge_call_id, unit_id)`, wat meerdere
  rijen per lot nu uitsluit;
- er komt een tweede afrondingsniveau bij (eerst over lots, dan binnen een lot
  over eigenaars), met een eigen som-invariant per lot;
- `fn_payment_fifo` en de openstaandenberekening moeten meebewegen.

**Dit moet zijn ontworpen, gebouwd en getest vóórdat een klant wordt onboarded
met werkelijke mede-eigendomssituaties** — bijvoorbeeld een nalatenschap met
meerdere erfgenamen, wat in de Marokkaanse praktijk niet zeldzaam is.

---

## 1. Handmatige Supabase-instelling: leaked password protection

De Security Advisor meldt `auth_leaked_password_protection` als uitgeschakeld.
Dit is een dashboardinstelling, niet via SQL te zetten.

Supabase Dashboard → Authentication → Policies → *Leaked password protection*
inschakelen. Aanbevolen: ook een minimale wachtwoordlengte en rate limiting op
`signUp`, omdat registratie open staat (zie punt 4).

---

## 2. Migratiegeschiedenis: gereconcilieerd, baseline nog niet bewezen

*migration history reconciled; full baseline rebuild still pending.*

Elke live geregistreerde migratie heeft nu een bestand met exact dezelfde naam,
waaronder zeven **bewust lege plaatshouders** voor migraties die destijds
rechtstreeks zijn toegepast. Daarmee zijn voorwaartse operaties veilig: de CLI
ziet geen enkele migratie meer als nog-toe-te-passen.

Wat hiermee **niet** is opgelost: een lege database volledig reconstrueren
vanuit Git. De plaatshouders bevatten geen DDL, en de volledige schema-baseline
is nog **niet gegenereerd en niet gevalideerd**. Rebuild-from-empty is dus nog
niet bewezen. Zie `docs/migration-drift.md` en `supabase/baseline/README.md`;
het maken van de baseline vereist de Supabase CLI plus het databasewachtwoord.

---

## 3. Helperfuncties staan in het geëxposeerde `public`-schema

De RLS-helpers (`can_write`, `is_org_member`, …) moeten door `authenticated`
aanroepbaar zijn, anders breken de policies. Daardoor publiceert PostgREST ze
als RPC-endpoint en waarschuwt de linter.

De blootstelling is beoordeeld en aanvaard: elke functie geeft uitsluitend
informatie over het eigen lidmaatschap van de aanroeper. `anon` heeft nergens
meer EXECUTE.

Structureel schoner is de helpers naar een niet-geëxposeerd schema
(`app_private`) te verplaatsen. Dat raakt de bestaande policies en viel buiten
deze ronde.

---

## 4. Open registratie

`signUp` staat open voor iedereen, zonder uitnodiging of domeinrestrictie. Op
zichzelf een productkeuze, maar het betekent dat elke bezoeker een
geauthenticeerde sessie kan verkrijgen. De tenant-isolatie is daar sinds `m8`
tegen bestand (bewezen door tests T1 t/m T6), maar een uitnodigingsflow blijft
aan te bevelen.

---

## 5. Foutmeldingen uit server actions zijn Nederlands, de UI is Frans

De teksten in `src/lib/validation.ts`, `src/lib/guard.ts` en de guard-triggers
zijn Nederlands, terwijl de UI standaard Frans is. Dit volgt het bestaande
patroon in de codebase (de oude actions deden hetzelfde), maar het hoort via
`getTranslations()` uit `next-intl/server` te lopen.

Niet meegenomen omdat het geen security- of integriteitsprobleem is.

---

## 6. Openstaande functionele punten uit de review

Gevonden tijdens de adversariële review, **buiten de scope** van deze
herstelronde en dus niet aangepakt:

- Een tegoed op 4419 wordt niet automatisch verrekend met een latere
  lastenoproep (gedocumenteerd in `docs/accounting-rules.md`).
- Een uitgave zonder boekjaar krijgt geen journaalpost en kan er achteraf niet
  alsnog aan gekoppeld worden (`EXPENSE_FY_LATE_ASSIGNMENT` sinds `m22`). Sinds
  `m23` is zo'n uitgave nog wel intrekbaar — er hangt immers geen journaalpost aan —
  dus de herstelroute "verwijderen en opnieuw boeken mét boekjaar" blijft schoon.
- `funds.balance` wordt alleen bij INSERT bijgewerkt, niet bij UPDATE/DELETE van
  een fondsmutatie.
- Er is geen controle dat `journal_entries.entry_date` binnen de periode van het
  boekjaar valt.
- Er is geen algemene audit trail van financiële mutaties (wie boekte wat, wanneer).
  Sinds `m25` geldt dat wél voor storno's en correcties: `financial_reversals` legt
  actor, tijdstip, reden en bestemming vast. Het gewone boeken van een betaling of
  uitgave draagt nog steeds geen `created_by`.
- **Gedeeltelijke storno bestaat niet.** De engine kent alleen een VOLLEDIGE storno;
  `fn_guard_par_consistent` weigert een neutralisatie die afwijkt van het bedrag van
  de oorspronkelijke toewijzing (`ALLOCATION_REVERSAL_PARTIAL`). Wie een deel wil
  terugdraaien storneert volledig en boekt de juiste transactie opnieuw. Bewuste
  MVP-grens; een gedeeltelijke variant vraagt om een tweede neutralisatievorm en om
  hertoewijzing van FIFO, en is daarmee eigen functionaliteit.
- **Rapportage telt bruto.** `payments.amount` en `expenses.amount` sommeren nog
  steeds origineel én correctie. Een correctie van 1000 naar 800 laat de bruto
  betalingslijst 1800 tonen. Eigenaarsaldi corrigeren zichzelf wél, omdat die uit
  `amount - settled_amount` volgen en de storno `settled_amount` herstelt.
  `v_financial_reversals` maakt zichtbaar wat gestorneerd is; het netten in de UI is
  Checkpoint 3 en is bewust niet in de databasekern gebouwd.
- `v_allocation_integrity` en `v_reconciliation_4111` dragen nog overbodige
  INSERT/UPDATE/DELETE-grants voor `authenticated`, geërfd van de default-ACL. Beide
  views zijn niet auto-updatable (`is_insertable_into = NO`), dus die rechten zijn
  onbruikbaar. Voor de drie NIEUWE views is dit in `m27`/`m28` wél ingetrokken; de twee
  oude vallen buiten de scope van de reversal-engine en horen in een eigen
  opruimronde. **P2, geen merge-blocker.**
- **`fiscal_year_closings.closed_by` blokkeert het verwijderen van een gebruiker.**
  Exact dezelfde fout die `m28` voor `financial_reversals.created_by` heeft gesloten,
  bestaat pre-existent op `fiscal_year_closings`: de kolom is
  `REFERENCES auth.users(id) ON DELETE SET NULL`, en PostgreSQL voert die RI-actie uit
  als een UPDATE op de kindrij — die `fn_guard_fy_closing_immutable` sinds `m18`
  onvoorwaardelijk weigert. Gevolg: `DELETE FROM auth.users` faalt voor iedereen die
  ooit een boekjaar heeft afgesloten, wat offboarding en AVG-verwijdering blokkeert.
  Gevonden tijdens de adversariële review op `m24`–`m27`. **Bewust NIET in `m28`
  gerepareerd** — het raakt de jaarafsluiting en niet de reversal-engine, en hoort met
  een eigen test in een eigen ronde. De fix is dezelfde vorm als die in `m28`: alleen
  de overgang `closed_by → NULL` toestaan wanneer de gebruiker daadwerkelijk weg is en
  alle overige kolommen ongewijzigd zijn. **P1 voor de volgende ronde.**
- **Heropenen en opnieuw afsluiten: bekende beperking, volledig beschreven.**
  `fiscal_year_closings` kent `UNIQUE (fiscal_year_id)`, dus er kan hoogstens één
  afsluitbewijs per boekjaar bestaan, en sinds `m22` is dat bewijs onwijzigbaar en niet
  verwijderbaar zolang het boekjaar bestaat. Na een eerste afsluiting en een
  daaropvolgende heropening (owner/admin) **blijft dat oude afsluitbewijs dus staan**.
  Gevolgen, in deze volgorde:
    - `close_fiscal_year()` kan het jaar niet opnieuw afsluiten en weigert met
      `FY_CLOSING_EXISTS`; het zou het bestaande bewijs moeten overschrijven.
    - **Belangrijk:** juist omdát er al een afsluitbewijs bestaat, komt een directe
      `UPDATE fiscal_years SET status='closed'` na die heropening op dit moment **weer
      door de guard heen**. `trig_02_fy_close_requires_closing` controleert alleen of
      er een afsluitbewijs *bestaat*, niet of het bij deze afsluiting hoort.
    - Daardoor blijven `closed_at`, `closed_by` en `result_amount` afkomstig van de
      **eerste** afsluiting, en worden bij die tweede afsluiting geen journaalcontrole
      en geen herberekening van het resultaat uitgevoerd.
    - De invariant "een gesloten boekjaar heeft een afsluitbewijs" blijft wél intact.
    - Maar het afsluitbewijs vertegenwoordigt dan **niet noodzakelijk de meest recente
      afsluiting** van dat boekjaar.
  Een echte heropen-/hersluitcyclus vraagt om meerdere of geversioneerde
  afsluitbewijzen per boekjaar, of om een expliciete herafsluitflow, en dus om een
  schemawijziging. Bewust buiten `m23` gehouden: **P2 / toekomstige workflow, geen
  merge-blocker voor `m23`.** Er bestaat vandaag geen UI-flow voor afsluiten of
  heropenen, dus dit scenario is via de applicatie niet bereikbaar.
- Er is nog geen periodieke reconciliatie tussen 5141 (bank) en de
  `payments`-registratie; `v_allocation_integrity` dekt alleen de vorderingenkant.

**Opgelost in `m24`–`m28`** — de gecontroleerde storno-/correctieflow, de laatste
functionele P1 uit de reeks.

`m28` sluit vier bevindingen uit de adversariële review op `m24`–`m27`, alle vier bewezen
met een rollback-probe op de live database:

- **De settlement-guard leunde op een onbewaakte optelling.**
  `fn_guard_ca_settlement_derived` leidt `settled_amount` af uit
  `SUM(payment_allocations.amount)`, maar niets koppelde die som aan `payments.amount`.
  Een verzonnen extra toewijzing van 600,00 op een bestaande betaling van 400,00 werd
  nergens tegengehouden, waarna een vordering van 1000,00 legitiem volledig afgeboekt kon
  worden terwijl er 400,00 was ontvangen. `v_settlement_integrity` stelt dezelfde
  vergelijking en meldde daardoor `ok = true`: geen preventie én geen detectie.
  `fn_guard_pa_within_payment` bindt de som nu aan de betaling; de nieuwe view
  `v_payment_allocation_integrity` maakt het meetbaar. Dit was de scherpste van de vier —
  de guard was precies zo sterk als zijn zwakste invoer, en dat was niet wat `m25` claimde.
- **Een gebruiker die ooit een storno boekte kon niet worden verwijderd.**
  `created_by` is `ON DELETE SET NULL`; PostgreSQL voert dat uit als een UPDATE, en de
  immutability-guard weigerde elke UPDATE onvoorwaardelijk. `DELETE FROM auth.users` —
  precies wat Supabase' admin `deleteUser` doet — faalde daardoor met `23514`, wat
  offboarding en AVG-verwijdering hard blokkeerde. Toegestaan is nu uitsluitend de
  overgang `created_by → NULL` wanneer de gebruiker daadwerkelijk weg is en alle overige
  kolommen ongewijzigd zijn; reden, tijdstip en bedrag blijven staan.
- **De gespiegelde journaalpost los verwijderen sloopte de audittrail.** De FK naar
  `journal_entries` staat op `ON DELETE CASCADE`, dus het wissen van de storno-post nam de
  `financial_reversals`-rij én de neutralisaties mee terwijl `settled_amount` verlaagd
  bleef. De vordering stond dan afgeboekt zonder enige onderbouwing, en raakte bovendien
  permanent geblokkeerd voor nieuwe betalingen. `fn_guard_reversal_entry_delete` weigert
  dat nu, met de gebruikelijke parent-cascade-escape zodat offboarding blijft werken.
- **Een correctie kon over twee OPEN boekjaren worden gesplitst.** De storno volgde het
  originele boekjaar zolang dat open was, terwijl `fn_journal_from_payment` de vervangende
  betaling altijd in het meest recente open jaar boekt. Stond er een nieuwer open jaar
  naast, dan belastte de storno 2025 en de correctie 2026, en meldde de detector
  `is_correctie_vorig_boekjaar` ten onrechte `false`. Betalingen volgen nu altijd het meest
  recente open boekjaar, dezelfde regel als `fn_journal_from_payment`, zodat beide helften
  per definitie in hetzelfde jaar landen. Uitgaven houden hun eigen regel, omdat
  `correct_expense` het doelboekjaar expliciet meegeeft.

De engine zelf, uit `m24`–`m27`:

- **Er is nu een storno- en correctieroute voor betalingen en voor gejournaliseerde
  uitgaven.** Vier RPC's: `reverse_payment`, `correct_payment`, `reverse_expense`,
  `correct_expense`. Het origineel wordt nooit gewist of overschreven; de storno is
  een gespiegelde journaalpost (`journal_entries.source = 'reversal'`) in het geldige
  OPEN boekjaar, plus append-only neutralisatierijen die de openstaande vordering
  herstellen. Een gecorrigeerde transactie is een gewone nieuwe rij, zodat de
  bestaande FIFO- en journaalmotoren ongewijzigd hun werk doen.
- **`charge_allocations.settled_amount` is niet langer vrij muteerbaar.** Dit was de
  scherpste openstaande P1: de kolom waarop de hele debiteurenpositie rust, kon door
  elke SECURITY DEFINER-context en door `service_role` op een willekeurige waarde
  worden gezet. `fn_guard_ca_settlement_derived` dwingt nu de invariant zelf af:

      settled_amount = SUM(payment_allocations.amount)
                     - SUM(payment_allocation_reversals.amount)

  Bewust GEEN identificatie van de aanroeper. `pg_trigger_depth()` bewijst alleen dat
  er érgens een trigger draait, niet welke; een transactielokale GUC verplaatst het
  probleem naar "wie kan die GUC zetten", met bewijslast die nooit afneemt. Door de
  invariant te controleren in plaats van de aanroeper is er geen context om te
  vervalsen. `v_settlement_integrity` maakt eventuele drift zichtbaar.
- **Een geboekte betaling en een geboekte uitgave zijn onwijzigbaar op alles wat het
  grootboek raakt.** Bevroren zodra er een journaalpost hangt: bij betalingen bedrag,
  eigenaar, gebouw, valutadatum en betaalwijze; bij uitgaven bedrag,
  grootboekrekening, categorie, uitgavedatum en gebouw. Bewust vrij: `reference` bij
  betalingen en leverancier/omschrijving/bewijsstuk bij uitgaven. Zonder deze guards
  zouden er twee wegen naar hetzelfde resultaat bestaan — de auditeerbare
  correctieflow en een stille UPDATE — en dan is de audittrail optioneel.
- **Storno van een storno is structureel onmogelijk.** Een reversal is geen
  `payments`- en geen `expenses`-rij, dus er bestaat geen bron om naar te wijzen.
  Daarvoor was geen extra constraint nodig; de vorm sluit het uit.
- **Een gesloten boekjaar wordt nooit herschreven.** De storno landt altijd in een
  OPEN boekjaar. Wat wél mag is het herstellen van `settled_amount` in een gesloten
  jaar: dat is de doorlopende debiteurenpositie op 4111 en geen wijziging van de
  vastgestelde jaarrekening — zie `docs/accounting-rules.md` paragraaf 2 en 5.
  Autorisatie volgt die scheiding: origineel in een open jaar vraagt `can_write`,
  origineel in een afgesloten jaar `can_manage_members` (owner/admin).
- **Bug gevonden en gerepareerd tijdens deze ronde (`m27`).** De twee
  immutability-guards uit `m25` bouwden hun veldenlijst met een ongetypeerd literal
  (`velden || 'bedrag'`), waardoor PostgreSQL `anyarray || anyarray` koos en faalde
  met `malformed array literal`. Gevolg: de guard sloeg af vóór de controle op het
  bestaan van een journaalpost, gaf een onbegrijpelijke fout in plaats van
  `PAYMENT_IMMUTABLE`, én weigerde een volstrekt legitieme wijziging aan een uitgave
  zonder journaalpost. Gevonden door tests A11–A16, gerepareerd met een expliciete
  `::text`-cast. `m22` liep hier niet tegenaan omdat het `format()` gebruikt.

**Opgelost in `m23`** — de drie resterende integriteitsgaten uit de adversariële
review van PR #4:

- **Banktransacties tellen mee als financiële historie van een gebouw.** Bewezen gat
  vóór `m23`: een manager verwijderde een gebouw zonder boekjaar met twee
  banktransacties van samen 165.000 MAD; transacties over: 0.
  `fn_building_direct_history_summary` telt ze nu via `bank_accounts` en meldt
  `banktransactie(s)`. Een **lege** bankrekening blijft stamdata — het rekeningnummer
  zonder mutaties is geen historie. De COMMENT die `bank_accounts` eerder wegzette als
  "stamdata zonder bedragen" is gecorrigeerd; dat klopte voor de rekening, niet voor de
  mutaties erop.
- **De EERSTE afsluiting van een boekjaar kan alleen via `close_fiscal_year()`.** Deze
  claim geldt precies voor een boekjaar dat nog géén afsluitbewijs heeft; voor de
  heropen-/hersluitsituatie geldt de uitzondering die hierboven staat beschreven.
  Bewezen gat vóór `m23`: `UPDATE fiscal_years SET status='closed'` slaagde met nul
  afsluitbewijzen. De nieuwe RPC valideert, vergrendelt het boekjaar, controleert dat
  het journaal sluit, berekent het resultaat volgens PCSI (klasse 7 minus klasse 6),
  schrijft het afsluitbewijs met `closed_by`/`closed_at` en zet de status — alles in
  één transactie. `trig_02_fy_close_requires_closing` is het vangnet: zolang er nog
  geen afsluitbewijs bestaat, wordt elke andere weg naar `closed` geweigerd, ook voor
  owner, admin en de postgres-context. De omgekeerde richting volgt uit de constructie:
  alleen de RPC kan een afsluitbewijs aanmaken (RLS op INSERT staat op `false`), en die
  zet de status in dezelfde transactie. Autorisatie: `can_write`, dezelfde kring die
  ook lastenoproepen boekt — bewust níet beperkt tot owner/admin, want *heropenen* is de
  uitzonderlijke ingreep en blijft wél aan owner/admin voorbehouden.
- **Een uitgave met journaalpost is niet direct verwijderbaar**
  (`EXPENSE_HAS_FINANCIAL_HISTORY`). Bewezen gat vóór `m23`: een manager verwijderde
  een uitgave van 900,00; de journaalpost bleef staan (1 vóór, 1 ná), dus 6110 debet en
  4411 credit stonden zonder brondocument. `journal_entries.source_id` heeft geen
  foreign key, dus zonder deze guard blijft er niets over dat de wees ergens aan
  koppelt. Bewust géén opruiming van de journaalpost: dat zou historie herschrijven.
  Dit spiegelt de betalingsguard uit `m22`.
- **`TRIGGER` en `REFERENCES` zijn ingetrokken** voor `anon` en `authenticated` op
  alle tabellen in `public` (61 grants elk), inclusief `ALTER DEFAULT PRIVILEGES` voor
  toekomstige tabellen. Noodzaakanalyse: PostgREST heeft USAGE op het schema,
  SELECT/INSERT/UPDATE/DELETE op de tabellen en EXECUTE op de RPC's nodig; RLS vraagt
  niets extra's. Beide rechten zijn DDL-nabij en worden door de stack niet gebruikt.
  Nagemeten dat de gewone paden blijven werken: RLS-CRUD, lidmaatschapsqueries en
  `create_charge_call`.

**Opgelost in `m22`** — de resterende financiële en security-routes uit de
adversariële review van PR #3:

- **TRUNCATE** is ingetrokken voor `anon` en `authenticated` op alle tabellen in
  `public`, plus via `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` voor tabellen die
  later worden aangemaakt. Bewezen: `SET ROLE authenticated; TRUNCATE
  public.expenses` slaagde vóór `m22` en wiste RLS-blind alle tenants; nu
  `permission denied`. SELECT/INSERT/UPDATE/DELETE blijven ongewijzigd.
  *Nog niet afgedekt:* er bestaat een tweede default-ACL met grantor
  `supabase_admin`. Die kunnen we niet aanpassen (`postgres` is er geen lid van; de
  poging faalt met "permission denied to change default privileges"). Hij geldt
  alleen voor tabellen die `supabase_admin` zelf in `public` aanmaakt.
- **Betalingen** met toewijzingen, een journaalpost of een bankkoppeling zijn niet
  meer direct verwijderbaar (`PAYMENT_HAS_FINANCIAL_HISTORY`). Er wordt bewust
  niets teruggerekend en niets gestorneerd: dat is een reversal-flow, geen guard.
  Bewust **geen** escape op `owners` — die tabel heeft sinds `m18` haar eigen guard,
  en een escape zou de betalingsguard gratis omzeilbaar maken.
- **Jaarafsluitingen** zijn niet meer verwijderbaar zolang het boekjaar bestaat
  (`FISCAL_YEAR_CLOSING_IMMUTABLE`). UPDATE was al onvoorwaardelijk geblokkeerd;
  DELETE en UPDATE zijn nu symmetrisch. `fiscal_years.status = closed` kan daarmee
  niet meer bestaan zonder bijbehorend afsluitbewijs.
- **De gebouwguard** kijkt niet langer alleen via `fiscal_years` maar telt
  rechtstreeks op `building_id`: lastenoproepen, betalingen, uitgaven,
  journaalposten, jaarafsluitingen, definitieve documenten en fondsmutaties.
  Bewezen gat vóór `m22`: een gebouw zonder boekjaar maar met 75.000 aan uitgaven,
  30.000 fondsmutatie en een definitief document was gewoon te verwijderen.
- **Rijvergrendeling** in de boekjaar-, gebouw- en betalingsguard. Een BEFORE
  ROW-trigger draait vóór het verwerven van de tuple-lock; zonder eigen
  `FOR UPDATE` kon een gelijktijdige INSERT van historie alsnog worden
  weggecascadeerd. *Analytisch vastgesteld en structureel afgedekt; een echte
  parallelle-sessietest vereist `dblink` of `postgres_fdw`, die wel beschikbaar
  maar niet geïnstalleerd zijn.*
- **Parent-cascade escapes** op de vijf resterende closed-fy guards
  (`charge_calls`, `charge_allocations`, `payment_allocations`, `journal_lines`,
  `fund_movements`). Offboarding werkte tot nu toe alleen doordat de interne
  RI-trigger van `fiscal_years` toevallig vóór die van de kindtabellen staat in de
  aanmaakvolgorde van de foreign keys. Zou `fiscal_years_organization_id_fkey` ooit
  worden gedropt en opnieuw aangemaakt, dan deadlockte de offboarding van élke
  organisatie die ooit een boekjaar heeft afgesloten.
- **Documenten** zijn onveranderlijk zodra ze de conceptfase verlaten
  (`DOCUMENT_IMMUTABLE`): nooit terug naar `concept`, en `verification_number`, de
  drie koppelingen, het documenttype en de reeds gevulde `content_hash`/`pdf_url`
  liggen vast. `definitief → geannuleerd` blijft toegestaan; die status telt nog
  steeds als historie en opent dus geen omweg. Titel en `meta` blijven vrij.
- **De boekjaarkoppeling van een uitgave** ligt vast (`EXPENSE_FY_IMMUTABLE`).
  Losmaken of verplaatsen kan niet meer, omdat de journaalpost niet mee kan
  verhuizen (`journal_entries` staat voor `authenticated` op `USING (false)`).
  Achteraf koppelen is eveneens geweigerd (`EXPENSE_FY_LATE_ASSIGNMENT`):
  `fn_journal_from_expense` is AFTER INSERT only, dus zo'n uitgave zou wél in het
  boekjaar maar niet in het grootboek belanden. De werkroute is de uitgave
  intrekken en opnieuw boeken mét boekjaar.
- **`is_org_member()`** gebruikt nu `from public.memberships` met
  `search_path = public, pg_temp`, waarmee pg_temp-shadowing van de 96 policies die
  deze functie dragen is uitgesloten. Grants ongewijzigd.

**Bewust niet aangepast:** de advisor meldt `fn_alloc_distribute` met een mutable
`search_path`. Beoordeeld en geaccepteerd: die functie is SECURITY INVOKER, heeft
geen EXECUTE voor `anon` of `authenticated`, en raakt geen enkele tabel — hij
rekent alleen op arrays. Een `SET search_path` toevoegen zou de waarschuwing
wegpoetsen zonder iets te beschermen.

**Opgelost in `m21`** — het verwijderen van een boekjaar met financiële historie:

- Een boekjaar met lastenoproepen, allocaties, betalingskoppelingen,
  journaalposten, uitgaven, jaarafsluitingen, definitieve documenten of
  fondsmutaties binnen zijn periode is niet meer direct verwijderbaar
  (`FY_HAS_FINANCIAL_HISTORY`). De invariant geldt voor élke rol, ook
  owner/admin — er is bewust geen shortcut.
- `buildings` kreeg een spiegelguard (`BUILDING_HAS_FINANCIAL_HISTORY`). Zonder
  die guard zou de boekjaarguard triviaal te omzeilen zijn door het gebouw te
  verwijderen. **Gedragswijziging:** een gebouw met financiële historie is nu
  niet langer verwijderbaar; dat was het tot en met `m20` wél.
- Een boekjaar mét historie kan niet meer naar een ander gebouw verhuizen — dat
  was anders de omweg: verhuizen naar een leeg gebouw en dat gebouw slopen.
- Twee bestaande deadlocks meegenomen: een gebouw of organisatie met een
  **gesloten** boekjaar was permanent onverwijderbaar, en een uitgave of
  journaalpost die kruislings naar het gesloten boekjaar van een ánder gebouw
  verwees blokkeerde de sloop van het eerste gebouw.
- `organizations` verwijderen blijft de bewuste, volledige uitgang
  (offboarding), via RLS voorbehouden aan de owner.

Drie punten uit deze lijst zijn inmiddels **wél** opgelost door `m12`–`m20` en
staan hier alleen nog ter historie:

- ~~Het wijzigen of verwijderen van een `charge_call` laat allocaties en
  journaalpost staan.~~ Wijzigen is nu geblokkeerd (`trig_00_cc_immutable`);
  intrekken ruimt de journaalpost op en is onmogelijk zodra er betalingen aan
  hangen.
- ~~De tantième-verdeling waarschuwt niet bij een afwijkende som.~~ Een
  lastenoproep op tantièmes over het hele gebouw **faalt nu hard**
  (`ALLOC_CONTROL_TOTAL`) zolang de som afwijkt van `buildings.total_tantiemes`,
  tenzij een onderbouwde derogatie met vervalboekjaar is vastgelegd.
- ~~`charge_allocations.unit_id` mist een samengestelde foreign key.~~ `units`
  en `fiscal_years` hebben sinds `m12` een `UNIQUE (id, building_id)`, en
  `charge_allocations` hangt daar sinds `m13`/`m18` met een samengestelde FK
  aan vast. Er is géén `units.organization_id` nodig gebleken: de keten loopt
  via `buildings(id, organization_id)`.

---

## Release-gate status

De eerdere lockfile/build-blocker is opgelost in commit `d31f191`:

- `pnpm install --frozen-lockfile`: groen;
- `pnpm exec tsc --noEmit`: groen;
- `pnpm run lint`: groen, 0 errors / 0 warnings;
- `pnpm run build`: groen;
- Vercel-statuscheck op `d31f191`: groen;
- Supabase security-integratietests: 18/18 groen met rollback.

Dit is daarom geen openstaand known issue meer.

# Bekende problemen en handmatige stappen

Bijgewerkt: 26-08-2026, na de financial integrity hardening (`m22`).

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
  alsnog aan gekoppeld worden.
- `funds.balance` wordt alleen bij INSERT bijgewerkt, niet bij UPDATE/DELETE van
  een fondsmutatie.
- Er is geen controle dat `journal_entries.entry_date` binnen de periode van het
  boekjaar valt.
- Er is geen audit trail van financiële mutaties (wie boekte wat, wanneer).
- Er bestaat geen storno- of terugbetaalflow. Sinds `m22` is een betaling met
  historie niet meer verwijderbaar, en `fn_journal_from_payment` maakt bij élke
  INSERT een journaalpost. In de praktijk is daarmee **geen enkele betaling nog
  direct verwijderbaar**. Dat is de bedoelde uitkomst — wissen is geen correctie —
  maar het maakt een echte correctieroute wel de eerstvolgende functionele stap.
- Er is nog geen periodieke reconciliatie tussen 5141 (bank) en de
  `payments`-registratie; `v_allocation_integrity` dekt alleen de vorderingenkant.

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

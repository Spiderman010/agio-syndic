# Resterende i18n-schuld

Opgemaakt aan het eind van sprint 1 (app shell), 31-08-2026.

Sprint 1 heeft de schil volledig `next-intl`-gestuurd gemaakt. Wat de sprint
**niet** heeft gedaan — bewust — is de bestaande schermen herschrijven. Dit is de
lijst van wat er nog openstaat.

## Uitgangspunt

Er zijn nu **240 vertaalsleutels per taal** in `fr`, `nl` en `ar`, met **nul**
afwijkingen tussen de drie. Dat wordt afgedwongen door een test
(`tests/nav.test.ts` → "geen enkele taal mist een sleutel die het Frans wel
heeft"), dus deze eigenschap kan niet stilzwijgend wegzakken.

De regel vanaf nu: **geen nieuw scherm mergt met een hardgecodeerde tekst.**
Opruimen van oud werk gebeurt wanneer dat scherm toch wordt aangeraakt.

## Wat sprint 1 heeft opgelost

- Nieuwe naamruimten `nav`, `shell` en `dashboard` in alle drie de talen.
- De topbar was voorheen volledig hardgecodeerd Frans (`Déconnexion`) — nu vertaald.
- Drie handgemaakte broodkruimels met hardgecodeerd `Bâtiments` / `Exercices` /
  `Tous les bâtiments` zijn vervangen door één vertaald kruimelspoor in de schil.
- De leesrichting is uit de layout gehaald naar `localeDirection()` en getest;
  de hele schil gebruikt logische CSS-eigenschappen, afgedwongen door een test
  die de broncode van `src/components/shell/` scant op `ml-`, `border-l`,
  `text-left` en verwanten.

## Wat er nog staat

| Bestand | Vertaalhook | Literals | Opmerking |
| --- | --- | --- | --- |
| `(app)/buildings/[id]/page.tsx` | **nee** | 24 | Zwaarste post. Gebouwdetail: bankgegevens, lots, eigenaars, tantième-waarschuwing. Heeft nog geen enkele vertaalhook. |
| `(app)/buildings/[id]/boekjaren/[fy_id]/page.tsx` | ja | 29 | Vertaalt deels, maar de lastenoproep- en betaalformulieren zijn Frans: `Nouvel appel de charges`, `Type`, `Régulier`, `Échéance`, betaalwijzen. |
| `(app)/buildings/BuildingsClient.tsx` | ja | 7 | Tier-labels (`Klein`/`Midden`/`Groot`) komen uit `TIER_LABELS` in `src/lib/tier.ts` en zijn Nederlands in een Franse UI. |
| `src/components/shell/AppShell.tsx` | ja | 2 | `Agio Syndic` — productnaam, hoort **niet** vertaald te worden. Geen schuld. |
| `src/app/[locale]/login/page.tsx` | ja | 1 | Idem: alleen de productnaam. Geen schuld. |

Netto openstaand: **drie bestanden, circa 60 zichtbare teksten.**

## Twee posten die meer zijn dan een vertaling

1. **`TIER_LABELS` in `src/lib/tier.ts`** is een Nederlandstalige constante die
   rechtstreeks in de UI wordt gerenderd. Dit hoort een vertaalsleutel te
   worden, niet een string in een lib-bestand. Raakt twee schermen.

2. **Foutmeldingen uit server actions zijn Nederlands.** `src/lib/validation.ts`
   en `src/lib/guard.ts` geven Nederlandse tekst terug die als toast in een
   Franse of Arabische UI verschijnt. Dit staat al in `docs/known-issues.md` §5
   en is geen schil-werk: het vraagt om `getTranslations()` in de server actions,
   net zoals `src/lib/reversalErrors.ts` dat al goed doet met stabiele codes.
   **Dit is de meest zichtbare post voor een echte gebruiker**, want hij treedt
   op precies wanneer er iets misgaat.

## RTL

De schil is op 360 px en 1440 px in het Arabisch gecontroleerd: de sidebar staat
rechts, de mobiele lade opent van rechts, iconen staan aan de juiste kant en er
is geen horizontale overflow. Wat nog **niet** gecontroleerd is, omdat het buiten
de schil valt:

- de bestaande formulieren op de drie schermen hierboven;
- getalopmaak — bedragen gebruiken `toLocaleString("fr-MA", …)`, hardgecodeerd op
  Frans-Marokkaans, ook in de Arabische en Nederlandse versie;
- datumopmaak — datums worden als kale ISO-strings getoond (`2026-01-31`) in
  plaats van via `Intl.DateTimeFormat` met de actieve locale.

Die laatste twee zijn geen vertaalschuld maar lokalisatieschuld, en ze horen bij
de sprint die de eerste cijferschermen bouwt.

## Volgorde-advies

1. `TIER_LABELS` naar vertaalsleutels (klein, raakt twee schermen).
2. `(app)/buildings/[id]/page.tsx` volledig vertalen — het enige scherm zonder
   enige hook.
3. Getal- en datumopmaak locale-bewust maken, samen met de eerste tabellen.
4. Server-action-foutmeldingen vertalen; het patroon uit `reversalErrors.ts`
   herhalen in plaats van iets nieuws bedenken.
5. Formulieren op de boekjaarpagina, wanneer dat scherm toch wordt gesplitst.

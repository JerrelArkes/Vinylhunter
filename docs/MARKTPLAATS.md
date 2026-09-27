# De Marktplaats-scan (B)

Een script voor je eigen pc dat de nieuwe vinylpartijen op Marktplaats voor je doorloopt en per partij
zegt of het de moeite is: **snel reageren**, **bekijken** of **overslaan**, met een geschatte waarde en een
redelijk bod. Het resultaat is één HTML-pagina met foto's en links naar de advertenties.

## Wat er gebeurt

1. **Zoeken** (Apify): de nieuwste advertenties van gisteren en vandaag in *Cd's en Dvd's*, met een reeks
   zoekwoorden (`partij`, `collectie`, `verzameling`, `lp's`, `platen`, `singles`, `elpees`, `vinyl`).
   Daarna zelf filteren: alleen vinyl-categorieën, geen opkopers ("LP's gezocht"), en een partij in de titel.
2. **Details** (Apify): van de nieuwste N partijen de hele advertentie: alle foto's, de volledige tekst en
   het exacte plaatsingstijdstip. Wat ouder is dan 24 uur valt af (handelaren zetten oude advertenties
   dagelijks omhoog).
3. **Beoordelen** (Claude, Opus): alle foto's per partij (max 12). Leesbare titels, aantal, genres, staat,
   wat ervoor en ertegen pleit. Ook bij een partij waarvan maar 2-3 platen te zien zijn.
4. **Discogs**: de leesbare titels opzoeken (max 10 per partij), vinylprijzen.
5. **Advies** (Claude): oordeel, score, geschatte doorverkoopwaarde, bod, vragen voor de verkoper.
6. **Overzicht**: `marktplaats/partijradar.html`, de interessantste bovenaan.

## Wat je nodig hebt

| | Waar | Kosten |
|---|---|---|
| Apify-account + API-token | [console.apify.com](https://console.apify.com) → *Settings* → *API & Integrations* | ~$0,0009 per zoekresultaat, ~$0,0025 per advertentie (gratis tegoed per maand) |
| Discogs-token | [discogs.com/settings/developers](https://www.discogs.com/settings/developers) | gratis |
| Claude, één van: | | |
| — API-sleutel | [console.anthropic.com](https://console.anthropic.com) | ~$0,10 per partij (Opus, ~5-12 foto's) |
| — je abonnement | Claude Code geïnstalleerd en ingelogd (`claude`, dan `/login`) | telt mee voor je limiet; een partij met veel foto's is een flinke hap |

Voorbeeld van een proef met 30 partijen: Apify ~$0,10 voor de details (plus het zoeken), Claude $2,29
(24 partijen, de rest was al weg), ~10 min beoordelen en ~10 min Discogs.

## Instellen

In de projectmap (na `npm install`), in `agent.env` (kopie van `agent.env.example`):

```
APIFY_TOKEN=apify_api_…
DISCOGS_TOKEN=…
ANTHROPIC_API_KEY=sk-ant-api…      # niet nodig met --claude abonnement
```

## Draaien

```bash
npm run scan                               # alles, 30 partijen, afgelopen 24 uur
npm run scan -- --max 10                   # minder partijen (goedkoper, sneller)
npm run scan -- --claude abonnement        # via je eigen Claude-abonnement i.p.v. de API
npm run scan -- --opnieuw                  # vorige resultaten weggooien en opnieuw beginnen
```

Losse stappen (handig als er iets misging; elke stap bewaart zijn resultaat in `marktplaats/` en slaat
over wat al klaar is):

```bash
node tools/marktplaats-scan.mjs zoek
node tools/marktplaats-scan.mjs details --max 30
node tools/marktplaats-scan.mjs beoordeel
node tools/marktplaats-scan.mjs discogs
node tools/marktplaats-scan.mjs advies
node tools/marktplaats-scan.mjs html
```

Overige opties: `--uren 48` (verder terug), `--model claude-sonnet-5` (goedkoper, minder scherp),
`--zoekwoorden partij,collectie` en `--per-zoekwoord 300` (zoekresultaten per woord).

Elke dag automatisch: plan `npm run scan -- --opnieuw` in met Taakplanner (Windows), cron of launchd.

## Goed om te weten

- **Volume**: in een proef stonden er in 24 uur ~290 advertenties met een partij in de titel (vooral
  singles en pop). Alles beoordelen kost via de API ~$25-30 per dag; begin met `--max 30`.
- **Marktplaats verbiedt automatisch uitlezen** in zijn voorwaarden. Gebruik dit alleen voor jezelf, niet
  vaker dan nodig, en altijd via Apify: rechtstreeks veel pagina's opvragen gaf in een proef na een paar
  honderd verzoeken een blokkade van het internetadres.
- **Het advies is een eerste schifting**, geen taxatie. Op foto's van stapels of ruggen zijn de meeste
  titels niet leesbaar; de waarde is een voorzichtige schatting van wat zichtbaar is. Vraag bij "bekijken"
  de verkoper om een lijst of meer foto's.
- De map `marktplaats/` bevat advertentieteksten en verkopersnamen en staat in `.gitignore`.

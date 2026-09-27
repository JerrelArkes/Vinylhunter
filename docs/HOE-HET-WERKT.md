# Hoe het werkt

## Opbouw

```
telefoon (browser)                         Cloudflare Worker (src/index.js) + D1-database
  /            camera (src/pages/cam.html)  ─POST /api/scan──▶  scan opslaan, status 'queued'
  /resultaten  overzicht (results.html)     ◀─GET /api/list──   ├─ herkenning: Claude-API (src/claude.js)
                                                                │   of 'wacht_op_pc' voor de agent
                                                                ├─ vinyl → Discogs (src/discogs.js)
                                                                ├─ Pokémon → TCGdex (src/pokemon.js)
                                                                └─ keramiek/zilver/overig → analyse +
                                                                   prijscheck met web search (src/expert.js)

agent-pc (tools/discogs-agent.mjs), optioneel, alleen uitgaande verbindingen:
  POST /api/agent/next         Discogs-opvragingen vanaf het eigen internetadres
  POST /api/agent/claude/next  herkenning/analyse via claude -p (tools/claude-cli.mjs)
                               of een lokaal model (tools/local-llm.mjs)
```

- **Status van een scan:** `queued → recognizing → recognized → looking_up → done`, of `wacht_op_pc` als de
  agent-pc het doet. Eindstatussen `unclear`, `no_record`, `not_found`, `error` (na 3 pogingen). Een cron
  (elke minuut) pakt vastgelopen en liggende scans op.
- **Routes** (instelling `claude_bron`, schakelaar in de app, standaard `DEFAULT_BRON`): `api`,
  `abonnement`, `lokaal`. Lokaal doet alleen herkenning; analyses gaan dan via de API.
- **Dubbele foto's:** vóór de herkenning (`src/twin.js`: grijsafdruk + kleurhistogram van de camera) en
  na de herkenning (zelfde artiest+titel binnen 30 min, of dezelfde Discogs-release).
- **Toegang:** wachtwoord (`APP_PASSWORD`, sessiecookie 30 dagen, 3 pogingen per IP, daarna 1 uur
  blokkade), optioneel Cloudflare Access. De agent heeft een eigen sleutel (`AGENT_KEY`). Alles `noindex`.

## Herkenning

Eén Claude-aanroep per foto met een vast JSON-schema (`src/recognize.js`, `src/pokemon.js`). Eerst
`MODEL` (Sonnet 5); vindt Discogs/TCGdex niets, dan nog één keer `FALLBACK_MODEL` (Opus 5). Gemeten op 28
hoesfoto's: Sonnet 27/28, Opus 28/28. De prompt vraagt artiest en titel letterlijk zoals ze op de hoes
staan: niet vertalen of "verbeteren" (een vertaalde titel gaf een verkeerde verzamelplaat).

## Discogs: prijsrange binnen 60 opvragingen per minuut

1. **Stap 1** (`lookup`): zoeken + master → ondergrens en aantal te koop (~1,5 opvragingen).
2. **Stap 2** (`fillRange`): vinylpersingen + de 3 meest gezochte persingen → bovenkant en aantal persingen
   (~4 opvragingen). Nieuwe scans gaan voor; aanvullen gebeurt als er niets wacht.

Cache in D1 (zoekresultaten 30 dagen, masters 7 dagen, prijzen 1 dag): een plaat die je al eens
scande kost 0 opvragingen. Na een weigering (429) pauzeert alles 60 s.

**Zoekvolgorde** (elke treffer wordt gecontroleerd met `matches()`):
1. catalogusnummer (artiest moet kloppen, plus titel, label of een specifiek nummer: korte nummers als
   "3995" delen tientallen labels);
2. master op artiest + titel;
3. release op artiest + titel (singles hebben vaak geen master);
4. vrije tekst op kernwoorden;
5. alleen de titel (vangt een verkeerd gelezen artiest).

Test: `node tools/zoektest.mjs` (90 gevallen, alleen Discogs, uit een cache).

**Bekende beperking:** de ondergrens uit stap 1 komt van de master en telt ook cd's en cassettes mee
(Sgt. Pepper: €0,10). De bovenkant is wel vinyl-only. `fillRange` geeft ook `lowVinyl` terug (goedkoopste
van de top-3 vinylpersingen); de Marktplaats-scan gebruikt die al, de app nog niet.

## Keramiek, zilver, overig

Opus 5 beoordeelt 1-4 foto's met de naslag in `src/naslag.js` (merken, jaarletters, keurtekens). Een
prijscheck met web search volgt alleen bij interessante stukken en alleen in de cron (duurt 20-50 s). Zilver
krijgt ook de smeltwaarde uit de actuele zilverprijs. Waarde = wat het realistisch opbrengt bij
particuliere doorverkoop in Nederland, geen vraagprijs. Naslag alleen met gecontroleerde feiten; onzekere
punten als onzeker.

## Valkuilen

- Discogs telt per internetadres; Cloudflare deelt uitgaande adressen → gebruik de agent bij drukte.
- `waitUntil` krijgt na het antwoord nog maar 30 s: lange Claude-aanroepen (prijscheck) alleen in de cron.
- Free-plan: 10 ms CPU per aanvraag (foto's blijven daarom base64-tekst) en 100.000 aanvragen per dag (de
  agent gebruikt long-polls van 25 s, ~3.500 per dag in rust).
- Windows: `schtasks` stopt een taak standaard na 72 uur; gebruik de opdracht uit docs/AGENT.md.
- PowerShell blokkeert `npx.ps1`: gebruik `npx.cmd`.

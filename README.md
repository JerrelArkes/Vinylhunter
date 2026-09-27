# Vinylhunter

Scan vinyl (en meer) in de kringloopwinkel met je telefoon en zie meteen wat het waard is. Of laat
Claude elke dag de nieuwe vinylpartijen op Marktplaats voor je doorlopen.

Twee losse onderdelen, gebruik er één of allebei:

| | Wat het doet | Waar het draait | Nodig |
|---|---|---|---|
| **A. De app** | Camera aan in de winkel, foto van een hoes, en binnen ~5 s artiest, titel en prijsrange (Discogs). Ook Pokémon-kaarten, keramiek, zilver en "overig". | Je eigen gratis Cloudflare-account; openen in de browser van je telefoon | Cloudflare-account, Discogs-token, en Claude (API-sleutel, abonnement of lokaal model) |
| **B. De Marktplaats-scan** | Haalt de nieuwe vinylpartijen van de afgelopen 24 uur op, laat Claude de foto's beoordelen, zoekt leesbare titels op in Discogs en maakt een overzicht met koopadvies per partij. | Je eigen pc, als script | Apify-account, Discogs-token, Claude (API-sleutel of abonnement) |

## Snel beginnen

Je hebt [Node.js](https://nodejs.org) 20 of nieuwer nodig en [Git](https://git-scm.com).

```bash
git clone https://github.com/JerrelArkes/Vinylhunter.git
cd Vinylhunter
npm install
```

- **App (A):** volg [docs/APP.md](docs/APP.md). Kort: `npx wrangler login`, dan `npm run setup`.
- **Marktplaats-scan (B):** volg [docs/MARKTPLAATS.md](docs/MARKTPLAATS.md). Kort: sleutels in
  `agent.env`, dan `npm run scan`.
- **Agent-pc (optioneel, voor A):** een pc die altijd aan staat en Discogs vanaf een eigen internetadres
  bevraagt, en eventueel Claude via je abonnement of een lokaal model draait: [docs/AGENT.md](docs/AGENT.md).

Op Windows in PowerShell: gebruik `npx.cmd` en `npm.cmd` als `npx`/`npm` een foutmelding over
"running scripts is disabled" geven.

## Claude: drie routes

De herkenning en beoordeling doet Claude. Je kiest per sessie in de app hoe:

| Route | Snelheid | Kosten | Wat je nodig hebt |
|---|---|---|---|
| **API** | 2-3 s per foto | ~€0,005 per plaat, ~€0,02-0,20 per keramiek/zilverstuk | API-sleutel van [console.anthropic.com](https://console.anthropic.com) |
| **Abonnement** | 3-5 s per foto | geen kosten per foto; telt mee voor de limiet van je abonnement | Claude Pro/Max-abonnement en een agent-pc met Claude Code |
| **Lokaal model** | afhankelijk van je GPU | stroom | agent-pc met Ollama of LM Studio; alleen vinyl en Pokémon |

Een lokaal model maakt meer fouten: in een meting op 28 hoesfoto's haalde het beste lokale model
(Gemma 4 31B op een RTX 4090) 23/28, tegen 27/28 voor Claude Sonnet 5 en 28/28 voor Opus 5. Een verkeerd
gelezen plaat geeft een verkeerde prijs. Vindt Discogs niets, dan probeert de app het nog één keer met
Claude Opus via de API (als je een sleutel hebt). Meer in [docs/KOSTEN.md](docs/KOSTEN.md).

## Goed om te weten

- **Iedereen installeert zijn eigen kopie**, met eigen sleutels en eigen account. Deel geen
  API-sleutel, Discogs-token of Claude-abonnement: de route "abonnement" is bedoeld voor je eigen
  gebruik met je eigen abonnement, niet om de app voor anderen te laten draaien.
- **Discogs** staat 60 opvragingen per minuut toe, per internetadres. De app blijft daaronder (cache,
  prijs in twee stappen). Omzeil de limiet niet met extra tokens of wisselende IP-adressen: dat verbieden
  de [API-voorwaarden](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use) en
  kost je je account.
- **Marktplaats** verbiedt automatisch uitlezen in zijn voorwaarden. De scan gaat via Apify, alleen voor
  eigen gebruik en op kleine schaal. Rechtstreeks veel pagina's opvragen levert binnen een paar honderd
  verzoeken een blokkade van je internetadres op.
- **Prijzen zijn een indicatie.** De range loopt van het goedkoopste aanbod over alle vinylpersingen tot
  het duurste van de drie meest gezochte persingen. Welke persing jij in handen hebt, zie je niet aan de
  voorkant; check bij een hoge bovengrens zelf het catalogusnummer.
- De app is **niet vindbaar** in zoekmachines (`noindex`) en zit achter je eigen wachtwoord.

## Hoe het werkt

Zie [docs/HOE-HET-WERKT.md](docs/HOE-HET-WERKT.md) voor de opbouw (Cloudflare Worker + D1, agent, routes,
Discogs-zoekregels) en [CLAUDE.md](CLAUDE.md) als je er met Claude Code aan verder wilt bouwen.

## Licentie

MIT, zie [LICENSE](LICENSE).

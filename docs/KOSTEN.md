# Kosten

Gemeten in september 2026. Tarieven kunnen veranderen; controleer ze bij de aanbieder.

## App

| Onderdeel | Kosten |
|---|---|
| Cloudflare Workers + D1 | gratis binnen het Free-plan (100.000 aanvragen per dag; de app blijft daar ruim onder, ook met de agent) |
| Discogs | gratis (60 opvragingen per minuut per internetadres) |
| Pokémon-prijzen (TCGdex) | gratis |

**Claude per route:**

| Route | Vinyl / Pokémon per foto | Keramiek / zilver / overig per stuk |
|---|---|---|
| API | ~$0,005 (Sonnet 5), bij "niet gevonden" nog ~$0,012 (Opus 5) | analyse ~$0,02-0,05 (Opus 5), prijscheck met web search ~$0,18 |
| Abonnement | geen kosten per foto; telt mee voor de 5-uurslimiet van je abonnement | idem |
| Lokaal model | stroom; keramiek/zilver/overig gaan via de API | via de API |

Rekenvoorbeeld: een sessie van 1000 platen via de API is ~$11 (Sonnet met Opus als tweede poging). Alleen
Opus: ~$29.

**Vangnet**: `DAILY_SCAN_CAP` in `wrangler.jsonc` (standaard 5000 scans per 24 uur). Lekt je wachtwoord
uit, dan is dat het maximum wat iemand je per dag kan kosten (~$29).

## Marktplaats-scan

| Onderdeel | Kosten |
|---|---|
| Apify zoeken | ~$0,0009 per resultaat; 8 zoekwoorden × 300 = max ~$2,20 |
| Apify details | ~$0,0025 per advertentie; 30 partijen ~$0,08 |
| Claude beoordelen + advies (API, Opus) | ~$0,10 per partij |
| Claude via abonnement | geen kosten per partij, telt mee voor je limiet |

# Vinylhunter

Scan-app voor kringloopwinkels (Cloudflare Worker + D1, pagina's in `src/pages/`) en een los
Marktplaats-scanscript (`tools/marktplaats-scan.mjs`). Opbouw en valkuilen: `docs/HOE-HET-WERKT.md`.
Installatie: `docs/APP.md`, `docs/AGENT.md`, `docs/MARKTPLAATS.md`.

## Regels

- Sleutels (`agent.env`, `*.env.txt`, `agent-key.txt`, `apify-token.txt`, `.dev.vars`) nooit tonen,
  loggen of committen; ze staan in `.gitignore`.
- Discogs: maximaal 60 opvragingen per minuut per internetadres. Niet omzeilen (geen extra tokens of
  wisselende IP's): verboden door de Discogs-voorwaarden.
- Marktplaats alleen via Apify uitlezen, niet rechtstreeks in bulk (blokkade, voorwaarden).
- Elke Discogs-treffer controleren tegen artiest/titel; na wijzigingen `node tools/zoektest.mjs`.
- Database-wijziging = nieuw bestand in `migrations/` én bijwerken van `schema.sql`.
- Eerst lokaal testen (`npx wrangler dev --test-scheduled`), dan `npx wrangler deploy`.
- Prompts en schema's staan één keer in `src/`; de API-route, `claude -p` en het lokale model gebruiken
  dezelfde.
- Windows/PowerShell: `npx.cmd` en `npm.cmd`.

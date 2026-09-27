# De app installeren (A)

Je eigen kopie van de scan-app, op je eigen gratis Cloudflare-account. Reken op 20-30 minuten, waarvan
het meeste accounts aanmaken is.

## Wat je nodig hebt

| | Waar | Kosten |
|---|---|---|
| Node.js 20+ en Git | [nodejs.org](https://nodejs.org), [git-scm.com](https://git-scm.com) | gratis |
| Cloudflare-account | [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) | gratis (Workers Free-plan is genoeg) |
| Discogs-account + persoonlijk token | [discogs.com/settings/developers](https://www.discogs.com/settings/developers) → *Generate new token* | gratis |
| Claude, één van: | | |
| — API-sleutel | [console.anthropic.com](https://console.anthropic.com) → *API Keys*, tegoed opwaarderen | betaald per gebruik, zie [KOSTEN.md](KOSTEN.md) |
| — je Claude-abonnement | via een agent-pc, zie [AGENT.md](AGENT.md) | je bestaande abonnement |
| — een lokaal model | via een agent-pc, zie [AGENT.md](AGENT.md) | gratis, minder betrouwbaar |

Een API-sleutel is het eenvoudigst: dan werkt alles zonder agent-pc.

## Stappen

1. **Code ophalen**
   ```bash
   git clone https://github.com/JerrelArkes/Vinylhunter.git
   cd Vinylhunter
   npm install
   ```

2. **workers.dev-subdomein kiezen** (eenmalig): in het Cloudflare-dashboard naar *Workers & Pages* en een
   subdomein kiezen als daarom gevraagd wordt. Je app komt op `https://vinylhunter.<subdomein>.workers.dev`.

3. **Wrangler (de Cloudflare-tool) inloggen**
   ```bash
   npx wrangler login
   ```
   Er opent een browser; log in en klik *Allow*.

4. **Installeren**
   ```bash
   npm run setup
   ```
   Het script vraagt achtereenvolgens:
   - een naam voor je app (standaard `vinylhunter`),
   - je Anthropic API-sleutel (leeg laten als je het abonnement of een lokaal model wilt gebruiken),
   - de standaardroute (`api`, `abonnement` of `lokaal`),
   - een wachtwoord voor de app (minimaal 10 tekens),
   - je Discogs-token.

   Het maakt de database, zet de app online en de geheime waarden, en schrijft `agent.env` en de
   sleutelbestanden voor de agent. Aan het eind staat het adres van je app.

5. **Op je telefoon**: open het adres, log in met je wachtwoord en kies in het menu van je browser
   *Toevoegen aan startscherm*. De app vraagt om cameratoegang.

Heb je een andere route dan `api` gekozen, of wil je Discogs vanaf een eigen internetadres laten lopen:
installeer nu de agent, zie [AGENT.md](AGENT.md).

## Gebruiken

- **Camera**: kies bovenin de soort (Vinyl, Pokémon, Keramiek, Zilver, Overig). De app opent in
  *Handmatig*: fotografeer met de ronde knop. In *Auto* maakt hij zelf een foto zodra er iets nieuws stil
  in beeld is. Dubbele foto's van dezelfde plaat worden samengevoegd.
- **Resultaten**: tab onderin. Prijsrange, aantal te koop op Discogs, link naar Discogs. De bovenkant
  van de range wordt aangevuld zodra er geen nieuwe scans wachten.
- **Route wisselen**: tik op de knop bovenin het camerascherm of kies op de resultatenpagina tussen API,
  Abonnement en Lokaal model.
- **Keramiek, zilver, overig**: maak een paar foto's van één stuk (ook de onderkant en merktekens), dan
  "klaar". Opus beoordeelt het stuk; bij interessante stukken volgt een prijscheck met web search.

## Bijwerken

```bash
git pull
npm install
npx wrangler d1 execute <naam> --remote --file migrations/<nieuw bestand>.sql   # alleen als er een nieuwe migratie is
npx wrangler deploy
```

Nieuwe migraties staan in `migrations/`; `schema.sql` bevat altijd het volledige schema voor een verse
installatie.

## Lokaal ontwikkelen

```bash
npx wrangler d1 execute <naam> --local --file schema.sql
npx wrangler dev --test-scheduled        # http://localhost:8787
```

Voor lokale sleutels: maak `.dev.vars` (staat in `.gitignore`) met `ANTHROPIC_API_KEY=…`,
`DISCOGS_TOKEN=…` en `DEV_NO_AUTH=1` (geen wachtwoord lokaal), of draai `npm run secrets:local` als je de
sleutelbestanden al hebt.

## Problemen

| Melding | Oplossing |
|---|---|
| `running scripts is disabled on this system` | Gebruik `npx.cmd` / `npm.cmd` in PowerShell |
| Deploy vraagt om een subdomein | Stap 2: kies een workers.dev-subdomein in het dashboard |
| Scans blijven op "wacht op de agent-pc" staan | Route staat op abonnement/lokaal maar de agent draait niet: zet de route op API of start de agent |
| Prijzen komen traag, "Discogs 429" in de logs | Cloudflare deelt internetadressen met andere sites; de agent (AGENT.md) lost dat op |
| Meerdere Cloudflare-accounts | Zet `"account_id"` in `wrangler.jsonc` (zie `npx wrangler whoami`) |

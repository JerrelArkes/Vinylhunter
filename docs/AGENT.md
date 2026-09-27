# De agent-pc (optioneel)

Een pc die altijd aan staat (thuis of op kantoor) en werk ophaalt bij je app. Alleen uitgaande
verbindingen: je hoeft niets open te zetten in je router of firewall.

## Waarom

1. **Discogs vanaf een eigen internetadres.** Discogs staat 60 opvragingen per minuut toe *per
   internetadres*. Cloudflare deelt zijn uitgaande adressen met duizenden andere sites, waarvan sommige ook
   Discogs bevragen. Zonder agent kan het daardoor op drukke momenten minutenlang duren voor er prijzen
   komen (in een test: Discogs weigerde met "62-68 gebruikt" terwijl de app zelf ~33/min deed). Draait de
   agent, dan doet die alle Discogs-opvragingen vanaf zijn eigen adres. Valt hij 30 s uit, dan neemt de app
   het automatisch weer over.
2. **Claude via je abonnement** (route "abonnement"): herkenning, analyses en prijschecks met
   `claude -p` op je eigen Claude Pro/Max-abonnement, zonder kosten per foto.
3. **Een lokaal model** (route "lokaal"): herkenning van vinyl en Pokémon met Ollama, LM Studio of een
   andere OpenAI-compatibele server. Keramiek, zilver en overig gaan dan via de API (als je een sleutel
   hebt), want die hebben veel naslag en een prijscheck met web search nodig.

## Installeren

Op de agent-pc:

```bash
git clone https://github.com/JerrelArkes/Vinylhunter.git
cd Vinylhunter
npm install
```

Zet in de map (heb je `npm run setup` op deze pc gedraaid, dan staan ze er al):

- `agent.env`: kopie van `agent.env.example`, met minimaal `VINYLHUNTER_URL` (het adres van je app);
- de sleutels, in `agent.env` of als losse bestanden: `DISCOGS_TOKEN` (of `token.env.txt`) en
  `AGENT_KEY` (of `agent-key.txt`, dezelfde waarde als de Worker-secret `AGENT_KEY`).

Draaien op de voorgrond, om te testen:

```bash
npm run agent
```

De eerste regels in de uitvoer (en in `agent.log`) laten zien wat er aan staat:

```
Agent start. Publiek IP: 203.0.113.7, app: https://vinylhunter.jouw-naam.workers.dev
Claude via abonnement: klaar (3 tegelijk, met de login van dit account)
Lokaal model: gemma3:27b op http://localhost:11434/v1
```

Scan een plaat met je telefoon: in de uitvoer verschijnt een regel met artiest, titel en prijs.

## Route "abonnement"

1. Installeer [Claude Code](https://docs.claude.com/en/docs/claude-code) op de agent-pc en log in met
   je abonnement (`claude`, dan `/login`).
2. Staat `claude` niet in het PATH (of draait de agent straks als dienst), zet dan het volledige pad in
   `CLAUDE_BIN` in `agent.env`.
3. Draait de agent als dienst (Windows: als SYSTEM), dan kent hij jouw login niet. Maak dan een token:
   ```bash
   claude setup-token
   ```
   Halverwege toont de browser een code met een `#` erin: die plak je terug in de terminal. **Daarna**
   verschijnt het token (`sk-ant-oat01-…`) in de terminal. Zet alleen dat token in
   `claude-oauth.env.txt` in de projectmap.
4. Zet in de app de route op *Abonnement*.

Gebruik je eigen abonnement voor je eigen scans. Eén abonnement delen om de app voor anderen te laten
draaien mag niet volgens de voorwaarden van Anthropic; wie meedoet, gebruikt de API of een eigen
abonnement.

## Route "lokaal"

1. Installeer een server met een vision-model, bijvoorbeeld:
   - [Ollama](https://ollama.com): `ollama pull gemma3:27b` (of een ander model dat afbeeldingen leest),
     server op `http://localhost:11434/v1`;
   - [LM Studio](https://lmstudio.ai): model laden, *Developer* → server starten, `http://localhost:1234/v1`.
2. Zet in `agent.env`:
   ```
   LOCAL_LLM_URL=http://localhost:11434/v1
   LOCAL_LLM_MODEL=gemma3:27b
   ```
3. Zet in de app de route op *Lokaal model*.

Wat je kunt verwachten (meting op 28 hoesfoto's, RTX 4090): Gemma 4 31B 23/28 goed; Qwen3-VL-8B was snel
(0,9 s per foto) maar gaf 3 verkeerde platen. Vindt Discogs niets met wat het lokale model las, dan doet
de app nog één poging met Claude Opus via de API, als je een API-sleutel hebt. Zonder sleutel blijft het
bij "niet gevonden".

## Altijd laten draaien

**Windows**: in een PowerShell *als administrator*, in de projectmap:

```powershell
$dir = (Get-Location).Path
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$dir\tools\agent-loop.cmd`""
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Vinylhunter agent' -Action $action -Settings $settings -Force `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) `
  -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest)
Start-ScheduledTask -TaskName 'Vinylhunter agent'
```

`ExecutionTimeLimit` 0 is nodig: standaard stopt Windows een taak na 72 uur. `agent-loop.cmd` start de
agent opnieuw als hij stopt, en de agent herstart zelf als de code verandert (na `git pull`). Draait de
taak als SYSTEM, gebruik dan voor het abonnement het token uit `claude setup-token` (zie hierboven).

**macOS / Linux**: laat `npm run agent` draaien met je eigen dienstbeheer (launchd, systemd, pm2) in de
projectmap, met herstart bij stoppen.

Zet de slaapstand van de pc uit (op netstroom).

## Instellingen (agent.env)

Zie `agent.env.example` voor alle opties met uitleg: `VINYLHUNTER_URL`, `CLAUDE_BIN`, `CLAUDE_PARALLEL`,
`LOCAL_LLM_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_KEY`, `LOCAL_PARALLEL`, en de sleutels.

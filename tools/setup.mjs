// Eerste installatie van de app op je eigen Cloudflare-account: `npm run setup`.
// 1. controleert of Wrangler is ingelogd (inloggen doe je zelf: `npx wrangler login`),
// 2. maakt wrangler.jsonc uit wrangler.example.jsonc en een D1-database, zet het schema erin,
// 3. zet de app online en daarna de geheime waarden (wachtwoord, Discogs-token, agentsleutel, API-sleutel),
// 4. schrijft voor de agent en de Marktplaats-scan agent.env en de sleutelbestanden in deze map.
// Opnieuw draaien kan: bestaande database en bestanden worden hergebruikt.
//
// Zonder vragen (bijv. voor testen): SETUP_NAAM, SETUP_WACHTWOORD, SETUP_DISCOGS, SETUP_ANTHROPIC
// ("-" = geen sleutel; een lege variabele bestaat in PowerShell niet) en SETUP_BRON (api|abonnement|lokaal).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const say = s => console.log(s);
let klaar = false;
const stop = s => { klaar = true; console.error(`\n${s}`); rl.close(); process.exit(1); };
// Geen invoer meer mogelijk (bijv. gestart zonder terminal): niet eindeloos wachten.
rl.on('close', () => { if (!klaar) { console.error('\nGeen invoer: draai npm run setup in een terminal, of geef de SETUP_*-variabelen mee.'); process.exit(1); } });

async function vraag(env, tekst, { standaard = '', verplicht = false, min = 0 } = {}) {
  if (process.env[env] !== undefined) return process.env[env] === '-' ? '' : process.env[env];
  for (;;) {
    const a = (await rl.question(`${tekst}${standaard ? ` [${standaard}]` : ''}: `)).trim() || standaard;
    if (verplicht && a.length < Math.max(1, min)) { say(min ? `  Minimaal ${min} tekens.` : '  Dit is verplicht.'); continue; }
    return a;
  }
}

// Via de shell (npx is op Windows een .cmd); alle argumenten komen uit dit script, niet van de gebruiker.
function wrangler(args, { input, stil = false } = {}) {
  const r = spawnSync(`npx wrangler ${args.join(' ')}`, { cwd: root, shell: true, encoding: 'utf8', input, stdio: [input ? 'pipe' : 'inherit', 'pipe', 'pipe'] });
  const out = (r.stdout || '') + (r.stderr || '');
  if (!stil) process.stdout.write(out.split('\n').filter(l => !/^\s*$/.test(l)).slice(-8).map(l => `  ${l}`).join('\n') + '\n');
  return { ok: r.status === 0, out };
}

say('Vinylhunter installeren op je Cloudflare-account\n');

// 1. Ingelogd?
const who = wrangler(['whoami'], { stil: true });
if (!who.ok || /not authenticated|You are not logged in/i.test(who.out)) stop('Wrangler is niet ingelogd. Doe eerst zelf: npx wrangler login   (daarna npm run setup opnieuw)');
say(`Ingelogd: ${who.out.match(/associated with the email (\S+)/)?.[1] ?? 'ok'}`);

// 2. Naam, configuratie en database
const naam = (await vraag('SETUP_NAAM', 'Naam van je app (wordt deel van het adres)', { standaard: 'vinylhunter' })).toLowerCase().replace(/[^a-z0-9-]/g, '-');
const cfgFile = join(root, 'wrangler.jsonc');
let cfg = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : readFileSync(join(root, 'wrangler.example.jsonc'), 'utf8');
cfg = cfg.replace(/"name": "[^"]*"/, `"name": "${naam}"`).replace(/"database_name": "[^"]*"/, `"database_name": "${naam}"`);

let dbId = cfg.match(/"database_id": "([0-9a-f-]{36})"/)?.[1];
if (!dbId) {
  say(`\nDatabase "${naam}" aanmaken…`);
  const list = wrangler(['d1', 'list', '--json'], { stil: true });
  try { dbId = JSON.parse(list.out.slice(list.out.indexOf('['))).find(d => d.name === naam)?.uuid; } catch {}
  if (!dbId) {
    const made = wrangler(['d1', 'create', naam], { stil: true });
    dbId = made.out.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1] || made.out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1];
    if (!dbId) stop(`Database aanmaken mislukt:\n${made.out.slice(-600)}`);
  }
  cfg = cfg.replace(/"database_id": "[^"]*"/, `"database_id": "${dbId}"`);
}
say(`Database: ${naam} (${dbId})`);

// 3. Route zolang je in de app niets kiest
const heeftApi = process.env.SETUP_ANTHROPIC !== undefined ? !!process.env.SETUP_ANTHROPIC : null;
say('\nClaude kan op drie manieren (docs/KOSTEN.md):\n  api        = Claude-API, snel, betaald per foto (sleutel van console.anthropic.com)\n  abonnement = je eigen Claude-abonnement via een agent-pc die aan staat\n  lokaal     = een lokaal model via een agent-pc (alleen vinyl en Pokémon, minder betrouwbaar)');
const anthropic = await vraag('SETUP_ANTHROPIC', 'Anthropic API-sleutel (sk-ant-api…, leeg laten als je die niet hebt)');
const bron = await vraag('SETUP_BRON', 'Standaardroute (api/abonnement/lokaal)', { standaard: anthropic ? 'api' : 'abonnement' });
if (!['api', 'abonnement', 'lokaal'].includes(bron)) stop(`Onbekende route "${bron}".`);
if (bron === 'api' && !anthropic) stop('De route api heeft een Anthropic API-sleutel nodig.');
cfg = cfg.replace(/"DEFAULT_BRON": "[^"]*"/, `"DEFAULT_BRON": "${bron}"`);
writeFileSync(cfgFile, cfg);

say('\nSchema in de database zetten…');
if (!wrangler(['d1', 'execute', naam, '--remote', '--file', 'schema.sql', '--yes']).ok) stop('Schema zetten mislukt (zie hierboven).');

// 4. Online zetten
say('\nApp online zetten…');
const dep = wrangler(['deploy']);
if (!dep.ok) stop('Deploy mislukt (zie hierboven). Eerste keer? Kies in het Cloudflare-dashboard eerst een workers.dev-subdomein (Workers & Pages).');
const url = dep.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];

// 5. Geheime waarden
say('\nGeheime waarden:');
const wachtwoord = await vraag('SETUP_WACHTWOORD', 'Wachtwoord voor de app (minimaal 10 tekens)', { verplicht: true, min: 10 });
const discogs = await vraag('SETUP_DISCOGS', 'Discogs-token (discogs.com/settings/developers → Generate token)', { verplicht: true });
const agentFile = join(root, 'agent-key.txt');
const agentKey = existsSync(agentFile) ? readFileSync(agentFile, 'utf8').trim() : randomBytes(24).toString('hex');
const secrets = { APP_PASSWORD: wachtwoord, DISCOGS_TOKEN: discogs, AGENT_KEY: agentKey, ...(anthropic ? { ANTHROPIC_API_KEY: anthropic } : {}) };
const tmp = join(tmpdir(), `vinylhunter-secrets-${Date.now()}.json`);
writeFileSync(tmp, JSON.stringify(secrets));
let ok;
try { ok = wrangler(['secret', 'bulk', `"${tmp}"`]).ok; } finally { unlinkSync(tmp); }
if (!ok) stop('Geheime waarden zetten mislukt (zie hierboven).');

// 6. Bestanden voor de agent en de Marktplaats-scan (staan in .gitignore)
writeFileSync(agentFile, agentKey);
writeFileSync(join(root, 'token.env.txt'), discogs);
if (anthropic) writeFileSync(join(root, 'claude-token.env.txt'), anthropic);
const envFile = join(root, 'agent.env');
if (!existsSync(envFile)) {
  writeFileSync(envFile, readFileSync(join(root, 'agent.env.example'), 'utf8').replace(/^VINYLHUNTER_URL=.*$/m, `VINYLHUNTER_URL=${url ?? ''}`));
}

klaar = true;
rl.close();
say(`\nKlaar. Je app: ${url ?? '(zie de uitvoer van deploy hierboven)'}`);
say('Open dat adres op je telefoon, log in met je wachtwoord en zet de pagina op je beginscherm.');
if (bron !== 'api') say(`Route "${bron}": start nu de agent op een pc die aan blijft: npm run agent   (docs/AGENT.md)`);
else say('Optioneel: de agent (docs/AGENT.md) geeft Discogs een eigen internetadres; dat voorkomt wachttijden bij drukte.');

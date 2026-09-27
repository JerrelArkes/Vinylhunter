// Claude via het eigen Claude-abonnement in plaats van de API: één `claude -p` (Claude Code zonder scherm)
// per klus, met dezelfde prompts en schema's als de API-route in de Worker (src/recognize.js,
// src/pokemon.js, src/expert.js). Gebruikt door tools/discogs-agent.mjs als de schakelaar in de app op
// "abonnement" staat, en door tools/marktplaats-scan.mjs. Alleen voor eigen gebruik met je eigen
// abonnement: niet één abonnement delen om de app voor anderen te laten draaien.
//
// Gemeten 2026-09-25 (Sonnet 5, 3 testfoto's): 4-12 s en ~6.000 tokens per foto, alle drie goed.
// - `--bare` kan hier niet: die leest alleen een API-sleutel, nooit de abonnementslogin.
// - Zonder `--tools` stuurt Claude Code bij elke beurt al zijn tools mee: 92.000-180.000 tokens per
//   foto. Daarom alleen de nodige tools, geen MCP-servers, geen gebruikersinstellingen, en de foto
//   direct als afbeelding via --input-format stream-json (geen Read-beurt nodig).
// - Een gezette ANTHROPIC_API_KEY gaat in `-p` altijd vóór de abonnementslogin: die halen we weg.
import './env.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SYSTEM as VINYL_SYSTEM, SCHEMA as VINYL_SCHEMA } from '../src/recognize.js';
import { POKEMON_SYSTEM, POKEMON_SCHEMA } from '../src/pokemon.js';
import { EXPERT_KINDS, EXPERT_SCHEMA, PRICE_SCHEMA, PRICE_SYSTEM, analyseText, priceText } from '../src/expert.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Token van `claude setup-token` (maak je zelf; nooit tonen, loggen of committen: *.env.txt staat in .gitignore).
export const TOKEN_FILE = join(root, 'claude-oauth.env.txt');
// Het programma `claude` (Claude Code). Staat het niet in het PATH van de gebruiker die de agent draait
// (bijv. een Windows-dienst als SYSTEM), zet dan CLAUDE_BIN in agent.env.
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
// Neutrale werkmap: geen CLAUDE.md of projectinstellingen die meegestuurd worden. Pas aangemaakt bij de
// eerste klus, zodat een agent zonder abonnementsroute niets op schijf zet.
const WORKDIR = join(tmpdir(), 'vinylhunter-claude');

// Hoe logt claude -p in? Met token (nodig als de agent als dienst/SYSTEM draait, die kent de login van
// de gebruiker niet), anders met de opgeslagen login van het account (bij draaien op de voorgrond).
export function claudeAuth() {
  if (existsSync(TOKEN_FILE)) {
    const raw = readFileSync(TOKEN_FILE, 'utf8');
    // Minimaal 40 tekens: een voorbeeldregel als "sk-ant-oat01-..." is geen token.
    const token = raw.match(/sk-ant-oat[\w-]{30,}/)?.[0];
    // Eigen configmap in de projectmap: SYSTEM schrijft dan niets in zijn eigen profiel op C:.
    if (token) return { ok: true, via: 'token', env: { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: join(root, '.claude-agent') } };
    // Eerste poging 2026-09-25: in het bestand stond de code uit de browser ("…#…"), die je tijdens
    // `claude setup-token` in de terminal plakt. Het token zelf verschijnt daarna in de terminal.
    return { ok: false, reden: raw.includes('#')
      ? 'claude-oauth.env.txt bevat de code uit de browser, niet het token; het token (sk-ant-oat01-…) staat daarna in de terminal'
      : 'claude-oauth.env.txt bevat geen token (verwacht: sk-ant-oat01-…)' };
  }
  const system = /^system$/i.test(userInfo().username) || /systemprofile/i.test(process.env.USERPROFILE || '');
  if (!system) return { ok: true, via: 'login', env: {} };
  return { ok: false, reden: 'claude-oauth.env.txt ontbreekt (maak hem met: claude setup-token)' };
}

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_AGENT_SDK)/.test(k)) delete env[k];
  return { ...env, ...extra, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1' };
}

// Lange systeemprompts (naslag) via een bestand: de Windows-opdrachtregel is beperkt tot 32.767 tekens.
function promptFile(text) {
  mkdirSync(WORKDIR, { recursive: true });
  const f = join(WORKDIR, `prompt-${createHash('sha1').update(text).digest('hex').slice(0, 12)}.txt`);
  if (!existsSync(f)) writeFileSync(f, text);
  return f;
}

class ClaudeFout extends Error {}

function runClaude({ system, schema, images = [], text, model, effort = 'low', tools = [], maxTurns = 3, timeoutMs = 110_000, auth }) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'local',
    '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
    '--system-prompt-file', promptFile(system), '--json-schema', JSON.stringify(schema),
    '--model', model, '--effort', effort, '--max-turns', String(maxTurns),
    '--tools', tools.join(','),
    ...(tools.length ? ['--allowedTools', tools.join(','), '--permission-mode', 'dontAsk'] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd: WORKDIR, env: childEnv(auth.env), windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new ClaudeFout(`time-out na ${timeoutMs / 1000} s`)); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const lines = out.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const result = lines.findLast(o => o.type === 'result');
      if (!result) return reject(new ClaudeFout(`claude stopte zonder resultaat (code ${code}): ${(err || out).slice(-300)}`));
      // Aantal zoekopdrachten (prijscheck): de WebSearch-aanroepen in de antwoorden van het model.
      result.searches = lines.filter(o => o.type === 'assistant')
        .flatMap(o => o.message?.content || []).filter(b => b.type === 'tool_use' && b.name === 'WebSearch').length;
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [
      ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
      { type: 'text', text },
    ] } }) + '\n');
  });
}

// Losse vraag met eigen prompt en schema, voor scripts buiten de agent (tools/marktplaats-pilot.mjs).
// Zelfde aanroep en foutafhandeling als runJob; model/effort/time-out naar keuze.
export async function ask({ system, schema, images = [], text, model = 'claude-opus-5', effort = 'low', timeoutMs = 180_000 }) {
  const auth = claudeAuth();
  if (!auth.ok) throw new ClaudeFout(auth.reden);
  const r = await runClaude({ system, schema, images, text, model, effort, timeoutMs, auth });
  return { output: outcome(r), usage: r.usage, ms: r.duration_ms };
}

// Het gestructureerde antwoord, of een fout met .limit (abonnementslimiet: klus terug en pauzeren) of
// .login (niet ingelogd: klus terug en abonnementsroute uit).
function outcome(r) {
  if (r.is_error || r.subtype !== 'success') {
    const msg = String(r.result || r.subtype || 'onbekende fout');
    const e = new ClaudeFout(msg.slice(0, 200));
    e.login = /not logged in|please run \/login|invalid api key|authenticat/i.test(msg);
    e.limit = !e.login && (r.api_error_status === 429 || /usage limit|rate limit|limit reached|hit your limit/i.test(msg));
    const reset = msg.match(/\|(\d{10})\b/);           // "…limit reached|<unix-tijd>"
    e.pauzeTot = reset ? Number(reset[1]) * 1000 : Date.now() + 15 * 60_000;
    throw e;
  }
  if (!r.structured_output) throw new ClaudeFout('geen gestructureerd antwoord');
  return r.structured_output;
}

export async function runJob(job, auth) {
  const t0 = Date.now();
  let r;
  if (job.type === 'herken') {
    const [system, schema, text] = job.kind === 'pokemon'
      ? [POKEMON_SYSTEM, POKEMON_SCHEMA, 'Welke kaart is dit?'] : [VINYL_SYSTEM, VINYL_SCHEMA, 'Welke plaat is dit?'];
    r = await runClaude({ system, schema, images: job.images, text, model: job.model, auth });
  } else if (job.type === 'analyse') {
    r = await runClaude({
      system: EXPERT_KINDS[job.kind].system, schema: EXPERT_SCHEMA, images: job.images,
      text: analyseText(job.kind, job.images.length, job.silver), model: job.model, effort: job.effort || 'low', auth,
    });
  } else if (job.type === 'prijscheck') {
    r = await runClaude({
      system: PRICE_SYSTEM(job.kind), schema: PRICE_SCHEMA, text: priceText(job.kind, job.analyse, job.silver),
      model: job.model, tools: ['WebSearch'], maxTurns: 8, timeoutMs: 240_000, auth,
    });
  } else {
    throw new ClaudeFout(`onbekende klus ${job.type}`);
  }
  return { result: outcome(r), ms: Date.now() - t0, searches: r.searches, turns: r.num_turns, apiWaarde: r.total_cost_usd };
}

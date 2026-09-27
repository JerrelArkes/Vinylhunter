// Agent voor een pc met een eigen internetadres die altijd aan staat (de "agent-pc").
//
// Waarom: Discogs telt de limiet (60/min) per IP, en Cloudflare deelt uitgaande IP's met andere
// sites die ook Discogs bevragen. Vanaf de Worker kwamen er daardoor 429's terwijl de app zelf ruim
// onder de limiet zat (winkeltest 2026-09-24). Deze agent haalt werk op bij de app, bevraagt Discogs
// vanaf het eigen IP en levert het resultaat in. Alleen uitgaande verbindingen.
//
// Staat de schakelaar in de app op "abonnement" of "lokaal", dan doet hij ook de herkenning:
// - abonnement: met `claude -p` op het eigen Claude-abonnement (tools/claude-cli.mjs), ook analyses en
//   prijschecks van keramiek/zilver/overig;
// - lokaal: met een lokaal model via een OpenAI-compatibele server (tools/local-llm.mjs), alleen herkenning.
//
// Draaien: node tools/discogs-agent.mjs
// Instellingen in agent.env (zie agent.env.example); sleutels in de projectmap (niet in git):
// token.env.txt (Discogs-token), agent-key.txt (AGENT_KEY), voor het abonnement als dienst ook
// claude-oauth.env.txt (van `claude setup-token`).
import './env.mjs';
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { discogsClient, RateLimited, cacheTtl } from '../src/discogs.js';
import { claudeAuth, runJob as runClaudeJob, TOKEN_FILE } from './claude-cli.mjs';
import { localConfig, runLocalJob } from './local-llm.mjs';
import { ENV_FILE } from './env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.VINYLHUNTER_URL) {
  console.error('VINYLHUNTER_URL ontbreekt: zet het adres van je app in agent.env (zie agent.env.example).');
  process.exit(1);
}
const BASE = process.env.VINYLHUNTER_URL.replace(/\/$/, '');
// Eigen IP: Discogs staat 60/min toe, maar meet met een voortschrijdend gemiddelde. Met 55 kwam er
// in de lokale test (samen met 5-6 calls/min van een ander proces op hetzelfde IP) toch een 429.
const PER_MIN = 50;
const BACKOFF_MS = 60_000;          // pauze na een 429
const CACHE_FILE = join(root, 'agent-cache.json');
const LOG_FILE = process.env.AGENT_LOG || join(root, 'agent.log');
const CACHE_MAX = 5000;
const CLAUDE_PARALLEL = Math.max(0, Number(process.env.CLAUDE_PARALLEL ?? 3));
const LOCAL_PARALLEL = Math.max(0, Number(process.env.LOCAL_PARALLEL ?? 1));   // één GPU: één tegelijk
const DISCOGS_AAN = process.env.AGENT_ZONDER_DISCOGS !== '1';

// Sleutel uit de omgeving/agent.env, anders uit het losse bestand in de projectmap.
function secret(name, file) {
  if (process.env[name]) return process.env[name].trim();
  try { return readFileSync(join(root, file), 'utf8').trim(); }
  catch { console.error(`${name} ontbreekt: zet hem in ${file} of in agent.env`); process.exit(1); }
}
const token = secret('DISCOGS_TOKEN', 'token.env.txt');
const agentKey = secret('AGENT_KEY', 'agent-key.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${msg}`;
  console.log(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) renameSync(LOG_FILE, LOG_FILE + '.1');
    appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ---- eigen budget: glijdend venster van 60 s; bij vol even wachten i.p.v. opgeven ----
const stamps = [];
async function budget() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && stamps[0] < now - 60_000) stamps.shift();
    if (stamps.length < PER_MIN) { stamps.push(now); return; }
    await sleep(stamps[0] + 60_000 - now + 50);
  }
}

// ---- cache op schijf (zelfde houdbaarheid als in de Worker) ----
let cache = new Map();
try { cache = new Map(Object.entries(JSON.parse(readFileSync(CACHE_FILE, 'utf8')))); } catch {}
let cacheDirty = false;
const diskCache = {
  async get(path) {
    const e = cache.get(path);
    return e && Date.now() - e.at <= cacheTtl(path) ? e.body : null;
  },
  async put(path, body) {
    cache.delete(path); cache.set(path, { body, at: Date.now() });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);   // oudste eruit
    cacheDirty = true;
  },
};
function saveCache() {
  if (!cacheDirty) return;
  try { writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache))); cacheDirty = false; } catch (e) { log(`cache opslaan mislukt: ${e.message}`); }
}
setInterval(saveCache, 30_000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveCache(); process.exit(0); });

async function api(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': agentKey },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(45_000),
  });
  if (r.status === 401) throw new Error('AGENT_KEY klopt niet met de Worker-secret');
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function runJob(job) {
  const client = discogsClient(token, budget, diskCache);
  const t0 = Date.now();
  try {
    if (job.type === 'lookup') {
      const result = await client.lookup(job.rec);
      await api('/api/agent/done', { type: 'lookup', id: job.id, result });
      log(`#${job.id} ${job.rec.artist} – ${job.rec.title}: ${result.found ? `€${result.low ?? '–'} (${result.forSale} te koop)` : 'niet gevonden'}, ${result.calls} calls, ${result.cached} uit cache, ${Date.now() - t0} ms`);
    } else {
      const result = await client.fillRange(job.masterId);
      await api('/api/agent/done', { type: 'fill', id: job.id, result });
      log(`#${job.id} bovenkant €${result.high ?? '–'} (${result.pressings} persingen), ${result.calls} calls, ${Date.now() - t0} ms`);
    }
  } catch (e) {
    const rateLimited = e instanceof RateLimited;
    await api('/api/agent/done', { type: job.type, id: job.id, attempts: job.attempts, error: e.message || String(e), rateLimited }).catch(() => {});
    if (rateLimited) {
      log(`Discogs 429 bij #${job.id}; ${BACKOFF_MS / 1000} s pauze (de Worker neemt het na 30 s tijdelijk over)`);
      await sleep(BACKOFF_MS);
    } else {
      log(`#${job.id} fout: ${e.message || e}`);
    }
  }
}

// Eigen publiek IP loggen: zo is te controleren dat Discogs het adres van deze pc ziet.
try { log(`Agent start. Publiek IP: ${(await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) })).text()).trim()}, app: ${BASE}`); }
catch { log(`Agent start. App: ${BASE}`); }

// Nieuwe code in de projectmap (git pull of een wijziging) of een nieuw abonnementstoken: na de lopende
// klussen netjes stoppen, agent-loop.cmd start hem na 10 s opnieuw. Zonder dit bleef de agent (taak als
// SYSTEM) de oude code draaien tot iemand hem als beheerder herstartte (2026-09-24).
const WATCH = [fileURLToPath(import.meta.url), join(root, 'tools', 'claude-cli.mjs'), join(root, 'tools', 'local-llm.mjs'), TOKEN_FILE, ENV_FILE,
  ...['discogs.js', 'recognize.js', 'pokemon.js', 'expert.js', 'naslag.js', 'claude.js'].map(f => join(root, 'src', f))];
const codeStamp = () => WATCH.map(f => { try { return statSync(f).mtimeMs; } catch { return 0; } }).join();
const startStamp = codeStamp();
let stopping = false, inFlight = 0;
setInterval(() => {
  if (!stopping && codeStamp() !== startStamp) { stopping = true; log('Nieuwe code of token gezien, agent stopt na de lopende klussen'); }
}, 5000);

// ---- Herkenning/analyse via het abonnement of een lokaal model (schakelaar in de app) ----
// De klus zegt met `engine` welke route ("abonnement" of "lokaal"); oude Workers sturen geen engine.
let claudePauseUntil = 0, claudeOff = false;
const local = localConfig();
const samenvatting = (job, r) => (job.type === 'prijscheck' ? `€${r.value_low}-${r.value_high}`
  : job.type === 'analyse' ? `${r.status} ${r.object || ''} ${r.maker || ''} €${r.value_low}-${r.value_high}`
  : `${r.status} ${r.artist || r.name || ''} – ${r.title || r.number || ''}`);

async function claudeLoop(n, auth) {
  let failures = 0;
  while (!stopping && !(claudeOff && !local.ok)) {
    if (claudePauseUntil > Date.now()) { await sleep(Math.min(30_000, claudePauseUntil - Date.now())); continue; }
    let job;
    try {
      job = await api('/api/agent/claude/next?wait=25');
      failures = 0;
    } catch (e) {
      // Oude Worker (route bestaat nog niet) of geen verbinding: rustig blijven proberen.
      failures++;
      if (failures === 1 || failures % 20 === 0) log(`claude ${n}: ophalen mislukt (${failures}x): ${e.message}`);
      await sleep(Math.min(60_000, 2000 * failures));
      continue;
    }
    if (job.type === 'none') continue;
    inFlight++;                            // een geclaimde klus altijd afmaken, ook als we gaan stoppen
    const engine = job.engine === 'lokaal' ? 'lokaal' : 'abonnement';
    const base = { type: job.type, id: job.id, kind: job.kind, model: job.model, attempts: job.attempts, engine };
    try {
      if (engine === 'lokaal') {
        // Niet ingesteld: als fout teruggeven (telt als poging), zodat de scan niet eindeloos blijft wachten.
        const out = await runLocalJob(job, local);
        await api('/api/agent/claude/done', { ...base, model: out.model, result: out.result, ms: out.ms });
        log(`#${job.id} ${job.type} ${job.kind} lokaal (${out.model}): ${samenvatting(job, out.result)}, ${out.ms} ms`);
        continue;
      }
      if (!auth.ok || claudeOff) throw Object.assign(new Error(`abonnement niet beschikbaar op deze pc: ${auth.reden || 'claude -p niet ingelogd'}`), { geenLogin: true });
      const out = await runClaudeJob(job, auth);
      await api('/api/agent/claude/done', { ...base, result: out.result, ms: out.ms, searches: out.searches, silver: job.silver ?? null });
      log(`#${job.id} ${job.type} ${job.kind} via abonnement (${job.model}, ${out.turns} beurten): ${samenvatting(job, out.result)}, ${out.ms} ms`);
    } catch (e) {
      if (e.limit) {
        claudePauseUntil = e.pauzeTot;
        log(`Abonnementslimiet bereikt, pauze tot ${new Date(e.pauzeTot).toLocaleTimeString('nl-NL')}: ${e.message}`);
      } else if (e.login) {
        claudeOff = true;
        log(`claude -p is niet ingelogd (${e.message}): abonnementsroute uit tot de volgende herstart`);
      } else {
        log(`#${job.id} ${job.type} via ${engine} mislukt: ${e.message}`);
      }
      const back = e.limit ? { limit: true, pauzeTot: e.pauzeTot } : e.login ? { terug: true } : { error: e.message || String(e) };
      await api('/api/agent/claude/done', { ...base, ...back }).catch(() => {});
    } finally {
      inFlight--;
    }
  }
}

const auth = CLAUDE_PARALLEL > 0 ? claudeAuth() : { ok: false, reden: 'CLAUDE_PARALLEL=0' };
log(auth.ok
  ? `Claude via abonnement: klaar (${CLAUDE_PARALLEL} tegelijk, ${auth.via === 'token' ? 'met token' : 'met de login van dit account'})`
  : `Claude via abonnement: uit (${auth.reden})`);
log(local.ok ? `Lokaal model: ${local.model} op ${local.url}` : `Lokaal model: uit (${local.reden})`);
const loops = Math.max(auth.ok ? CLAUDE_PARALLEL : 0, local.ok ? LOCAL_PARALLEL : 0);
for (let i = 0; i < loops; i++) claudeLoop(i, auth);

// ---- Discogs ----
let failures = 0;
while (DISCOGS_AAN && !stopping) {
  try {
    const job = await api('/api/agent/next?wait=25');
    failures = 0;
    if (job.type !== 'none') await runJob(job);
  } catch (e) {
    failures++;
    log(`Verbinding met Vinylhunter mislukt (${failures}x): ${e.message}`);
    await sleep(Math.min(60_000, 2000 * failures));
  }
}
while (!stopping) await sleep(1000);      // alleen Claude (AGENT_ZONDER_DISCOGS): wachten op nieuwe code
while (inFlight > 0) await sleep(500);    // lopende Claude-klussen afmaken
log('Agent stopt voor een herstart');
if (DISCOGS_AAN) saveCache();
process.exit(0);

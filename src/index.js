import { recognize } from './recognize.js';
import { discogsClient, RateLimited, cacheTtl, recKey } from './discogs.js';
import { recognizePokemon, pokemonKey, pokemonLabel, tcgdexClient, tcgdexTtl } from './pokemon.js';
import { EXPERT_KINDS, analyse, priceCheck, needsCheck, meltValue } from './expert.js';
import { silverPerGram } from './metal.js';
import { costUsd } from './claude.js';
import { sameSleeve, TWIN_WINDOW_MS } from './twin.js';
import { isAuthed, authConfigured, login } from './auth.js';
import camHtml from './pages/cam.html';
import resultsHtml from './pages/results.html';
import loginHtml from './pages/login.html';

const DISCOGS_PER_MIN = 55;      // Discogs staat 60 toe; kleine marge voor proefscripts
const STALE_MS = 120_000;        // verwerking die langer "bezig" is, is vastgelopen
const DUPLICATE_WINDOW_MS = 12 * 3600_000;
const CRON_BATCH = 4;            // max platen per cron-run (free plan: 50 externe fetches)
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 60_000;       // pauze na een 429 van Discogs
const EARLY_DUP_MS = 30 * 60_000; // zelfde artiest+titel binnen 30 min = dubbele foto
const AGENT_TIMEOUT_MS = 30_000;  // agent-pc zo lang niet gezien = Worker doet Discogs zelf

// Standen (kolom kind). Vinyl en Pokémon: één foto -> herkennen -> opzoeken (Discogs / TCGdex).
// Keramiek en zilver: 1-4 foto's van één stuk -> analyse door Opus -> eventueel prijscheck (cron).
const KINDS = ['vinyl', 'pokemon', ...Object.keys(EXPERT_KINDS)];   // + keramiek, zilver, overig
const isExpert = kind => Object.hasOwn(EXPERT_KINDS, kind);
// Voor SQL: de soorten met foto-analyse (meerdere foto's, 30 dagen bewaard, prijscheck).
const EXPERT_SQL = `(${Object.keys(EXPERT_KINDS).map(k => `'${k}'`).join(', ')})`;
const MAX_PHOTO = 1_900_000;      // base64-tekens per foto; D1 staat max 2 MB per rij toe
const EXPERT_STALE_MS = 5 * 60_000; // een prijscheck met web search mag langer duren dan 2 min
const PRICE_CHECKS_PER_CRON = 2;  // ~30-50 s per stuk; de cron mag 15 min
const PHOTO_KEEP_MS = 30 * 86400_000; // foto's van keramiek/zilver: 30 dagen, om analyses na te kijken

// Bron voor het model, de schakelaar in de app (app_state 'claude_bron'):
// - 'api' (0): de Worker roept de Claude-API aan (snel, betaald per foto).
// - 'abonnement' (1): de agent-pc doet het met `claude -p` op het eigen Claude-abonnement van de
//   gebruiker (tools/claude-cli.mjs). Scans wachten dan met status 'wacht_op_pc'.
// - 'lokaal' (2): de agent-pc herkent vinyl en Pokémon met een lokaal model (Ollama, LM Studio of een
//   andere OpenAI-compatibele server, tools/local-llm.mjs). Keramiek, zilver en overig kunnen niet lokaal
//   (analyse + prijscheck met web search): die gaan dan via de API, als er een sleutel is.
// Zolang er niets gekozen is geldt var DEFAULT_BRON (standaard 'api': een nieuwe installatie heeft nog
// geen agent-pc, en dan zouden scans eindeloos wachten).
const CLAUDE_AGENT_TIMEOUT_MS = 60_000;   // agent zo lang niet gezien = route via de pc niet bereikbaar
const BRONNEN = ['api', 'abonnement', 'lokaal'];
const bronVan = (v, env) => BRONNEN[v] ?? (BRONNEN.includes(env?.DEFAULT_BRON) ? env.DEFAULT_BRON : 'api');
// Gaat dit soort klus in deze bron naar de agent-pc? Lokaal alleen herkenning, analyses via de API.
const viaPc = (bron, expert) => bron === 'abonnement' || (bron === 'lokaal' && !expert);

async function claudeBron(env) {
  const row = await env.DB.prepare("SELECT v FROM app_state WHERE k = 'claude_bron'").first();
  return bronVan(row?.v, env);
}

async function pcStatus(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM app_state WHERE k IN ('claude_bron', 'agent_claude_seen', 'claude_pauze_tot')").all();
  const s = Object.fromEntries(results.map(r => [r.k, r.v]));
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM scans WHERE status = 'wacht_op_pc'").first();
  return {
    bron: bronVan(s.claude_bron, env),
    apiSleutel: !!env.ANTHROPIC_API_KEY,
    pcKlaar: (s.agent_claude_seen ?? 0) > Date.now() - CLAUDE_AGENT_TIMEOUT_MS,
    pauzeTot: s.claude_pauze_tot > Date.now() ? s.claude_pauze_tot : null,
    wacht: n,
  };
}

const noindex = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' };
const html = body => new Response(body, { headers: { ...noindex, 'Content-Type': 'text/html; charset=utf-8' } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...noindex, 'Content-Type': 'application/json' } });

// Pagina's: / = camera, /resultaten = overzicht. Alles onder /api/ is de API.
const PAGES = { '/': camHtml, '/resultaten': resultsHtml };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/(.)\/+$/, '$1');

    if (path === '/robots.txt') return new Response('User-agent: *\nDisallow:\n', { headers: noindex });
    if (PAGES[path]) {
      if (!(await isAuthed(request, env))) return html(loginHtml);
      return html(PAGES[path]);
    }

    if (path === '/api/login' && request.method === 'POST') return login(request, env, json);

    // De agent op de agent-pc heeft een eigen sleutel (AGENT_KEY), geen wachtwoordsessie.
    if (path.startsWith('/api/agent/') && request.method === 'POST') {
      try {
        return await agentApi(path, request, env, ctx);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    if (path.startsWith('/api/')) {
      if (!authConfigured(env)) return json({ error: 'Er is nog geen login ingesteld' }, 503);
      if (!(await isAuthed(request, env))) return json({ error: 'Niet ingelogd' }, 401);
      try {
        return await api(path, request, env, ctx, url);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }
    return new Response('Niet gevonden', { status: 404, headers: noindex });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};

async function api(path, request, env, ctx, url) {
  if (path === '/api/scan' && request.method === 'POST') {
    const { image, thumb, source, feat, taken_at, kind: k, extra } = await request.json();
    const kind = KINDS.includes(k) ? k : 'vinyl';
    const extras = isExpert(kind) && Array.isArray(extra) ? extra.slice(0, 3) : [];
    if (!image || image.length > MAX_PHOTO || extras.some(x => typeof x !== 'string' || !x || x.length > MAX_PHOTO)) {
      return json({ error: 'Geen of te grote foto' }, 400);
    }
    const featOk = feat && Array.isArray(feat.s) && feat.s.length === 768 && Array.isArray(feat.h) && feat.h.length === 108;
    // Vangnet tegen kosten als het wachtwoord rondgaat: elke scan is een Claude-aanroep.
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM scans WHERE created_at > ?').bind(Date.now() - 86400_000).first();
    if (n >= Number(env.DAILY_SCAN_CAP || 300)) return json({ error: `Daglimiet van ${env.DAILY_SCAN_CAP || 300} scans bereikt` }, 429);
    // Met extra foto's eerst 'uploading': de cron mag het stuk pas oppakken als alle foto's erin staan.
    const row = await env.DB.prepare(
      'INSERT INTO scans (created_at, source, status, image, thumb, feat, taken_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).bind(Date.now(), source || 'onbekend', extras.length ? 'uploading' : 'queued', image, thumb || null,
      featOk ? JSON.stringify(feat) : null, Number.isFinite(taken_at) ? taken_at : null, kind).first();
    if (extras.length) {
      await env.DB.batch([
        ...extras.map((data, i) => env.DB.prepare('INSERT INTO scan_images (scan_id, idx, data) VALUES (?, ?, ?)').bind(row.id, i + 1, data)),
        env.DB.prepare("UPDATE scans SET status = 'queued' WHERE id = ?").bind(row.id),
      ]);
    }
    // De foto's zitten al in het geheugen: meegeven scheelt ze uit D1 terug te lezen (free plan: 10 ms CPU).
    ctx.waitUntil(processScan(env, row.id, isExpert(kind) ? [image, ...extras] : null));
    return json({ id: row.id });
  }

  if ((path === '/api/recent' || path === '/api/list') && request.method === 'GET') {
    // Elke poll van een open scherm neemt één wachtende plaat mee, zodat de wachtrij op volle
    // Discogs-snelheid leegloopt in plaats van alleen via de cron (4 per minuut).
    ctx.waitUntil(drainOne(env));
    const since = Number(url.searchParams.get('since')) || 0;
    const limit = path === '/api/recent' ? 10 : 500;
    const { results } = await env.DB.prepare(
      `SELECT id, created_at, source, status, kind, artist, title, other_side, catno, label, format,
              discogs_url, discogs_title, discogs_step, pressings, price_low, price_high, for_sale,
              duplicate_of, error, range_status, details, thumb IS NOT NULL AS has_thumb,
              (SELECT COUNT(*) FROM scans d WHERE d.duplicate_of = scans.id) AS seen_again,
              (SELECT COUNT(*) FROM scan_images i WHERE i.scan_id = scans.id) + (image IS NOT NULL AND kind IN ${EXPERT_SQL}) AS photos
       FROM scans WHERE created_at >= ? AND cleared_at IS NULL ORDER BY id DESC LIMIT ?`
    ).bind(since, limit).all();
    return json({ scans: results, now: Date.now(), ...(await pcStatus(env)) });
  }

  // Schakelaar API / abonnement / lokaal (resultatenpagina en camera). Wat op de pc wachtte maar in de
  // nieuwe bron via de API gaat, gaat meteen via de API.
  if (path === '/api/instellingen') {
    if (request.method === 'POST') {
      const { bron } = await request.json();
      if (!BRONNEN.includes(bron)) return json({ error: 'Onbekende bron' }, 400);
      if (bron === 'api' && !env.ANTHROPIC_API_KEY) return json({ error: 'Geen ANTHROPIC_API_KEY ingesteld: de API-route kan niet' }, 400);
      await env.DB.prepare("INSERT OR REPLACE INTO app_state (k, v) VALUES ('claude_bron', ?)").bind(BRONNEN.indexOf(bron)).run();
      const naarApi = bron === 'api' ? '' : bron === 'lokaal' ? ` AND kind IN ${EXPERT_SQL}` : null;
      if (naarApi !== null) {
        const { results } = await env.DB.prepare(`UPDATE scans SET status = 'queued' WHERE status = 'wacht_op_pc'${naarApi} RETURNING id`).all();
        ctx.waitUntil((async () => { for (const { id } of results.slice(0, 4)) await processScan(env, id); })());
      }
    }
    return json(await pcStatus(env));
  }

  // Foto van keramiek/zilver om na te kijken (0 = eerste foto, 1-3 = details). Als base64-tekst: omzetten
  // naar bytes kost bij 0,5 MB te veel CPU op het free plan; de pagina maakt er een data-URL van.
  const ph = path.match(/^\/api\/photo\/(\d+)\/([0-3])$/);
  if (ph) {
    const [id, idx] = [Number(ph[1]), Number(ph[2])];
    const row = idx === 0
      ? await env.DB.prepare(`SELECT image AS data FROM scans WHERE id = ? AND kind IN ${EXPERT_SQL}`).bind(id).first()
      : await env.DB.prepare('SELECT data FROM scan_images WHERE scan_id = ? AND idx = ?').bind(id, idx).first();
    if (!row?.data) return new Response('Foto niet (meer) bewaard', { status: 404, headers: noindex });
    return new Response(row.data, { headers: { ...noindex, 'Content-Type': 'text/plain' } });
  }

  // "Leegmaken": verbergen, niet wissen. Terugzetten: UPDATE scans SET cleared_at = NULL WHERE cleared_at = <tijdstip>.
  if (path === '/api/clear' && request.method === 'POST') {
    const now = Date.now();
    const r = await env.DB.prepare('UPDATE scans SET cleared_at = ? WHERE cleared_at IS NULL').bind(now).run();
    return json({ cleared: r.meta.changes, cleared_at: now });
  }

  const m = path.match(/^\/api\/thumb\/(\d+)$/);
  if (m) {
    const row = await env.DB.prepare('SELECT thumb FROM scans WHERE id = ?').bind(Number(m[1])).first();
    if (!row?.thumb) return new Response(null, { status: 404 });
    const bytes = Uint8Array.from(atob(row.thumb), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Robots-Tag': 'noindex' } });
  }

  return json({ error: 'Onbekende API-route' }, 404);
}

// ---------- verwerking ----------

// images: de foto's van keramiek/zilver als ze nog in het geheugen zitten (direct na de upload).
async function processScan(env, id, images = null) {
  const row = await env.DB.prepare('SELECT kind FROM scans WHERE id = ?').bind(id).first();
  if (!row) return;
  if (isExpert(row.kind)) return expertStep(env, id, images);
  // Tweede ronde alleen als het opzoeken niets vond en het terugvalmodel de foto nog mag lezen.
  for (let round = 0; round < 2; round++) {
    await recognizeStep(env, id);
    if ((await lookupStep(env, id, row.kind)) !== 'requeued') return;
  }
}

// Herkenning met MODEL (Sonnet 5); vindt Discogs daarmee niets, dan nog één keer met FALLBACK_MODEL
// (Opus 5). Gemeten 2026-09-24: Sonnet 27/28 voor $0,0046 per foto, Opus 28/28 voor $0,0116.
const canFallBack = (env, model) => !!env.FALLBACK_MODEL && model !== env.FALLBACK_MODEL;

// ---------- dubbele foto's vóór de herkenning (src/twin.js) ----------
// Veilig: de tweede foto wacht op de vorige en wordt alleen overgeslagen als die gevonden is.
const TWIN_WAIT_MS = 12_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Het origineel als deze foto een tweede van dezelfde hoes is én dat origineel gevonden is; anders null.
async function twinOriginal(env, id, row) {
  if (row.source !== 'auto' || !row.feat || !row.taken_at) return null;
  const { results } = await env.DB.prepare(
    `SELECT id, feat, duplicate_of FROM scans WHERE id < ? AND id >= ? AND source = 'auto' AND feat IS NOT NULL
       AND taken_at BETWEEN ? AND ? AND cleared_at IS NULL AND kind = ? ORDER BY id DESC`
  ).bind(id, id - 5, row.taken_at - TWIN_WINDOW_MS, row.taken_at, row.kind).all();
  const f = JSON.parse(row.feat);
  const twin = results.find(c => sameSleeve(f, JSON.parse(c.feat)));
  if (!twin) return null;
  const origId = twin.duplicate_of ?? twin.id;
  // Via het abonnement duurt de herkenning van het origineel langer: dan langer wachten (waitUntil: max 30 s).
  const waitMs = viaPc(await claudeBron(env), false) ? 25_000 : TWIN_WAIT_MS;
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; await sleep(500)) {
    const o = await env.DB.prepare('SELECT status, duplicate_of FROM scans WHERE id = ?').bind(origId).first();
    if (o?.status === 'done') return o.duplicate_of ?? origId;
    if (!o || ['unclear', 'no_record', 'not_found', 'error'].includes(o.status)) return null;   // zelf lezen
  }
  return null;                               // duurde te lang: zelf lezen
}

// Per stand: welke herkenning, welke sleutel voor "zelfde kort geleden al gescand", welke kolommen.
const RECOGNIZERS = {
  vinyl: {
    run: recognize,
    key: r => recKey(r.artist, r.title),
    cols: r => [r.artist, r.title, r.other_side, r.catno, r.label, r.format],
    details: () => null,
  },
  pokemon: {
    run: recognizePokemon,
    key: pokemonKey,
    cols: r => [r.name_en || r.name, pokemonLabel(r), null, null, null, null],
    details: ({ usage, model, ...rec }) => JSON.stringify({ rec }),
  },
};

async function recognizeStep(env, id) {
  const row = await env.DB.prepare(
    "UPDATE scans SET status = 'recognizing', claimed_at = ? WHERE id = ? AND status = 'queued' RETURNING image, attempts, model, source, feat, taken_at, kind"
  ).bind(Date.now(), id).first();
  if (!row) return;
  // Alleen in de eerste ronde; de tweede poging (Opus) is er juist omdat de eerste lezing niets vond.
  if (!row.model) {
    const orig = await twinOriginal(env, id, row);
    if (orig) {
      await env.DB.prepare(
        "UPDATE scans SET status = 'done', claimed_at = NULL, image = NULL, duplicate_of = ?, twin = 1, recognized_at = ?, done_at = ? WHERE id = ?"
      ).bind(orig, Date.now(), Date.now(), id).run();
      return;
    }
  }
  // Abonnement of lokaal: de agent-pc haalt hem op (/api/agent/claude/next) en levert in via applyRecognition.
  // Uitzondering: de tweede ronde in de lokale route gaat via de Claude-API; die ronde is er juist voor
  // een sterker model (lokaal nog eens proberen gaf dezelfde uitkomst, en liep eindeloos rond).
  const bron = await claudeBron(env);
  const tweedeRonde = !!row.model && row.model === env.FALLBACK_MODEL;
  if (viaPc(bron, false) && !(bron === 'lokaal' && tweedeRonde)) {
    await env.DB.prepare("UPDATE scans SET status = 'wacht_op_pc', claimed_at = NULL WHERE id = ?").bind(id).run();
    return;
  }
  const model = row.model || env.MODEL;
  try {
    const r = await (RECOGNIZERS[row.kind] || RECOGNIZERS.vinyl).run(env.ANTHROPIC_API_KEY, model, row.image);
    await applyRecognition(env, id, row.kind, model, r);
  } catch (e) {
    await fail(env, id, row.attempts, 'queued', `Herkenning: ${e.message || e}`);
  }
}

// Herkenning verwerken, van de API (recognizeStep) of van de agent-pc (abonnement).
async function applyRecognition(env, id, kindName, model, r) {
  const kind = RECOGNIZERS[kindName] || RECOGNIZERS.vinyl;
  let status = r.status === 'ok' ? 'recognized' : r.status === 'unclear' ? 'unclear' : 'no_record';
  const key = status === 'recognized' ? kind.key(r) : null;
  // Dubbele foto (zelfde artiest+titel of kaart kort geleden): meteen verbergen, niet opzoeken.
  let dupOf = null;
  if (key) {
    const orig = await env.DB.prepare(
      `SELECT id FROM scans WHERE rec_key = ? AND id < ? AND duplicate_of IS NULL AND cleared_at IS NULL
         AND status IN ('recognized', 'looking_up', 'done') AND created_at > ? ORDER BY id LIMIT 1`
    ).bind(key, id, Date.now() - EARLY_DUP_MS).first();
    if (orig) { dupOf = orig.id; status = 'done'; }
  }
  // De foto blijft alleen bewaard zolang het terugvalmodel hem nog nodig kan hebben.
  const keepImage = status === 'recognized' && canFallBack(env, model) ? 1 : 0;
  await env.DB.prepare(
    `UPDATE scans SET status = ?, claimed_at = NULL, image = CASE WHEN ? THEN image ELSE NULL END, model = ?,
       recognized_at = ?, rec_key = ?, duplicate_of = ?,
       done_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
       artist = ?, title = ?, other_side = ?, catno = ?, label = ?, format = ?, details = ? WHERE id = ?`
  ).bind(status, keepImage, model, Date.now(), key, dupOf, dupOf, Date.now(),
    ...kind.cols(r).map(v => v || null), kind.details(r), id).run();
}

// Na een herkenning van de agent-pc: opzoeken (Pokémon hier, vinyl hier of via de Discogs-agent) en
// bij "niet gevonden" de tweede ronde met het terugvalmodel.
async function afterRecognition(env, id, kind) {
  if ((await lookupStep(env, id, kind)) === 'requeued') await processScan(env, id);
}

// ---------- keramiek en zilver (src/expert.js) ----------

async function expertStep(env, id, images) {
  const row = await env.DB.prepare(
    "UPDATE scans SET status = 'recognizing', claimed_at = ? WHERE id = ? AND status = 'queued' RETURNING kind, image, attempts"
  ).bind(Date.now(), id).first();
  if (!row) return;
  if (viaPc(await claudeBron(env), true)) {
    await env.DB.prepare("UPDATE scans SET status = 'wacht_op_pc', claimed_at = NULL WHERE id = ?").bind(id).run();
    return;
  }
  if (!images) {
    const { results } = await env.DB.prepare('SELECT data FROM scan_images WHERE scan_id = ? ORDER BY idx').bind(id).all();
    images = [row.image, ...results.map(r => r.data)];
  }
  const model = env.EXPERT_MODEL || 'claude-opus-5';
  try {
    const silver = row.kind === 'zilver' ? await silverPerGram(env) : null;
    const t0 = Date.now();
    const { usage, model: _m, ...a } = await analyse(env.ANTHROPIC_API_KEY, row.kind, images, { model, effort: env.EXPERT_EFFORT || 'low', silver });
    await applyAnalysis(env, id, row.kind, model, a, { silver, ms: Date.now() - t0, cost: costUsd(model, usage), bron: 'api' });
  } catch (e) {
    await fail(env, id, row.attempts, 'queued', `Analyse: ${e.message || e}`);
  }
}

// Analyse verwerken, van de API (expertStep) of van de agent-pc. cost: dollars (API) of 0 (abonnement).
async function applyAnalysis(env, id, kind, model, a, { silver = null, ms = null, cost = 0, bron = 'api' } = {}) {
  const status = a.status === 'ok' ? 'done' : a.status === 'unclear' ? 'unclear' : 'no_record';
  const check = status === 'done' && env.PRIJSCHECK !== 'uit' && needsCheck(kind, a);
  const details = { analyse: a, silver, melt: meltValue(a, silver), ms, bron, cost: { analyse: cost } };
  const now = Date.now();
  // De foto's blijven (30 dagen, zie sweep): bij keramiek en zilver wil je de analyse kunnen nakijken.
  await env.DB.prepare(
    `UPDATE scans SET status = ?, claimed_at = NULL, model = ?, recognized_at = ?, done_at = ?, artist = ?, title = ?,
       price_low = ?, price_high = ?, details = ?, range_status = ? WHERE id = ?`
  ).bind(status, model, now, now, a.maker || null, a.object || null,
    status === 'done' ? a.value_low : null, status === 'done' ? a.value_high : null,
    JSON.stringify(details), check ? 'pending' : null, id).run();
}

// Prijscheck met web search: alleen vanuit de cron (sweep), want hij duurt 25-50 s.
async function priceCheckStep(env, id) {
  const row = await env.DB.prepare(
    `UPDATE scans SET range_status = 'filling', claimed_at = ? WHERE id = ? AND range_status = 'pending' AND kind IN ${EXPERT_SQL} RETURNING kind, details`
  ).bind(Date.now(), id).first();
  if (!row) return;
  const details = JSON.parse(row.details || '{}');
  const model = env.EXPERT_MODEL || 'claude-opus-5';
  try {
    const silver = row.kind === 'zilver' ? (await silverPerGram(env)) ?? details.silver : null;
    const t0 = Date.now();
    const { usage, model: _m, ...p } = await priceCheck(env.ANTHROPIC_API_KEY, row.kind, details.analyse, { model, silver });
    await applyPriceCheck(env, id, details, p, { ms: Date.now() - t0, searches: usage?.server_tool_use?.web_search_requests ?? 0, cost: costUsd(model, usage) });
  } catch (e) {
    await priceCheckFailed(env, id, details, e.message || e);
  }
}

// Prijscheck verwerken, van de API (priceCheckStep) of van de agent-pc.
async function applyPriceCheck(env, id, details, p, { ms = null, searches = null, cost = 0 } = {}) {
  details.prijscheck = { ...p, ms, searches };
  details.cost = { ...details.cost, prijscheck: cost };
  await env.DB.prepare('UPDATE scans SET range_status = NULL, claimed_at = NULL, range_at = ?, price_low = ?, price_high = ?, details = ? WHERE id = ?')
    .bind(Date.now(), p.value_low, p.value_high, JSON.stringify(details), id).run();
}

// Niet eindeloos opnieuw: de eerste schatting blijft staan.
async function priceCheckFailed(env, id, details, message) {
  details.prijscheck = { error: String(message).slice(0, 200) };
  await env.DB.prepare("UPDATE scans SET range_status = 'error', claimed_at = NULL, details = ? WHERE id = ?")
    .bind(JSON.stringify(details), id).run();
}

// Eén cachetabel voor Discogs en TCGdex (sleutels van TCGdex beginnen met 'tcgdex:'), elk met eigen houdbaarheid.
const ttlOf = path => (path.startsWith('tcgdex:') ? tcgdexTtl(path) : cacheTtl(path));

function d1Cache(env) {
  return {
    async get(path) {
      const row = await env.DB.prepare('SELECT body, fetched_at FROM discogs_cache WHERE path = ?').bind(path).first();
      if (!row || Date.now() - row.fetched_at > ttlOf(path)) return null;
      return JSON.parse(row.body);
    },
    async put(path, body) {
      await env.DB.prepare('INSERT OR REPLACE INTO discogs_cache (path, body, fetched_at) VALUES (?, ?, ?)')
        .bind(path, JSON.stringify(body), Date.now()).run();
    },
  };
}

// Max DISCOGS_PER_MIN calls per minuut over alle verwerkers heen (tabel discogs_calls), en niets
// zolang een 429-pauze loopt. Tellen en reserveren in één statement: met los tellen en daarna
// invoegen gingen gelijktijdige verwerkers samen over het budget heen.
function discogsBudget(env) {
  return async () => {
    const now = Date.now();
    const blocked = await env.DB.prepare("SELECT v FROM app_state WHERE k = 'discogs_blocked_until'").first();
    if (blocked?.v > now) throw new RateLimited('pauze na 429');
    const r = await env.DB.prepare(
      'INSERT INTO discogs_calls (ts) SELECT ? WHERE (SELECT COUNT(*) FROM discogs_calls WHERE ts > ?) < ?'
    ).bind(now, now - 60_000, DISCOGS_PER_MIN).run();
    if (!r.meta.changes) throw new RateLimited('eigen budget op');
  };
}

// Discogs weigerde (429): iedereen 60 s laten wachten. Discogs telt per IP en Cloudflare deelt
// IP's met andere sites; blijven proberen hield de weigering in stand (winkeltest 2026-09-24 07:57).
async function noteRateLimit(env, e) {
  if (!e.fromDiscogs) return;
  await env.DB.prepare("INSERT OR REPLACE INTO app_state (k, v) VALUES ('discogs_blocked_until', ?)").bind(Date.now() + BACKOFF_MS).run();
}

// ---------- Discogs-stappen: claimen, resultaat verwerken ----------
// De Worker voert ze zelf uit (lookupStep/fillStep), tenzij de agent op de agent-pc actief is:
// die haalt ze op via /api/agent/next en levert in via /api/agent/done (eigen IP, zie
// tools/discogs-agent.mjs). Dezelfde claim- en verwerkfuncties voor beide.

// Alleen vinyl: Pokémon zoekt de Worker zelf op (TCGdex), keramiek en zilver hebben geen opzoekstap.
const claimLookup = (env, id) => env.DB.prepare(
  "UPDATE scans SET status = 'looking_up', claimed_at = ? WHERE id = ? AND status = 'recognized' AND kind = 'vinyl' RETURNING id, artist, title, catno, attempts"
).bind(Date.now(), id).first();

const claimFill = (env, id) => env.DB.prepare(
  "UPDATE scans SET range_status = 'filling', claimed_at = ? WHERE id = ? AND range_status = 'pending' AND kind = 'vinyl' RETURNING id, discogs_key"
).bind(Date.now(), id).first();

// Geeft 'requeued' terug als de scan opnieuw gelezen moet worden door het terugvalmodel.
// details: JSON voor de kolom details (Pokémon: herkenning + gevonden kaart); null = laten staan.
async function applyLookup(env, id, d, details = null) {
  if (!d.found) {
    const row = await env.DB.prepare('SELECT model, image IS NOT NULL AS has_image FROM scans WHERE id = ?').bind(id).first();
    // Tweede ronde met het sterkere model: via de API, of via het abonnement op de agent-pc.
    if (row?.has_image && canFallBack(env, row.model || env.MODEL) && (env.ANTHROPIC_API_KEY || (await claudeBron(env)) === 'abonnement')) {
      await env.DB.prepare(
        "UPDATE scans SET status = 'queued', model = ?, claimed_at = NULL, discogs_calls = COALESCE(discogs_calls, 0) + ? WHERE id = ?"
      ).bind(env.FALLBACK_MODEL, d.calls, id).run();
      return 'requeued';
    }
    await env.DB.prepare(
      "UPDATE scans SET status = 'not_found', claimed_at = NULL, image = NULL, done_at = ?, discogs_calls = COALESCE(discogs_calls, 0) + ? WHERE id = ?"
    ).bind(Date.now(), d.calls, id).run();
    return 'not_found';
  }
  const dup = await env.DB.prepare(
    "SELECT id FROM scans WHERE discogs_key = ? AND status = 'done' AND duplicate_of IS NULL AND cleared_at IS NULL AND created_at > ? AND id != ? ORDER BY id LIMIT 1"
  ).bind(d.key, Date.now() - DUPLICATE_WINDOW_MS, id).first();
  // Dubbele scans worden verborgen; alleen het origineel krijgt de bovenkant aangevuld.
  const rangeStatus = d.rangePending && !dup ? 'pending' : null;
  await env.DB.prepare(
    `UPDATE scans SET status = 'done', claimed_at = NULL, image = NULL, done_at = ?, discogs_calls = COALESCE(discogs_calls, 0) + ?,
       discogs_key = ?, discogs_url = ?, discogs_title = ?,
       discogs_step = ?, pressings = ?, price_low = ?, price_high = ?, for_sale = ?, duplicate_of = ?, range_status = ?,
       details = COALESCE(?, details) WHERE id = ?`
  ).bind(Date.now(), d.calls, d.key, d.url, d.title, d.step, d.pressings, d.low, d.high, d.forSale, dup?.id ?? null, rangeStatus, details, id).run();
  return 'done';
}

async function lookupFailed(env, id, attempts, message, rateLimited, source = 'Discogs') {
  // Budget op / 429: geen fout, later nog eens. Anders telt het als poging.
  if (rateLimited) {
    await env.DB.prepare("UPDATE scans SET status = 'recognized', claimed_at = NULL WHERE id = ?").bind(id).run();
    return;
  }
  await fail(env, id, attempts, 'recognized', `${source}: ${message}`);
}

async function applyFill(env, id, r) {
  await env.DB.prepare(
    `UPDATE scans SET range_status = NULL, claimed_at = NULL, range_at = ?, pressings = ?, price_high = ?,
       discogs_calls = COALESCE(discogs_calls, 0) + ? WHERE id = ?`
  ).bind(Date.now(), r.pressings, r.high, r.calls, id).run();
}

async function fillFailed(env, id, rateLimited) {
  // Budget op: later nog eens. Andere fout: niet eindeloos opnieuw, bovenkant blijft leeg.
  await env.DB.prepare('UPDATE scans SET range_status = ?, claimed_at = NULL WHERE id = ?').bind(rateLimited ? 'pending' : 'error', id).run();
}

const masterIdOf = key => key?.match(/^master:(\d+)$/)?.[1];

async function agentActive(env) {
  const row = await env.DB.prepare("SELECT v FROM app_state WHERE k = 'agent_seen'").first();
  return row?.v > Date.now() - AGENT_TIMEOUT_MS;
}

async function lookupStep(env, id, kind = 'vinyl') {
  if (kind === 'pokemon') return pokemonLookupStep(env, id);
  if (await agentActive(env)) return;        // de agent-pc pakt hem binnen ~1 s op
  const row = await claimLookup(env, id);
  if (!row) return;
  try {
    return await applyLookup(env, id, await discogsClient(env.DISCOGS_TOKEN, discogsBudget(env), d1Cache(env)).lookup(row));
  } catch (e) {
    if (e instanceof RateLimited) await noteRateLimit(env, e);
    await lookupFailed(env, id, row.attempts, e.message || String(e), e instanceof RateLimited);
  }
}

// Pokémon: TCGdex vanuit de Worker (geen sleutel, geen harde limiet; Cloudflare's gedeelde IP's zijn
// hier geen probleem zoals bij Discogs). Niet gevonden -> terugvalmodel, net als bij vinyl.
async function pokemonLookupStep(env, id) {
  const row = await env.DB.prepare(
    "UPDATE scans SET status = 'looking_up', claimed_at = ? WHERE id = ? AND status = 'recognized' AND kind = 'pokemon' RETURNING details, attempts"
  ).bind(Date.now(), id).first();
  if (!row) return;
  try {
    const rec = JSON.parse(row.details || '{}').rec || {};
    const d = await tcgdexClient(d1Cache(env)).lookup(rec);
    return await applyLookup(env, id, d, d.found ? JSON.stringify({ rec, card: d.details }) : null);
  } catch (e) {
    await lookupFailed(env, id, row.attempts, e.message || String(e), false, 'TCGdex');
  }
}

// Stap 2: bovenkant van de range aanvullen (versies + top-N prijzen).
async function fillStep(env, id) {
  if (await agentActive(env)) return;
  const row = await claimFill(env, id);
  if (!row) return;
  const masterId = masterIdOf(row.discogs_key);
  if (!masterId) {
    await env.DB.prepare('UPDATE scans SET range_status = NULL, claimed_at = NULL WHERE id = ?').bind(id).run();
    return;
  }
  try {
    await applyFill(env, id, await discogsClient(env.DISCOGS_TOKEN, discogsBudget(env), d1Cache(env)).fillRange(masterId));
  } catch (e) {
    if (e instanceof RateLimited) await noteRateLimit(env, e);
    await fillFailed(env, id, e instanceof RateLimited);
  }
}

// Volgende klus: nieuwe scans gaan voor; pas als die op zijn een bovenkant aanvullen (nieuwste
// eerst, die plaat heb je waarschijnlijk nog in handen).
async function nextJob(env) {
  const next = await env.DB.prepare("SELECT id FROM scans WHERE status = 'recognized' AND kind = 'vinyl' ORDER BY id LIMIT 1").first();
  if (next) return { type: 'lookup', id: next.id };
  const fill = await env.DB.prepare("SELECT id FROM scans WHERE range_status = 'pending' AND kind = 'vinyl' AND cleared_at IS NULL ORDER BY id DESC LIMIT 1").first();
  if (fill) return { type: 'fill', id: fill.id };
  return null;
}

async function drainOne(env) {
  const job = await nextJob(env);
  if (job?.type === 'lookup') await lookupStep(env, job.id);
  else if (job?.type === 'fill') await fillStep(env, job.id);
}

// ---------- agent op de agent-pc ----------

async function agentApi(path, request, env, ctx) {
  if (!env.AGENT_KEY || request.headers.get('x-agent-key') !== env.AGENT_KEY) return json({ error: 'Onbekende agent' }, 401);
  // Claude via het abonnement: eigen routes en eigen hartslag ('agent_claude_seen'). Die mag de Discogs-
  // hartslag niet zetten, anders slaat de Worker Discogs over terwijl niemand het doet.
  if (path.startsWith('/api/agent/claude/')) return agentClaudeApi(path, request, env, ctx);
  await env.DB.prepare("INSERT OR REPLACE INTO app_state (k, v) VALUES ('agent_seen', ?)").bind(Date.now()).run();

  if (path === '/api/agent/next') {
    // Long-poll: tot `wait` s (max 25) wachten op werk en meteen antwoorden zodra er iets is.
    // Elke seconde pollen zou ~86.000 requests/dag zijn (free plan: 100.000); zo ~3.500 in rust.
    const wait = Math.min(25, Number(new URL(request.url).searchParams.get('wait')) || 0);
    const deadline = Date.now() + wait * 1000;
    do {
      const job = await nextJob(env);
      if (job?.type === 'lookup') {
        const row = await claimLookup(env, job.id);
        if (row) return json({ type: 'lookup', id: row.id, attempts: row.attempts, rec: { artist: row.artist, title: row.title, catno: row.catno } });
        continue;                            // net door een ander geclaimd: meteen opnieuw kijken
      }
      if (job?.type === 'fill') {
        const row = await claimFill(env, job.id);
        if (row && masterIdOf(row.discogs_key)) return json({ type: 'fill', id: row.id, masterId: masterIdOf(row.discogs_key) });
        if (row) await env.DB.prepare('UPDATE scans SET range_status = NULL, claimed_at = NULL WHERE id = ?').bind(row.id).run();
        continue;
      }
      if (Date.now() < deadline) await new Promise(r => setTimeout(r, 1000));
    } while (Date.now() < deadline);
    return json({ type: 'none' });
  }

  if (path === '/api/agent/done') {
    const b = await request.json();
    if (b.type === 'lookup') {
      if (b.error) await lookupFailed(env, b.id, b.attempts ?? 0, b.error, !!b.rateLimited);
      // Niet gevonden: meteen het terugvalmodel laten lezen, niet wachten op de cron.
      else if ((await applyLookup(env, b.id, b.result)) === 'requeued') ctx.waitUntil(processScan(env, b.id));
    } else if (b.type === 'fill') {
      if (b.error) await fillFailed(env, b.id, !!b.rateLimited);
      else await applyFill(env, b.id, b.result);
    }
    return json({ ok: true });
  }

  return json({ error: 'Onbekende agent-route' }, 404);
}

// ---------- Via de agent-pc: abonnement (tools/claude-cli.mjs) of lokaal model (tools/local-llm.mjs) ----------

// Volgende klus: eerst herkenningen en analyses (oudste eerst), dan prijschecks (nieuwste eerst).
// Lokaal: alleen herkenningen (analyses en prijschecks gaan dan via de API, zie viaPc).
async function nextClaudeJob(env, bron) {
  for (;;) {
    const next = await env.DB.prepare("SELECT id FROM scans WHERE status = 'wacht_op_pc' ORDER BY id LIMIT 1").first();
    if (!next) break;
    const row = await env.DB.prepare(
      "UPDATE scans SET status = 'recognizing', claimed_at = ? WHERE id = ? AND status = 'wacht_op_pc' RETURNING id, kind, image, model, attempts"
    ).bind(Date.now(), next.id).first();
    if (!row) continue;                  // net door een andere werker geclaimd
    if (isExpert(row.kind) && !viaPc(bron, true)) {
      // Bleef staan van vóór een wissel naar lokaal: via de API.
      await env.DB.prepare("UPDATE scans SET status = 'queued', claimed_at = NULL WHERE id = ?").bind(row.id).run();
      continue;
    }
    if (isExpert(row.kind)) {
      const { results } = await env.DB.prepare('SELECT data FROM scan_images WHERE scan_id = ? ORDER BY idx').bind(row.id).all();
      return {
        type: 'analyse', id: row.id, kind: row.kind, attempts: row.attempts,
        model: env.EXPERT_MODEL || 'claude-opus-5', effort: env.EXPERT_EFFORT || 'low',
        images: [row.image, ...results.map(r => r.data)], silver: row.kind === 'zilver' ? await silverPerGram(env) : null,
      };
    }
    return { type: 'herken', id: row.id, kind: row.kind, attempts: row.attempts, model: row.model || env.MODEL, images: [row.image] };
  }
  if (env.PRIJSCHECK === 'uit' || !viaPc(bron, true)) return null;
  const pc = await env.DB.prepare(
    `SELECT id FROM scans WHERE range_status = 'pending' AND kind IN ${EXPERT_SQL} AND cleared_at IS NULL ORDER BY id DESC LIMIT 1`
  ).first();
  if (!pc) return null;
  const row = await env.DB.prepare(
    "UPDATE scans SET range_status = 'filling', claimed_at = ? WHERE id = ? AND range_status = 'pending' RETURNING id, kind, details"
  ).bind(Date.now(), pc.id).first();
  if (!row) return null;
  const details = JSON.parse(row.details || '{}');
  return {
    type: 'prijscheck', id: row.id, kind: row.kind, model: env.EXPERT_MODEL || 'claude-opus-5', analyse: details.analyse,
    silver: row.kind === 'zilver' ? (await silverPerGram(env)) ?? details.silver : null,
  };
}

async function agentClaudeApi(path, request, env, ctx) {
  await env.DB.prepare("INSERT OR REPLACE INTO app_state (k, v) VALUES ('agent_claude_seen', ?)").bind(Date.now()).run();

  if (path === '/api/agent/claude/next') {
    // Long-poll zoals /api/agent/next. Staat de schakelaar op API, dan krijgt de pc niets. De klus zegt
    // met `engine` of de pc hem met claude -p of met het lokale model moet doen.
    const wait = Math.min(25, Number(new URL(request.url).searchParams.get('wait')) || 0);
    const deadline = Date.now() + wait * 1000;
    do {
      const bron = await claudeBron(env);
      if (bron !== 'api') {
        const job = await nextClaudeJob(env, bron);
        if (job) return json({ ...job, engine: bron });
      }
      if (Date.now() < deadline) await sleep(1000);
    } while (Date.now() < deadline);
    return json({ type: 'none' });
  }

  if (path === '/api/agent/claude/done') {
    const b = await request.json();
    // Klus terug zonder dat het als poging telt: limiet van het abonnement bereikt (dan ook iedereen even
    // pauzeren) of de pc bleek niet ingelogd (terug; de pc stopt dan zelf met ophalen).
    if (b.limit || b.terug) {
      await env.DB.batch([
        b.type === 'prijscheck'
          ? env.DB.prepare("UPDATE scans SET range_status = 'pending', claimed_at = NULL WHERE id = ?").bind(b.id)
          : env.DB.prepare("UPDATE scans SET status = 'wacht_op_pc', claimed_at = NULL WHERE id = ?").bind(b.id),
        ...(b.limit ? [env.DB.prepare("INSERT OR REPLACE INTO app_state (k, v) VALUES ('claude_pauze_tot', ?)").bind(Number(b.pauzeTot) || Date.now() + 15 * 60_000)] : []),
      ]);
      return json({ ok: true });
    }
    if (b.type === 'herken') {
      if (b.error) await fail(env, b.id, b.attempts ?? 0, 'queued', `Herkenning (${b.engine || 'abonnement'}): ${b.error}`);
      else {
        await applyRecognition(env, b.id, b.kind, b.model, b.result);
        ctx.waitUntil(afterRecognition(env, b.id, b.kind));
      }
    } else if (b.type === 'analyse') {
      if (b.error) await fail(env, b.id, b.attempts ?? 0, 'queued', `Analyse (abonnement): ${b.error}`);
      else await applyAnalysis(env, b.id, b.kind, b.model, b.result, { silver: b.silver ?? null, ms: b.ms ?? null, cost: 0, bron: 'abonnement' });
    } else if (b.type === 'prijscheck') {
      const row = await env.DB.prepare('SELECT details FROM scans WHERE id = ?').bind(b.id).first();
      const details = JSON.parse(row?.details || '{}');
      if (b.error) await priceCheckFailed(env, b.id, details, `abonnement: ${b.error}`);
      else await applyPriceCheck(env, b.id, details, b.result, { ms: b.ms ?? null, searches: b.searches ?? null, cost: 0 });
    }
    return json({ ok: true });
  }

  return json({ error: 'Onbekende agent-route' }, 404);
}

async function fail(env, id, attempts, retryStatus, message) {
  const next = attempts + 1 >= MAX_ATTEMPTS ? 'error' : retryStatus;
  await env.DB.prepare('UPDATE scans SET status = ?, claimed_at = NULL, attempts = attempts + 1, error = ? WHERE id = ?')
    .bind(next, message.slice(0, 300), id).run();
}

async function sweep(env) {
  const now = Date.now();
  const bron = await claudeBron(env);
  // Wat nog op de pc wachtte maar in deze bron via de API gaat, gewoon via de API.
  if (bron === 'api') await env.DB.prepare("UPDATE scans SET status = 'queued' WHERE status = 'wacht_op_pc'").run();
  if (bron === 'lokaal') await env.DB.prepare(`UPDATE scans SET status = 'queued' WHERE status = 'wacht_op_pc' AND kind IN ${EXPERT_SQL}`).run();
  await env.DB.batch([
    env.DB.prepare("UPDATE scans SET status = 'queued', claimed_at = NULL WHERE status = 'recognizing' AND claimed_at < ?").bind(now - STALE_MS),
    env.DB.prepare("UPDATE scans SET status = 'recognized', claimed_at = NULL WHERE status = 'looking_up' AND claimed_at < ?").bind(now - STALE_MS),
    env.DB.prepare("UPDATE scans SET range_status = 'pending', claimed_at = NULL WHERE range_status = 'filling' AND kind = 'vinyl' AND claimed_at < ?").bind(now - STALE_MS),
    env.DB.prepare(`UPDATE scans SET range_status = 'pending', claimed_at = NULL WHERE range_status = 'filling' AND kind IN ${EXPERT_SQL} AND claimed_at < ?`).bind(now - EXPERT_STALE_MS),
    // Upload met extra foto's die halverwege stopte: dan maar met wat er is.
    env.DB.prepare("UPDATE scans SET status = 'queued' WHERE status = 'uploading' AND created_at < ?").bind(now - STALE_MS),
    env.DB.prepare('DELETE FROM discogs_calls WHERE ts < ?').bind(now - STALE_MS),
    env.DB.prepare('DELETE FROM discogs_cache WHERE fetched_at < ?').bind(now - 30 * 86400_000),
    // Foto's van keramiek, zilver en overig na 30 dagen weg; de thumbnail en de analyse blijven.
    env.DB.prepare(`UPDATE scans SET image = NULL WHERE kind IN ${EXPERT_SQL} AND image IS NOT NULL AND created_at < ? AND status NOT IN ('uploading', 'queued', 'recognizing')`).bind(now - PHOTO_KEEP_MS),
    env.DB.prepare('DELETE FROM scan_images WHERE scan_id IN (SELECT id FROM scans WHERE created_at < ?)').bind(now - PHOTO_KEEP_MS),
  ]);
  const { results } = await env.DB.prepare(
    "SELECT id FROM scans WHERE status IN ('queued', 'recognized') ORDER BY id LIMIT ?"
  ).bind(CRON_BATCH).all();
  for (const { id } of results) await processScan(env, id);
  // Als er geen nieuwe scans lagen: ook zonder open scherm een paar bovenkanten aanvullen.
  if (!results.length) for (let i = 0; i < 3; i++) await drainOne(env);
  // Prijschecks van keramiek en zilver: alleen hier, want ze duren langer dan de 30 s van waitUntil.
  // Via het abonnement doet de agent-pc ze; lokaal kan dat niet, dan via de API.
  if (env.PRIJSCHECK !== 'uit' && !viaPc(bron, true) && env.ANTHROPIC_API_KEY) {
    const { results: checks } = await env.DB.prepare(
      `SELECT id FROM scans WHERE range_status = 'pending' AND kind IN ${EXPERT_SQL} AND cleared_at IS NULL ORDER BY id DESC LIMIT ?`
    ).bind(PRICE_CHECKS_PER_CRON).all();
    for (const { id } of checks) await priceCheckStep(env, id);
  }
}

// Marktplaats-scan: nieuwe vinyl-partijen van de afgelopen uren ophalen via Apify, per partij de foto's
// laten beoordelen door Claude, leesbare titels opzoeken op Discogs, en een HTML-overzicht met koopadvies.
// Draait op je eigen pc; los van de app. Uitleg: docs/MARKTPLAATS.md.
//
//   node tools/marktplaats-scan.mjs alles       # alle stappen hieronder achter elkaar
//   node tools/marktplaats-scan.mjs zoek        # Apify: nieuwste advertenties, filter vinyl-partijen
//   node tools/marktplaats-scan.mjs details     # Apify: volledige advertentie (alle foto's, plaatsingstijd)
//   node tools/marktplaats-scan.mjs beoordeel   # Claude kijkt naar de foto's (hervatbaar)
//   node tools/marktplaats-scan.mjs discogs     # leesbare titels opzoeken (max 50 calls/min)
//   node tools/marktplaats-scan.mjs advies      # Claude: eindadvies met de Discogs-prijzen erbij
//   node tools/marktplaats-scan.mjs html        # marktplaats/partijradar.html
//
// Opties: --max 30 (aantal partijen dat beoordeeld wordt, nieuwste eerst), --uren 24 (hoe ver terug),
// --claude api|abonnement (standaard api als er een ANTHROPIC_API_KEY is), --opnieuw (resultaten van een
// vorige run in marktplaats/ weggooien).
//
// Sleutels (agent.env of losse bestanden, zie agent.env.example): APIFY_TOKEN, DISCOGS_TOKEN, en voor
// --claude api ANTHROPIC_API_KEY. Met --claude abonnement gebruikt het je eigen Claude-login (`claude -p`).
//
// Waarom Apify en niet rechtstreeks: Marktplaats blokkeert een pc die veel pagina's achter elkaar opvraagt
// (in een proef na een paar honderd verzoeken: 403 op alle advertentiepagina's). Marktplaats verbiedt
// automatisch uitlezen in zijn voorwaarden; gebruik dit alleen voor jezelf en op kleine schaal.
import './env.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { discogsClient, RateLimited, cacheTtl } from '../src/discogs.js';
import { ask as askAbonnement } from './claude-cli.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'marktplaats');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
if (args.includes('--opnieuw')) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const file = name => join(dir, name);
const load = (name, fallback) => existsSync(file(name)) ? JSON.parse(readFileSync(file(name), 'utf8')) : fallback;
const save = (name, data) => writeFileSync(file(name), JSON.stringify(data, null, 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sleutel uit de omgeving/agent.env, anders uit het losse bestand in de projectmap.
function secret(name, fileName, pattern) {
  let v = process.env[name];
  if (!v) try { v = readFileSync(join(root, fileName), 'utf8'); } catch {}
  v = pattern ? v?.match(pattern)?.[0] : v?.trim();
  if (!v) { console.error(`${name} ontbreekt: zet hem in agent.env of in ${fileName}`); process.exit(1); }
  return v;
}

const MAX_LOTS = Number(opt('max', 30));
const HOURS = Number(opt('uren', 24));
const MODEL = opt('model', 'claude-opus-5');
const MAX_PHOTOS = 12;
const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || (existsSync(join(root, 'claude-token.env.txt')) && /sk-ant-api/.test(readFileSync(join(root, 'claude-token.env.txt'), 'utf8'))));
const ROUTE = opt('claude', hasApiKey ? 'api' : 'abonnement');

// Vinyl-subcategorieën onder "Cd's en Dvd's"; het categoriefilter van Marktplaats laat ook dvd's en
// cd's door (gemeten 2026-09-27), dus we filteren zelf op categorie-ID.
const VINYL = new Set([1682, 1372, 3248, 1373, 2719, 1374, 1375, 2721, 1376, 1762, 1377, 1378, 1763, 3249, 1379, 1382, 1383, 1380, 1384]);
// Opkopers en winkels die collecties zoeken, geen aanbod.
const BUYER = /\b(gezocht|gevraagd|inkoop|wij kopen|ik koop|kopen wij|te koop gevraagd|opkoper|verkopen\?|overnemen|contact ons|maak een afspraak)\b/i;
// Partij in de titel: een woord voor een verzameling, een aantal met eenheid, of een meervoud. Alleen de
// titel: in de beschrijving noemen ook losse platen vaak "singles" of "lp's" (1323 kandidaten i.p.v. ~290).
const LOT_TITLE = /\b(partij|partijen|collectie|kollektie|verzameling|kavel|bulk|doos|dozen|krat|lot van|pakket|diverse|verschillende|allerlei)\b|\b\d{1,4}\s*(x\s*)?(lp|lps|lp'?s|elpees|platen|singles|singeltjes|stuks|st\.?|45'?s|vinyl)\b|\b(lp'?s|lps|elpees|langspeelplaten|singles|singeltjes|grammofoonplaten|platen)\b/i;
// Zoekwoorden per Apify-zoekopdracht: per woord kom je verder terug in de tijd dan de hele categorie.
const QUERIES = (opt('zoekwoorden', 'partij,collectie,verzameling,lp\'s,platen,singles,elpees,vinyl')).split(',');
const PER_QUERY = Number(opt('per-zoekwoord', 300));

async function apify(input, label) {
  const token = secret('APIFY_TOKEN', 'apify-token.txt');
  const url = `https://api.apify.com/v2/acts/sian.agency~marktplaats-scraper/run-sync-get-dataset-items?token=${token}&timeout=290`;
  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error(`Apify ${label}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const items = await r.json();
  console.log(`Apify ${label}: ${items.length} rijen in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return items;
}

// Claude via de API (SDK) of via het eigen abonnement (claude -p). Zelfde prompt en schema.
let anthropicClient;
async function claudeJson({ system, schema, images = [], text, effort = 'low' }) {
  if (ROUTE === 'abonnement') {
    const r = await askAbonnement({ system, schema, images, text, model: MODEL, effort, timeoutMs: 300_000 });
    return { output: r.output, usage: r.usage };
  }
  anthropicClient ??= new Anthropic({ apiKey: secret('ANTHROPIC_API_KEY', 'claude-token.env.txt', /sk-ant-api[\w-]+/), maxRetries: 2 });
  const r = await anthropicClient.messages.create({
    model: MODEL, max_tokens: 8000, system,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: [
      ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
      { type: 'text', text },
    ] }],
  });
  if (r.stop_reason === 'refusal') throw new Error('geweigerd');
  return { output: JSON.parse(r.content.find(b => b.type === 'text').text), usage: r.usage };
}

const priceText = x => x.priceType === 'FIXED' ? `€${x.price}` : x.priceType === 'MIN_BID' ? `bieden vanaf €${x.price}`
  : ({ FAST_BID: 'bieden', SEE_DESCRIPTION: 'zie omschrijving', NOTK: 'n.o.t.k.', RESERVED: 'gereserveerd', FREE: 'gratis' })[x.priceType] ?? (x.priceText || x.priceType || 'onbekend');
// Foto-URL's komen als sjabloon ("…$_#.jpg"): # = formaat. 85 ≈ 140 KB (voor Claude), 82 ≈ 7 KB (thumbnail).
const size = (u, s) => u.replace(/\$_(#|\d+)(\.jpg)?$/i, `$_${s}.jpg`).replace(/^\/\//, 'https://');
const idNum = id => Number(String(id).replace(/\D/g, ''));

const step = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || 'alles';
const STEPS = ['zoek', 'details', 'beoordeel', 'discogs', 'advies', 'html'];
if (step !== 'alles' && !STEPS.includes(step)) { console.error(`Onbekende stap "${step}". Kies uit: alles, ${STEPS.join(', ')}`); process.exit(1); }
const run = s => step === 'alles' || step === s;
if (run('beoordeel') || run('advies')) console.log(`Claude via ${ROUTE === 'api' ? 'de API' : 'je abonnement (claude -p)'}, model ${MODEL}`);

if (run('zoek')) {
  const seen = new Map();
  for (const q of QUERIES) {
    const rows = await apify({ operation: 'search', site: 'marktplaats.nl', query: q, category: 'cd-s-en-dvd-s', sort: 'newest', postedSince: 'yesterday', maxResults: PER_QUERY }, `zoeken "${q}"`);
    for (const x of rows) if (!seen.has(x.itemId)) seen.set(x.itemId, x);
  }
  const items = [...seen.values()];
  const vinyl = items.filter(x => VINYL.has(Number(x.categoryId)));
  const offers = vinyl.filter(x => !BUYER.test(`${x.listingTitle} ${x.descriptionText ?? ''}`));
  // Advertentienummers lopen op met de plaatsingstijd: hoogste nummer = nieuwste.
  const lots = offers.filter(x => LOT_TITLE.test(x.listingTitle)).sort((a, b) => idNum(b.itemId) - idNum(a.itemId));
  save('kandidaten.json', lots);
  console.log(`Gevonden ${items.length}, vinyl ${vinyl.length}, aanbod ${offers.length}, partijen ${lots.length}. Kosten zoeken ≈ $${(items.length * 0.0009).toFixed(2)}`);
}

if (run('details')) {
  const lots = load('kandidaten.json', []).slice(0, MAX_LOTS);
  if (!lots.length) { console.error('Geen kandidaten: draai eerst de stap "zoek".'); process.exit(1); }
  const rows = await apify({ operation: 'detail', site: 'marktplaats.nl', listingUrls: lots.map(x => ({ url: x.url })), maxResults: lots.length + 5 }, `details van ${lots.length} partijen`);
  const since = Date.now() - HOURS * 3600_000;
  const fresh = rows.map(x => ({
    itemId: x.itemId, listingTitle: x.listingTitle, url: x.url, since: x.postedAt, views: x.viewCount,
    priceText: priceText(x), price: x.price, city: x.city, delivery: x.delivery,
    descriptionText: x.descriptionText || '',
    imageUrls: (x.imageUrls || []).map(u => size(u, 85)), thumbUrls: (x.imageUrls || []).map(u => size(u, 82)),
  })).filter(x => !x.since || Date.parse(x.since) >= since);
  save('fresh.json', fresh);
  console.log(`${rows.length} advertenties opgehaald (de rest is al weg), ${fresh.length} geplaatst in de afgelopen ${HOURS} uur. Kosten ≈ $${(rows.length * 0.0025).toFixed(2)}`);
}

// ---- beoordeling ----

const ASSESS_SYSTEM = `Je beoordeelt Marktplaats-advertenties met partijen vinyl (LP's, singles) voor een opkoper die kringloopvondsten doorverkoopt. Je krijgt de titel, de beschrijving, de vraagprijs en alle foto's.

Doel: bepalen of het de moeite is om de hele partij te kopen.

- Lees elke hoes, rug en label die je op de foto's kunt lezen. Neem artiest en titel letterlijk over zoals ze er staan; niet gokken. Noteer ook wat in de beschrijving genoemd wordt, maar markeer de bron.
- Schat het aantal platen (uit tekst of foto's) en de genre-mix.
- Let op wat de waarde bepaalt: originele persingen uit de jaren 60-80, rock/jazz/soul/prog/psych/punk/wave, Nederbeat, zeldzame labels, eerste persingen, colored/picture discs, box sets, en de staat (schimmel, waterschade, krassen, ontbrekende hoezen). Veel schlager, easy listening, klassiek uit boekenclubs, verzamelalbums (K-tel, Arcade) en Reader's Digest-boxen zijn doorgaans weinig waard.
- Zie je maar een paar platen, zeg dat en beoordeel wat je ziet; extrapoleer voorzichtig.
- Wees nuchter: de meeste partijen zijn niet interessant.`;

const ASSESS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['estimated_count', 'visible_share', 'genres', 'condition', 'titles', 'highlights', 'concerns'],
  properties: {
    estimated_count: { type: 'string', description: 'bijv. "ca. 120 LP\'s" of "onbekend"' },
    visible_share: { type: 'string', description: 'hoeveel van de partij je echt kunt zien, bijv. "6 hoezen leesbaar van ~120"' },
    genres: { type: 'string' },
    condition: { type: 'string' },
    titles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['artist', 'title', 'source', 'note'],
      properties: { artist: { type: 'string' }, title: { type: 'string' }, source: { type: 'string', enum: ['foto', 'beschrijving'] }, note: { type: 'string' } } } },
    highlights: { type: 'string', description: 'wat de partij interessant kan maken' },
    concerns: { type: 'string', description: 'wat ertegen pleit' },
  },
};

// Foto's van de fotoserver van Marktplaats (die blokkeert niet, de advertentiepagina's wel).
async function imageData(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok || !/^image\/jpeg/.test(r.headers.get('content-type') || '')) return null;
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

const text = x => (x.descriptionText || x.description || '').slice(0, 4000);
const priceLabel = x => x.priceText || (x.price ? `€${x.price}` : x.priceType || 'onbekend');
const photos = x => (x.imageUrls?.length ? x.imageUrls : [x.imageUrl].filter(Boolean));

if (run('beoordeel')) {
  const details = load('fresh.json', []);
  const out = load('assess.json', {});
  let n = 0;
  for (const x of details) {
    if (out[x.itemId]) continue;
    const imgs = (await Promise.all(photos(x).slice(0, MAX_PHOTOS).map(u => imageData(u).catch(() => null)))).filter(Boolean);
    const t0 = Date.now();
    try {
      const { output: body, usage } = await claudeJson({
        system: ASSESS_SYSTEM, schema: ASSESS_SCHEMA, effort: 'medium', images: imgs,
        text: `Titel: ${x.listingTitle}\nVraagprijs: ${priceLabel(x)}\nPlaats: ${x.city ?? ''}\nBeschrijving:\n${text(x)}`,
      });
      out[x.itemId] = { ...body, photos_sent: imgs.length, ms: Date.now() - t0, usage };
      save('assess.json', out);
      n++;
      console.log(`${n}. ${x.listingTitle.slice(0, 60)}: ${imgs.length} foto's, ${body.titles.length} titels, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (e) {
      console.log(`FOUT bij ${x.itemId} ${x.listingTitle}: ${e.message}`);
    }
  }
  const all = Object.values(out);
  const inTok = all.reduce((s, a) => s + (a.usage?.input_tokens ?? 0), 0), outTok = all.reduce((s, a) => s + (a.usage?.output_tokens ?? 0), 0);
  console.log(`Klaar: ${all.length} beoordeeld. Tokens in ${inTok}, uit ${outTok}${ROUTE === 'api' ? ` ≈ $${(inTok * 5e-6 + outTok * 25e-6).toFixed(2)} (Opus-tarief)` : ' (abonnement)'}`);
}

// ---- Discogs ----

if (run('discogs')) {
  const assess = load('assess.json', {});
  const out = load('discogs.json', {});
  const cache = new Map(Object.entries(load('discogs-cache.json', {})));
  const stamps = [];
  const budget = async () => {
    for (;;) {
      const now = Date.now();
      while (stamps.length && stamps[0] < now - 60_000) stamps.shift();
      if (stamps.length < 50) { stamps.push(now); return; }
      await sleep(stamps[0] + 60_050 - now);
    }
  };
  const diskCache = {
    async get(p) { const e = cache.get(p); return e && Date.now() - e.at <= cacheTtl(p) ? e.body : null; },
    async put(p, body) { cache.set(p, { body, at: Date.now() }); },
  };
  const client = discogsClient(secret('DISCOGS_TOKEN', 'token.env.txt'), budget, diskCache);
  for (const [id, a] of Object.entries(assess)) {
    for (const t of a.titles.slice(0, 10)) {
      const k = `${t.artist}|${t.title}`;
      if (out[id]?.[k]?.found) continue;           // eerder niet gevonden: opnieuw met opgeschoonde titel
      // Claude zet soms een notitie in de titel ("1962-1966 (rood dubbelalbum)"): weg voor het zoeken.
      const title = t.title.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim() || t.title;
      let res;
      for (let tries = 0; tries < 3; tries++) {
        try {
          res = await client.lookup({ artist: t.artist, title, catno: '' });
          // Altijd de vinylpersingen erbij: de ondergrens van de master telt ook cd's mee.
          if (res.found && res.rangePending) {
            const f = await client.fillRange(res.key.split(':')[1]);
            res = { ...res, low: f.lowVinyl ?? res.low, high: f.high, pressings: f.pressings };
          }
          break;
        } catch (e) {
          if (e instanceof RateLimited) { console.log('Discogs 429, 60 s pauze'); await sleep(60_000); continue; }
          res = { found: false, error: e.message };
          break;
        }
      }
      (out[id] ??= {})[k] = res ? { found: res.found, url: res.url, title: res.title, low: res.low, high: res.high, forSale: res.forSale, pressings: res.pressings, error: res.error } : { found: false };
      save('discogs.json', out);
      save('discogs-cache.json', Object.fromEntries(cache));
      console.log(`${t.artist} – ${t.title}: ${res?.found ? `€${res.low ?? '–'}–${res.high ?? '…'} (${res.forSale} te koop)` : 'niet gevonden'}`);
    }
  }
}

// ---- eindadvies ----

const ADVISE_SYSTEM = `Je geeft een opkoper van vinyl een kort koopadvies voor één Marktplaats-partij. Je krijgt de advertentie, een beoordeling van de foto's en Discogs-prijzen van de titels die zichtbaar waren. Discogs "laagste" = goedkoopste aanbod over alle persingen; "hoogste" = duurste van de 3 meest gezochte persingen; dat is geen verkoopprijs.

Reken nuchter: doorverkoop levert voor gewone platen €1-3 per stuk op, alleen gewilde titels meer. Houd rekening met hoeveel van de partij je werkelijk hebt gezien en met de staat. Bij "bieden" zonder vraagprijs: noem een redelijk bod.

oordeel:
- "snel reageren": duidelijk meer waard dan de vraagprijs, of zeldzame stukken zichtbaar.
- "bekijken": mogelijk interessant, maar te weinig zichtbaar of prijs onduidelijk; eerst meer foto's/lijst vragen.
- "overslaan": waarschijnlijk niet de moeite.`;

const ADVISE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'score', 'value_low', 'value_high', 'suggested_offer', 'summary', 'reasons', 'ask_seller'],
  properties: {
    verdict: { type: 'string', enum: ['snel reageren', 'bekijken', 'overslaan'] },
    score: { type: 'integer', description: '1-10, hoe interessant' },
    value_low: { type: 'number', description: 'geschatte doorverkoopwaarde hele partij, euro, ondergrens' },
    value_high: { type: 'number' },
    suggested_offer: { type: 'string', description: 'bijv. "max €80" of "vraagprijs is redelijk"' },
    summary: { type: 'string', description: 'één zin' },
    reasons: { type: 'array', items: { type: 'string' } },
    ask_seller: { type: 'string', description: 'wat je de verkoper zou vragen, of leeg' },
  },
};

if (run('advies')) {
  const details = load('fresh.json', []), assess = load('assess.json', {}), dc = load('discogs.json', {});
  const out = load('advise.json', {});
  for (const x of details) {
    const a = assess[x.itemId];
    if (!a || out[x.itemId]) continue;
    const prices = Object.entries(dc[x.itemId] ?? {}).map(([k, v]) => `- ${k.replace('|', ' – ')}: ${v.found ? `laagste €${v.low ?? '?'}, hoogste €${v.high ?? '?'}, ${v.forSale} te koop` : 'niet gevonden op Discogs'}`).join('\n') || '(geen titels leesbaar)';
    try {
      const { output, usage } = await claudeJson({
        system: ADVISE_SYSTEM, schema: ADVISE_SCHEMA, effort: 'low',
        text: `Advertentie: ${x.listingTitle}\nVraagprijs: ${priceLabel(x)}\nBeschrijving:\n${text(x)}\n\nBeoordeling foto's:\n${JSON.stringify({ ...a, usage: undefined, ms: undefined })}\n\nDiscogs:\n${prices}`,
      });
      out[x.itemId] = { ...output, usage };
      save('advise.json', out);
      console.log(`${out[x.itemId].verdict.padEnd(14)} ${out[x.itemId].score}/10  ${x.listingTitle.slice(0, 60)}`);
    } catch (e) {
      console.log(`FOUT advies ${x.itemId}: ${e.message}`);
    }
  }
}

// ---- HTML-overzicht ----

if (run('html')) {
  const details = load('fresh.json', []), assess = load('assess.json', {}), dc = load('discogs.json', {}), adv = load('advise.json', {});
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const eur = n => n == null || Number.isNaN(n) ? '–' : '€' + Math.round(n).toLocaleString('nl-NL');
  const eur2 = n => n == null ? '–' : '€' + Number(n).toFixed(2).replace('.', ',');
  const ORDER = { 'snel reageren': 0, 'bekijken': 1, 'overslaan': 2 };
  const when = s => s ? new Date(s).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }) : '';

  async function thumb(u) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      return r.ok ? `data:image/jpeg;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}` : null;
    } catch { return null; }
  }

  const rows = details.filter(x => adv[x.itemId]).map(x => ({ x, a: assess[x.itemId], v: adv[x.itemId], d: dc[x.itemId] ?? {} }))
    .sort((p, q) => ORDER[p.v.verdict] - ORDER[q.v.verdict] || q.v.score - p.v.score);

  const cards = [];
  for (const { x, a, v, d } of rows) {
    const thumbs = (await Promise.all(x.thumbUrls.slice(0, 6).map(thumb))).filter(Boolean);
    const titles = a.titles.slice(0, 10).map(t => {
      const p = d[`${t.artist}|${t.title}`];
      const price = !p ? '<td class="num dim">–</td>' : p.found
        ? `<td class="num"><a href="${esc(p.url)}" target="_blank" rel="noopener">${eur2(p.low)} – ${p.high != null ? eur2(p.high) : '…'}</a></td>`
        : '<td class="num dim">niet op Discogs</td>';
      return `<tr><td>${esc(t.artist)} – ${esc(t.title)}${t.source === 'beschrijving' ? ' <span class="src">tekst</span>' : ''}</td>${price}</tr>`;
    }).join('');
    const more = a.titles.length > 10 ? `<p class="dim small">+ ${a.titles.length - 10} titels meer gelezen</p>` : '';
    cards.push(`<article class="lot v-${v.verdict.replace(' ', '-')}" data-verdict="${esc(v.verdict)}">
  <div class="thumbs">${thumbs.map(t => `<img src="${t}" alt="" loading="lazy">`).join('') || '<div class="nophoto">geen foto\'s</div>'}${x.imageUrls.length > 6 ? `<span class="morephotos">+${x.imageUrls.length - 6}</span>` : ''}</div>
  <div class="body">
    <header class="lothead">
      <span class="pill">${esc(v.verdict)} · ${v.score}/10</span>
      <h2><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.listingTitle)}</a></h2>
      <p class="meta">${esc(x.priceText)} · ${esc(x.city || '')} · geplaatst ${esc(when(x.since))}${x.views ? ` · ${x.views}× bekeken` : ''}</p>
    </header>
    <p class="summary">${esc(v.summary)}</p>
    <dl class="figures">
      <div><dt>Geschatte waarde</dt><dd class="num">${eur(v.value_low)} – ${eur(v.value_high)}</dd></div>
      <div><dt>Bod / prijs</dt><dd>${esc(v.suggested_offer)}</dd></div>
      <div><dt>Omvang</dt><dd>${esc(a.estimated_count)}</dd></div>
      <div><dt>Zichtbaar</dt><dd>${esc(a.visible_share)}</dd></div>
    </dl>
    <ul class="reasons">${v.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    ${titles ? `<details class="titles"><summary>Leesbare titels (${a.titles.length})</summary><table><thead><tr><th>Plaat</th><th class="num">Discogs laagste – hoogste</th></tr></thead><tbody>${titles}</tbody></table>${more}</details>` : '<p class="dim small">Geen titels leesbaar op de foto\'s.</p>'}
    <p class="small"><strong>Genres:</strong> ${esc(a.genres)} · <strong>Staat:</strong> ${esc(a.condition)}</p>
    ${v.ask_seller ? `<p class="ask"><strong>Vraag de verkoper:</strong> ${esc(v.ask_seller)}</p>` : ''}
  </div>
</article>`);
  }

  const count = k => rows.filter(r => r.v.verdict === k).length;
  const first = rows.filter(r => r.v.verdict !== 'overslaan'), skip = rows.filter(r => r.v.verdict === 'overslaan');
  const firstCards = cards.slice(0, first.length).join('\n'), skipCards = cards.slice(first.length).join('\n');
  const generated = new Date().toLocaleString('nl-NL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });

  const html = `<title>Partijradar</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap">
<style>
:root {
  --bg: #f3f4f6; --card: #ffffff; --ink: #15171c; --muted: #5d6270; --line: #dfe2e8;
  --go: #0f7a4d; --go-bg: #e2f3ea; --look: #9a5a00; --look-bg: #fbeed5; --skip: #6b7080; --skip-bg: #eceef2;
  --link: #2446b8;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #111317; --card: #1a1d23; --ink: #eceef2; --muted: #9aa0ad; --line: #2b2f37;
    --go: #4fd08f; --go-bg: #143324; --look: #f1b457; --look-bg: #3a2a10; --skip: #9aa0ad; --skip-bg: #23262d;
    --link: #8fa8ff;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111317; --card: #1a1d23; --ink: #eceef2; --muted: #9aa0ad; --line: #2b2f37;
  --go: #4fd08f; --go-bg: #143324; --look: #f1b457; --look-bg: #3a2a10; --skip: #9aa0ad; --skip-bg: #23262d;
  --link: #8fa8ff;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 "IBM Plex Sans", system-ui, sans-serif; padding-inline: 16px; }
main { max-width: 980px; margin: 0 auto; padding-block: 28px 64px; display: flex; flex-direction: column; gap: 18px; }
h1 { font: 800 clamp(28px, 5vw, 40px)/1.05 Archivo, system-ui, sans-serif; letter-spacing: -.02em; margin: 0; }
.intro { color: var(--muted); max-width: 70ch; margin: 6px 0 0; }
.tally { display: flex; flex-wrap: wrap; gap: 10px; }
.tally div { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; min-width: 130px; }
.tally b { display: block; font: 700 26px/1 Archivo, sans-serif; }
.tally span { color: var(--muted); font-size: 13px; }
.tally .go b { color: var(--go); } .tally .look b { color: var(--look); } .tally .skip b { color: var(--skip); }
.lot { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: grid; grid-template-columns: 250px 1fr; }
.v-snel-reageren { border-color: var(--go); box-shadow: inset 4px 0 0 var(--go); }
.thumbs { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; align-content: start; background: var(--line); position: relative; }
.thumbs img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; max-width: 100%; }
.thumbs img:first-child { grid-column: span 2; aspect-ratio: 4/3; }
.nophoto { grid-column: span 2; padding: 40px 12px; text-align: center; color: var(--muted); background: var(--card); }
.morephotos { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.65); color: #fff; font-size: 12px; padding: 2px 7px; border-radius: 99px; }
.body { padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.lothead { display: flex; flex-direction: column; gap: 4px; }
.pill { align-self: flex-start; font: 600 12px/1 "IBM Plex Sans", sans-serif; letter-spacing: .04em; text-transform: uppercase; padding: 5px 9px; border-radius: 99px; }
.v-snel-reageren .pill { color: var(--go); background: var(--go-bg); }
.v-bekijken .pill { color: var(--look); background: var(--look-bg); }
.v-overslaan .pill { color: var(--skip); background: var(--skip-bg); }
h2 { font: 700 19px/1.25 Archivo, sans-serif; margin: 0; text-wrap: balance; }
h2 a { color: inherit; text-decoration: none; } h2 a:hover, h2 a:focus-visible { text-decoration: underline; }
.meta { color: var(--muted); font-size: 13px; margin: 0; }
.summary { margin: 0; font-weight: 500; }
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 16px; margin: 0; }
.figures dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
.figures dd { margin: 0; }
.num { font-family: "IBM Plex Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.reasons { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
details.titles summary { cursor: pointer; color: var(--link); font-weight: 500; }
.titles table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 14px; }
.titles th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; border-bottom: 1px solid var(--line); padding: 4px 0; }
.titles td { border-bottom: 1px solid var(--line); padding: 5px 8px 5px 0; vertical-align: top; }
.titles td.num, .titles th.num { text-align: right; white-space: nowrap; padding-right: 0; }
.titles a { color: var(--link); }
.src { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.small { font-size: 13px; margin: 0; } .dim { color: var(--muted); }
.ask { margin: 0; font-size: 14px; background: var(--bg); border-radius: 8px; padding: 8px 10px; }
details.skipped > summary { cursor: pointer; font: 700 18px Archivo, sans-serif; padding: 8px 0; }
details.skipped[open] > summary { margin-bottom: 12px; }
.skiplist { display: flex; flex-direction: column; gap: 18px; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
footer { color: var(--muted); font-size: 13px; }
@media (max-width: 640px) { .lot { grid-template-columns: 1fr; } .thumbs { grid-template-columns: repeat(3, 1fr); } .thumbs img:first-child { grid-column: span 3; } }
</style>
<main>
  <header>
    <h1>Partijradar</h1>
    <p class="intro">${rows.length} vinyl-partijen, geplaatst op Marktplaats tussen ${esc(when(rows.map(r => r.x.since).sort()[0]))} en ${esc(when(rows.map(r => r.x.since).sort().at(-1)))}, beoordeeld door Claude aan de hand van alle foto's en de tekst. Leesbare titels zijn opgezocht op Discogs. Geschatte waarde = wat de partij bij doorverkoop ongeveer oplevert, geen Discogs-vraagprijs.</p>
  </header>
  <section class="tally" aria-label="Samenvatting">
    <div class="go"><b>${count('snel reageren')}</b><span>snel reageren</span></div>
    <div class="look"><b>${count('bekijken')}</b><span>bekijken</span></div>
    <div class="skip"><b>${count('overslaan')}</b><span>overslaan</span></div>
  </section>
  ${firstCards}
  ${skip.length ? `<details class="skipped"><summary>Overslaan (${skip.length})</summary><div class="skiplist">${skipCards}</div></details>` : ''}
  <footer>Gemaakt ${esc(generated)}. Discogs "laagste" = goedkoopste aanbod over alle persingen, "hoogste" = duurste van de 3 meest gezochte persingen.</footer>
</main>`;
  writeFileSync(file('partijradar.html'), html);
  console.log(`marktplaats/partijradar.html: ${rows.length} partijen, ${(html.length / 1024).toFixed(0)} KB`);
}


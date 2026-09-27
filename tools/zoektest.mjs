// Zoektest: bekende herkenningen door de echte zoeklogica (src/discogs.js, dezelfde code als de
// Worker en de agent) en vergelijken met de juiste Discogs-plaat. Alleen zoekcalls: geen Claude,
// geen prijzen. Draaien: node tools/zoektest.mjs [filter op naam]
//
// Waarom: tools/proef.mjs had een eigen kopie van de zoeklogica en testte dus niet wat er draait.
// Gevallen in tools/zoektest-cases.json: `verwacht` = juiste sleutel, `niet` = sleutels die fout
// bleken, `was` = uitkomst van de code toen het geval werd vastgelegd (alleen ter vergelijking).
// Cache: tools/zoektest-cache.json (niet in git), aangevuld uit agent-cache.json en optioneel een
// export van de Worker-cache (ZOEKTEST_SEED=bestand.json). Nieuwe calls met 3 s ertussen, zodat de
// agent op hetzelfde IP ruim binnen de Discogs-limiet blijft.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { discogsClient } from '../src/discogs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = join(root, 'tools', 'zoektest-cache.json');
const GAP_MS = 3000;
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

const cases = readJson(join(root, 'tools', 'zoektest-cases.json'));
const filter = process.argv[2]?.toLowerCase();

let cache = {};
try { cache = readJson(CACHE_FILE); } catch {}
try { for (const [path, e] of Object.entries(readJson(join(root, 'agent-cache.json')))) cache[path] ??= e.body; } catch {}
if (process.env.ZOEKTEST_SEED) for (const r of readJson(process.env.ZOEKTEST_SEED)) cache[r.path] ??= JSON.parse(r.body);
const save = () => writeFileSync(CACHE_FILE, JSON.stringify(cache));

const token = readFileSync(join(root, 'token.env.txt'), 'utf8').trim();
let live = 0, last = 0;
const client = discogsClient(token, async () => {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  if (++live % 10 === 0) save();
}, {
  async get(path) { return cache[path] ?? null; },   // geen houdbaarheid: de test moet herhaalbaar zijn
  async put(path, body) { cache[path] = body; },
});

const tally = { ok: 0, fout: 0, anders: 0, gelijk: 0 };
for (const c of cases) {
  if (filter && !c.naam.toLowerCase().includes(filter)) continue;
  let got = null, err = null;
  try { got = await client.find(c.rec); } catch (e) { err = e.message || String(e); }
  const key = got?.key ?? null;
  let mark, extra = '';
  if (err) { mark = '✗'; tally.fout++; extra = `  FOUT ${err}`; }
  else if ('verwacht' in c) {
    if (key === c.verwacht) { mark = '✓'; tally.ok++; }
    else { mark = '✗'; tally.fout++; extra = `  verwacht ${c.verwacht ?? 'niet gevonden'}`; }
  } else if (c.niet?.includes(key)) { mark = '✗'; tally.fout++; extra = '  bekende foute treffer'; }
  else if (key !== (c.was ?? null)) { mark = '?'; tally.anders++; extra = `  was ${c.was ?? 'niet gevonden'}${c.niet ? ' (fout)' : ''}`; }
  else { mark = '='; tally.gelijk++; }
  const hit = got ? `${got.step}: ${got.hit.title}` : 'niet gevonden';
  console.log(`${mark} ${c.naam.slice(0, 58).padEnd(58)} ${(key ?? '').padEnd(16)} ${hit.slice(0, 70)}${extra}`);
}
save();
console.log(`\n${tally.ok} goed, ${tally.fout} fout, ${tally.anders} anders dan eerst (nakijken), ${tally.gelijk} ongewijzigd zonder oordeel. ${live} nieuwe Discogs-calls.`);
process.exitCode = tally.fout ? 1 : 0;

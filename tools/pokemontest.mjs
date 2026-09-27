// Regressietest van de Pokémon-zoekstap (src/pokemon.js) tegen TCGdex, zonder Claude: vaste
// herkenningsuitkomsten met de juiste kaart of "niet gevonden". Draaien: node tools/pokemontest.mjs
import { tcgdexClient } from '../src/pokemon.js';

const mem = new Map();
const cache = { get: async k => mem.get(k) ?? null, put: async (k, v) => { mem.set(k, v); } };
const client = tcgdexClient(cache);

const base = { name_en: '', printed_total: '', set_code: '', set_name: '', language: 'en', variant: 'unknown', first_edition: false, notes: '' };
const cases = [
  ['Base Set Charizard', { name: 'Charizard', number: '4', printed_total: '102', variant: 'holo' }, 'base1-4'],
  ['Base Set Pikachu', { name: 'Pikachu', number: '58', printed_total: '102' }, 'base1-58'],
  ['Duitse kaart (Glurak)', { name: 'Glurak', name_en: 'Charizard', number: '4', printed_total: '102', language: 'de' }, 'base1-4'],
  ['Base Set 2 (andere set, zelfde nummer)', { name: 'Charizard', number: '4', printed_total: '130' }, 'base4-4'],
  ['Nederlandse trainerkaart', { name: 'Professor Eik', name_en: 'Professor Oak', number: '88', printed_total: '102', language: 'nl' }, 'base1-88'],
  ['Secret rare (nummer > totaal)', { name: 'Charizard ex', number: '199', printed_total: '165', set_code: 'MEW' }, 'sv03.5-199'],
  ['Reverse holo pakt de reverse-prijs', { name: 'Pikachu', number: '025', printed_total: '165', set_code: 'MEW', variant: 'reverse_holo' }, 'sv03.5-025', r => r.details?.priceVariant === 'reverse holo'],
  ['Promo zonder totaal', { name: 'Charizard V', number: 'SWSH050' }, 'swshp-SWSH050'],
  ['Moderne kaart met voorloopnullen', { name: 'Miraidon', number: '080', printed_total: '198', set_code: 'SVI' }, 'sv01-080'],
  ['Licht verkeerd gelezen naam', { name: 'Charizzard', number: '4', printed_total: '102' }, 'base1-4'],
  ['Verkeerd gelezen totaal: niet gevonden', { name: 'Charizard', number: '4', printed_total: '103' }, null],
  ['Japanse kaart: niet gevonden', { name: 'リザードン', number: '6', printed_total: '102', language: 'ja' }, null],
  ['Onbekende naam op nummer: niet gevonden', { name: 'Energie Verwijdering', number: '92', printed_total: '102', language: 'nl' }, null],
];

let bad = 0;
const eur = n => (n == null ? '–' : '€' + n.toFixed(2));
for (const [label, rec, want, extra] of cases) {
  const t0 = Date.now();
  const r = await client.lookup({ ...base, ...rec });
  const got = r.found ? r.key.replace('tcgdex:', '') : null;
  const ok = got === want && (!extra || !r.found || extra(r));
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(42)} verwacht ${String(want).padEnd(14)} kreeg ${String(got).padEnd(14)} ${r.found ? `${eur(r.low)} – ${eur(r.high)}  ${r.title}` : (r.reason || '')}  (${Date.now() - t0} ms)`);
}
console.log(`\n${cases.length - bad}/${cases.length} goed.`);
process.exitCode = bad ? 1 : 0;

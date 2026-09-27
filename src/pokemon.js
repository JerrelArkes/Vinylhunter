// Pokémon-kaarten: foto -> kaartgegevens (Claude) -> kaart en Cardmarket-prijs via TCGdex.
//
// TCGdex (api.tcgdex.net): gratis, geen sleutel, geen harde limiet ("be considerate", daarom de cache),
// prijzen van Cardmarket (EUR, dagelijks bijgewerkt) en TCGplayer (USD) in elke kaart. Gekozen
// 2026-09-25: pokemontcg.io neemt geen nieuwe sleutels meer aan en stopt 1 maart 2027; de opvolger
// Scrydex rekent per aanvraag. TCGdex kent geen Nederlands: we zoeken altijd de Engelse kaart met
// hetzelfde nummer (bij WotC-kaarten gelijk aan de Nederlandse uitgave).
import { askJson } from './claude.js';

export const POKEMON_SYSTEM = `Je krijgt een foto uit een kringloopwinkel van een Pokémon-ruilkaart (Trading Card Game), soms in een hoesje of in een verzamelmap.

Lees de voorste, meest complete kaart af. De foto kan gedraaid zijn.
- name: de kaartnaam zoals gedrukt, met achtervoegsel (bijv. "Charizard", "Glurak", "Pikachu V", "Charizard ex", "Mewtwo-GX", "Professor's Research").
- name_en: de Engelse kaartnaam, alleen als je die zeker weet. Pokémonnamen op Nederlandse kaarten zijn meestal gelijk aan de Engelse; Duitse en Franse namen vertaal je (Glurak/Dracaufeu → Charizard), trainerkaarten ook (Professor Eik → Professor Oak). Neem achtervoegsels over zoals ze in het Engels geschreven worden (ex, EX, GX, V, VMAX, VSTAR). Leeg als je het niet zeker weet.
- number: het kaartnummer vóór de schuine streep, precies zoals gedrukt (bijv. "4", "058", "TG05", "GG40", "SWSH050", "SV047"). Staat klein onderaan de kaart. Niet gokken: leeg als je het niet zeker leest.
- printed_total: het getal na de schuine streep (bijv. "102", "198"); leeg als er geen staat.
- set_code: de setafkorting als die gedrukt staat (moderne kaarten, naast het nummer, bijv. "SVI", "PAL", "OBF", "MEW", "PAR"); anders leeg.
- set_name: de Engelse naam van de set als je die herkent (bijv. aan het setsymbool: geen symbool bij Base Set); anders leeg.
- language: taal van de kaarttekst: "en", "nl", "de", "fr", "it", "es", "ja", "ko", "zh" of "other".
- variant: "holo" (de afbeelding glanst), "reverse_holo" (de rest van de kaart glanst, de afbeelding niet), "normal" of "unknown".
- first_edition: true als er een "Edition 1"-stempel links onder de afbeelding staat.
- notes: bijzonderheden in een paar Nederlandse woorden (bijv. "shadowless", "promo", "in graded slab", "vouw in de kaart"), anders leeg.

status:
- "ok": naam en nummer zijn leesbaar.
- "unclear": er is een kaart maar naam of nummer is niet betrouwbaar te lezen (bewogen, te ver weg, meerdere kaarten door elkaar).
- "no_card": geen Pokémon-kaart in beeld.`;

export const POKEMON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'name', 'name_en', 'number', 'printed_total', 'set_code', 'set_name', 'language', 'variant', 'first_edition', 'notes'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unclear', 'no_card'] },
    name: { type: 'string' },
    name_en: { type: 'string' },
    number: { type: 'string' },
    printed_total: { type: 'string' },
    set_code: { type: 'string' },
    set_name: { type: 'string' },
    language: { type: 'string', enum: ['en', 'nl', 'de', 'fr', 'it', 'es', 'ja', 'ko', 'zh', 'other'] },
    variant: { type: 'string', enum: ['holo', 'reverse_holo', 'normal', 'unknown'] },
    first_edition: { type: 'boolean' },
    notes: { type: 'string' },
  },
};

export function recognizePokemon(apiKey, model, jpegBase64) {
  return askJson(apiKey, { model, system: POKEMON_SYSTEM, schema: POKEMON_SCHEMA, images: [jpegBase64], text: 'Welke kaart is dit?' });
}

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’']/g, '').replace(/[^a-z0-9δ]+/g, ' ').trim();
// "058" -> "58", "TG05" -> "TG5", "SWSH050" -> "SWSH50"; "4/102" -> "4".
export const normNumber = s => String(s ?? '').split('/')[0].toUpperCase().replace(/\s+/g, '').replace(/^([A-Z]*)0*(\d)/, '$1$2');

// Sleutel voor "zelfde kaart kort geleden al gescand" (zoals rec_key bij vinyl).
export const pokemonKey = r => `pk|${norm(r.name_en || r.name)}|${normNumber(r.number)}|${parseInt(r.printed_total, 10) || ''}`;
// Voorlopige titel tot de kaart gevonden is.
export const pokemonLabel = r => `${r.number || '?'}${r.printed_total ? '/' + r.printed_total : ''}${r.set_code ? ' ' + r.set_code : ''}`;

const TCGDEX = 'https://api.tcgdex.net/v2/en';
// Kaarten (met prijs) 1 dag, zoeklijsten en sets 7 dagen. Sleutels beginnen met 'tcgdex:'.
export const tcgdexTtl = key => (/^tcgdex:\/cards\/[^?]+$/.test(key) ? 86400_000 : 7 * 86400_000);

export function tcgdexClient(cache) {
  let calls = 0, cached = 0;
  async function get(path) {
    const key = 'tcgdex:' + path;
    const hit = await cache.get(key);
    if (hit) { cached++; return hit; }
    calls++;
    const r = await fetch(TCGDEX + path, { headers: { 'User-Agent': 'Vinylhunter/1.0' }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`TCGdex ${r.status}`);
    const body = await r.json();
    await cache.put(key, body);
    return body;
  }
  const setIdOf = c => c.id.slice(0, c.id.lastIndexOf('-'));   // set-id's kunnen zelf een '-' bevatten ("30th-c")

  async function lookup(rec) {
    const done = extra => ({ ...extra, calls, cached });
    const number = normNumber(rec.number);
    if (!number) return done({ found: false });
    if (['ja', 'ko', 'zh'].includes(rec.language)) return done({ found: false, reason: 'Aziatische kaart: niet in de Engelse database' });
    const total = parseInt(rec.printed_total, 10) || null;
    const code = String(rec.set_code || '').trim().toUpperCase();
    const sets = (await get('/sets')) || [];
    const setById = new Map(sets.map(s => [s.id, s]));
    const official = c => setById.get(setIdOf(c))?.cardCount?.official;

    // Kandidaten met dit nummer: eerst op exacte naam, dan op naam-bevat, dan (met totaal) alleen op nummer.
    const names = [...new Set([rec.name_en, rec.name].map(s => String(s || '').trim()).filter(Boolean))];
    let cands = [];
    for (const q of [...names.map(n => `name=eq:${encodeURIComponent(n)}`), ...names.map(n => `name=${encodeURIComponent(n)}`)]) {
      cands = ((await get(`/cards?${q}`)) || []).filter(c => normNumber(c.localId) === number);
      if (cands.length) break;
    }
    // Laatste poging voor een licht verkeerd gelezen naam: zelfde nummer en totaal, naam bijna gelijk.
    // Een heel andere naam (vertaalde trainerkaart) valt af: dat zou een willekeurige kaart geven.
    if (!cands.length && total) {
      cands = ((await get(`/cards?localId=${encodeURIComponent(number)}`)) || [])
        .filter(c => normNumber(c.localId) === number && official(c) === total && names.some(n => similar(c.name, n)));
    }
    // Staat er een totaal op de kaart, dan moet de set dat aantal kaarten hebben. Liever niet gevonden
    // (dan leest Opus de foto nog eens) dan de prijs van dezelfde kaart uit een andere set: Charizard
    // 4/102 (Base Set) is een veelvoud van 4/130 (Base Set 2).
    if (total) cands = cands.filter(c => official(c) === total);
    if (!cands.length) return done({ found: false });

    const setName = norm(rec.set_name), wanted = norm(rec.name_en || rec.name);
    const score = c => {
      const s = setById.get(setIdOf(c));
      let n = norm(c.name) === wanted ? 1 : 0;
      if (setName && s) n += norm(s.name) === setName ? 3 : (norm(s.name).includes(setName) || setName.includes(norm(s.name))) ? 1 : 0;
      return n + (c.codeMatch ? 5 : 0);
    };
    let top = topBy(cands, score);
    // Meerdere sets over: de gedrukte setafkorting (moderne kaarten) beslist.
    if (top.length > 1 && code) {
      for (const c of top) c.codeMatch = (await get(`/sets/${setIdOf(c)}`))?.abbreviation?.official?.toUpperCase() === code;
      top = topBy(top, score);
    }
    const card = await get(`/cards/${top[0].id}`);
    if (!card) return done({ found: false });

    // Cardmarket: de velden met "-holo" zijn de reverse-holoversie van dezelfde kaart (bij een holo-rare
    // is de gewone prijs de holo). Ontbreekt de gekozen variant, dan de andere.
    // TCGdex geeft soms 0 waar geen prijs is (bijv. "trend-holo" bij een kaart zonder reverse): telt als onbekend.
    const cm = card.pricing?.cardmarket || null;
    const rev = rec.variant === 'reverse_holo';
    const val = x => (typeof x === 'number' && x > 0 ? x : null);
    const pick = f => (rev ? val(cm?.[f + '-holo']) ?? val(cm?.[f]) : val(cm?.[f]) ?? val(cm?.[f + '-holo']));
    const low = pick('low'), trend = pick('trend'), avg30 = pick('avg30');
    const hi = trend ?? avg30 ?? pick('avg');
    const lo = low ?? hi;
    const set = card.set || {};
    return done({
      found: true,
      key: `tcgdex:${card.id}`,
      step: 'tcgdex',
      url: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name)}`,
      // Promokaarten ("SWSH050") hebben geen "/totaal" op de kaart.
      title: `${card.name} · ${set.name ?? setIdOf(card)} ${card.localId}${/^\d+$/.test(card.localId) && set.cardCount?.official ? '/' + set.cardCount.official : ''}`,
      low: lo != null && hi != null ? Math.min(lo, hi) : lo,
      high: lo != null && hi != null ? Math.max(lo, hi) : hi,
      forSale: null, pressings: null, rangePending: false,
      details: {
        cardId: card.id, name: card.name, set: set.name, localId: card.localId, official: set.cardCount?.official,
        rarity: card.rarity, variants: card.variants, priceVariant: cm ? (rev && val(cm['trend-holo']) ? 'reverse holo' : 'normaal') : null,
        cardmarket: cm && { low, trend, avg30, updated: cm.updated },
        ...(top.length > 1 ? { ambiguous: top.map(c => c.id) } : {}),
      },
    });
  }
  return { lookup };
}

function topBy(list, score) {
  const best = Math.max(...list.map(score));
  return list.filter(c => score(c) === best);
}

// Namen die hooguit een paar letters verschillen (leesfout), niet een andere kaart.
function similar(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ')) return true;
  const d = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[y.length] <= Math.max(2, Math.floor(Math.min(x.length, y.length) / 5));
}

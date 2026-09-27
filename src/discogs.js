// Discogs: plaat opzoeken en prijsrange bepalen. Zoekvolgorde en valkuilen: ARCHITECTURE.md.

export class RateLimited extends Error {
  /** @param {boolean} fromDiscogs true = Discogs gaf 429 (niet ons eigen budget) */
  constructor(message, fromDiscogs = false) { super(message); this.fromDiscogs = fromDiscogs; }
}

// Genormaliseerde sleutel "artiest|titel" om dubbele foto's vóór Discogs te herkennen.
export function recKey(artist, title) {
  const n = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return artist && title ? `${n(artist)}|${n(title)}` : null;
}

const STOP = new Set(['the', 'en', 'and', 'van', 'de', 'het', 'der', 'die', 'les', 'zijn', 'een']);
// Zeggen niets over wélke plaat het is. Bij verzamelplaten staat "Various" in de titel van elke
// treffer, dus daarop keurde de oude controle elke verzamelplaat goed (#80/#81, 2026-09-24).
const VAGUE = new Set(['various', 'artists', 'artist', 'diverse', 'diversen', 'artiesten', 'verschillende', 'compilation']);
const LABEL_VAGUE = new Set(['records', 'record', 'recordings', 'music', 'musique', 'international', 'production',
  'productions', 'disques', 'schallplatten', 'platen', 'company', 'sound', 'studio', 'studios', 'entertainment', 'label']);
const words = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));
const sharp = s => words(s).filter(w => !VAGUE.has(w));
const labelWords = s => words(s).filter(w => !LABEL_VAGUE.has(w));
// "2748" of "3995" delen tientallen labels; met letters of vanaf 6 cijfers is een nummer vrijwel uniek.
const specificCatno = c => /[a-z]/i.test(c || '') || (c || '').replace(/\D/g, '').length >= 6;
// "Henk Wijngaard e.a." vindt Discogs niet; zonder toevoeging wel.
const cleanArtist = a => (a || '').replace(/\s*(,|&)?\s*\b(e\.\s?a\.?|o\.\s?a\.?|c\.\s?s\.?|en anderen|and others)\s*$/i, '').trim();

/**
 * Past een Discogs-treffer bij de hoes? Eén gedeeld woord was te los: "hast" koppelde Wencke Myhre
 * aan een plaat van Pompilia, "various" elke verzamelplaat aan elke andere (zoektest 2026-09-24).
 * - catno: artiest klopt, én titel/andere kant, label of een specifiek catalogusnummer (#33: de
 *   B-kant "Ik blijf maar liever vrijgezel" onder "Lieve Kleine Blonde", JBS 807, klopt).
 * - master/release: Discogs filtert al op artiest; een woord uit titel of andere kant moet kloppen.
 * - vrije tekst: Discogs zoekt los (ook in tracklijsten): titel én artiest, of de hele titel als
 *   die uit minstens twee woorden bestaat ("Weekend" of "Marion" alleen zegt te weinig).
 * - titel (laatste poging, alleen op titel gezocht): titel én artiest.
 * - geen bruikbare artiest (Various, "a-ha"): de titel moet precies kloppen, het label ook als dat
 *   bekend is. Liever "niet gevonden" dan de prijs van een andere verzamelplaat.
 */
export function matches(rec, hit, step = 'catno') {
  const hw = new Set(sharp(hit.title));
  const has = w => hw.has(w);
  const title = sharp(rec.title), side = sharp(rec.other_side), artist = sharp(rec.artist);
  const titleOk = [...title, ...side].some(has);
  const labelKnown = !!rec.label && !!hit.label?.length;
  const hitLabels = new Set((hit.label || []).flatMap(labelWords));
  const labelOk = labelKnown && labelWords(rec.label).some(w => hitLabels.has(w));
  if (!artist.length) {
    const allowed = new Set([...title, ...side]);
    const exact = title.length > 0 && title.every(has) && [...hw].every(w => allowed.has(w));
    return exact && (!labelKnown || labelOk);
  }
  const artistOk = artist.some(has);
  if (step === 'catno') return artistOk && (titleOk || labelOk || specificCatno(rec.catno));
  if (step === 'vrije tekst') return titleOk && (artistOk || (title.length >= 2 && title.every(has)));
  if (step === 'titel') return titleOk && artistOk;
  return titleOk;
}

// Bovengrens uit de N meest gezochte persingen. Gemeten (tools/topn.mjs, 19 masters): top-3 geeft
// bij 15/19 dezelfde bovengrens als top-5 en scheelt 2 calls per plaat.
const TOP_N = 3;

// Hoe lang een antwoord uit de cache goed genoeg is.
export function cacheTtl(path) {
  if (path.startsWith('/marketplace/')) return 24 * 3600_000;      // prijzen: 1 dag
  if (path.startsWith('/database/search')) return 30 * 86400_000;  // zoekresultaten: 30 dagen
  return 7 * 86400_000;                                            // masters, versies
}

/**
 * Draait zowel in de Worker als op de agent-pc (tools/discogs-agent.mjs, Node 18+).
 * @param {string} token Discogs persoonlijk token
 * @param {() => Promise<void>} beforeCall gooit RateLimited als het budget op is
 * @param {{get: (path: string) => Promise<any>, put: (path: string, body: any) => Promise<void>}} [cache]
 */
export function discogsClient(token, beforeCall = async () => {}, cache = null) {
  const headers = { Authorization: `Discogs token=${token}`, 'User-Agent': 'Vinylhunter/0.2' };
  let calls = 0, cached = 0;
  async function dc(path) {
    const hit = await cache?.get(path);
    if (hit) { cached++; return hit; }
    await beforeCall();
    calls++;
    const r = await fetch('https://api.discogs.com' + path, { headers });
    if (r.status === 429) {
      console.log(`Discogs 429 op ${path.split('?')[0]} used=${r.headers.get('x-discogs-ratelimit-used')} remaining=${r.headers.get('x-discogs-ratelimit-remaining')} retry-after=${r.headers.get('retry-after')}`);
      throw new RateLimited('Discogs 429', true);
    }
    if (!r.ok) throw new Error(`Discogs ${r.status} op ${path.split('?')[0]}`);
    const body = await r.json();
    await cache?.put(path, body);
    return body;
  }
  const q = encodeURIComponent;

  // Geeft ook de Discogs-sleutel terug (master:ID of release:ID), zodat tools/zoektest.mjs de
  // zoekstap kan toetsen zonder prijs-calls.
  async function find(rec) {
    const found = await search(rec);
    if (!found) return null;
    const masterId = found.isMaster ? found.hit.id : found.hit.master_id;
    return { ...found, masterId, key: masterId ? `master:${masterId}` : `release:${found.hit.id}` };
  }

  async function search(rec) {
    const { title, catno } = rec;
    const artist = cleanArtist(rec.artist);
    if (catno) {
      const s = await dc(`/database/search?type=release&catno=${q(catno)}&per_page=50`);
      const hit = s.results.find(r => matches(rec, r, 'catno'));
      if (hit) return { step: 'catno', hit };
    }
    if (artist && title) {
      // Niet blind de eerste: de filters van Discogs zijn ruim (bij "Various" elke verzamelplaat).
      let s = await dc(`/database/search?type=master&format=Vinyl&artist=${q(artist)}&release_title=${q(title)}`);
      let hit = s.results.find(r => matches(rec, r, 'master'));
      if (hit) return { step: 'master', hit, isMaster: true };
      s = await dc(`/database/search?type=release&format=Vinyl&artist=${q(artist)}&release_title=${q(title)}`);
      hit = s.results.find(r => matches(rec, r, 'release'));
      if (hit) return { step: 'release', hit };
    }
    // Alleen kernwoorden: "Een" op de hoes tegenover "'n" op Discogs, of "en" tegenover "&", liet de
    // hele zoekopdracht mislukken (Ponypark Slagharen, 2026-09-24).
    const terms = words(`${artist} ${title || ''}`);
    const text = terms.length >= 2 ? terms.join(' ') : `${artist} ${title || ''}`.trim();
    if (!text) return null;
    let s = await dc(`/database/search?type=release&q=${q(text)}`);
    let hit = s.results.find(r => matches(rec, r, 'vrije tekst'));
    if (hit) return { step: 'vrije tekst', hit };
    // Laatste poging op alleen de titel: vangt een verkeerd gelezen artiest ("Freddy Casbye", of
    // "Danyel Gérard" op een hoes van Danyel Dirk). Kost alleen bij niet-gevonden platen een call.
    const titleText = words(title).join(' ');
    if (!titleText || titleText === text) return null;
    s = await dc(`/database/search?type=release&q=${q(titleText)}`);
    hit = s.results.find(r => matches(rec, r, 'titel'));
    return hit ? { step: 'titel', hit } : null;
  }

  // Stap 1 (snel): ondergrens en aantal te koop. Bij een master is de bovenkant nog open
  // (rangePending); die vult stap 2 aan zodra er geen nieuwe scans wachten.
  async function quickPrice(found) {
    const { masterId } = found;
    if (masterId) {
      const m = await dc(`/masters/${masterId}`);
      return {
        key: `master:${masterId}`, url: m.uri, title: m.title, pressings: null,
        low: m.lowest_price ?? null, high: null, forSale: m.num_for_sale ?? 0, rangePending: true,
      };
    }
    // Losse release (geen master): één persing, dus de range is meteen compleet.
    const st = await dc(`/marketplace/stats/${found.hit.id}?curr_abbr=EUR`);
    return {
      key: `release:${found.hit.id}`, url: 'https://www.discogs.com' + found.hit.uri, title: found.hit.title, pressings: 1,
      low: st.lowest_price?.value ?? null, high: st.lowest_price?.value ?? null, forSale: st.num_for_sale ?? 0, rangePending: false,
    };
  }

  return {
    find,

    async lookup(rec) {
      const found = await find(rec);
      if (!found) return { found: false, calls, cached };
      const price = await quickPrice(found);
      return { found: true, step: found.step, ...price, calls, cached };
    },

    // Stap 2: bovenkant van de range uit de TOP_N meest gezochte persingen.
    async fillRange(masterId) {
      const v = await dc(`/masters/${masterId}/versions?format=Vinyl&per_page=100`);
      const top = [...v.versions]
        .sort((a, b) => (b.stats?.community?.in_wantlist ?? 0) - (a.stats?.community?.in_wantlist ?? 0))
        .slice(0, TOP_N);
      const prices = [];
      for (const x of top) {
        const st = await dc(`/marketplace/stats/${x.id}?curr_abbr=EUR`);
        if (st.lowest_price) prices.push(st.lowest_price.value);
      }
      // lowVinyl: goedkoopste van dezelfde vinylpersingen. master.lowest_price (de ondergrens uit stap 1)
      // telt ook cd's en cassettes mee: Sgt. Pepper gaf €0,10 (2026-09-27, Marktplaats-proef).
      return { pressings: v.pagination.items, high: prices.length ? Math.max(...prices) : null,
        lowVinyl: prices.length ? Math.min(...prices) : null, calls };
    },
  };
}

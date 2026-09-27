// Standen Keramiek en Zilver: meerdere foto's van één stuk -> analyse door Opus met de naslag
// (src/naslag.js) -> bij een interessant stuk een prijscheck met web search.
//
// Twee stappen, zoals de prijs bij vinyl: de analyse (~15-25 s) past in de 30 s die een Worker na
// het antwoord nog krijgt (waitUntil), zodat er snel een eerste oordeel staat. De prijscheck duurde
// in de proef van 2026-09-25 26-46 s ($0,18-0,26) en draait daarom alleen in de cron (15 min).
import { askJson } from './claude.js';
import { KERAMIEK_NASLAG, ZILVER_NASLAG, OVERIG_NASLAG } from './naslag.js';

const INTRO = soort => `Je helpt een opkoper in een Nederlandse kringloopwinkel. Je krijgt foto's van één stuk: eerst het geheel, daarna details (bodem, merk, keurtekens). Beoordeel wat het is en wat het realistisch opbrengt.

Werkwijze:
- Beschrijf alleen wat je ziet en wat uit de naslag of je eigen kennis volgt. Lees merken, stempels en tekens letterlijk over in "marks"; verzin niets. Onleesbaar of niet gefotografeerd? Zeg dat.
- Waarde = wat dit exemplaar in deze staat realistisch opbrengt bij particuliere doorverkoop in Nederland (Marktplaats, Catawiki), in hele euro's. Geen winkelprijs of vraagprijs van een vintagewinkel.
- Bij twijfel: bredere range, lagere zekerheid, en in "checks" wat de gebruiker kan doen om het zeker te maken (een scherpere foto van het merk, wegen, meten, omdraaien).
- Kort en concreet, in het Nederlands. object: soort voorwerp in 1-3 woorden. value_basis: 1-3 zinnen. checks: hooguit 2 zinnen. Leeg laten wat je niet weet.
- search_query: een zoekterm waarmee je vergelijkbare verkopen vindt (maker, model of vormnummer, soort voorwerp).

status:
- "ok": je kunt het stuk beoordelen (ook als de maker onbekend is).
- "unclear": de foto's zijn te onduidelijk om iets zinnigs te zeggen.
- "not_applicable": het is geen ${soort}.`;

const KERAMIEK_SYSTEM = `${INTRO('keramiek, aardewerk of porselein')}
- material: aardewerk, steengoed, porselein of faience. material_verdict: "nvt". fineness en weight_g: 0.

${KERAMIEK_NASLAG}`;

const ZILVER_SYSTEM = `${INTRO('zilveren of verzilverd voorwerp (of ander metaal dat daarop lijkt)')}
- material_verdict: "echt_zilver" alleen bij een gehalteteken of gehaltegetal van echt zilver; "verzilverd" bij verzilveringsmerken, een niet-zilvermetaal of duidelijke slijtage van de verzilvering; anders "onzeker".
- fineness: het gehalte in duizendsten (925, 835, 800, 830, 900, 950, 934, 833, 875); 0 als het onbekend of verzilverd is.
- weight_g: je beste schatting van het zilvergewicht in gram (zie naslag); 0 bij verzilverd.
- material: bijv. "zilver 835 (2e gehalte)", "verzilverd (EPNS)", "alpacca".
- Bij echt zilver is value_low minstens ~85% van de smeltwaarde (gewicht × gehalte/1000 × zilverprijs).

${ZILVER_NASLAG}`;

// Overig (sinds 2026-09-25): alles uit een kringloop dat geen eigen stand heeft.
const OVERIG_SYSTEM = `${INTRO('voorwerp (alleen vloer, wand of iets onherkenbaars)')}
- material: waar het van gemaakt is (bijv. hout, kunststof, glas, metaal, textiel). material_verdict: "nvt". fineness en weight_g: 0.

${OVERIG_NASLAG}`;

export const EXPERT_KINDS = {
  keramiek: { system: KERAMIEK_SYSTEM, details: 'foto 2 en verder zijn details (bodem, merk)', checkFrom: 25, soort: 'keramisch' },
  zilver: { system: ZILVER_SYSTEM, details: 'foto 2 en verder zijn close-ups (keurtekens)', checkFrom: 40, soort: 'zilveren of verzilverd' },
  overig: { system: OVERIG_SYSTEM, details: 'foto 2 en verder zijn details (merk, typeplaatje, label, signatuur)', checkFrom: 25, soort: 'tweedehands' },
};

export const EXPERT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'object', 'maker', 'line', 'origin', 'period', 'marks', 'material', 'material_verdict', 'fineness',
    'weight_g', 'condition', 'confidence', 'value_low', 'value_high', 'value_basis', 'checks', 'search_query'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unclear', 'not_applicable'] },
    object: { type: 'string' },
    maker: { type: 'string' },
    line: { type: 'string' },              // vorm, model, decor, serie
    origin: { type: 'string' },            // land of plaats
    period: { type: 'string' },
    marks: { type: 'string' },             // letterlijk wat er op bodem of keurtekens staat
    material: { type: 'string' },
    material_verdict: { type: 'string', enum: ['echt_zilver', 'verzilverd', 'onzeker', 'nvt'] },
    fineness: { type: 'integer' },
    weight_g: { type: 'number' },
    condition: { type: 'string' },
    confidence: { type: 'string', enum: ['hoog', 'middel', 'laag'] },
    value_low: { type: 'number' },
    value_high: { type: 'number' },
    value_basis: { type: 'string' },
    checks: { type: 'string' },
    search_query: { type: 'string' },
  },
};

const silverLine = silver => (silver
  ? `Zilverprijs vandaag: €${silver.toFixed(2)} per gram puur zilver.`
  : 'De zilverprijs van vandaag is onbekend: noem gewicht en gehalte, en zeg dat de smeltwaarde niet berekend kon worden.');

// Vraag bij de foto's; gedeeld met de abonnementsroute (tools/claude-cli.mjs), zodat beide hetzelfde vragen.
export const analyseText = (kind, count, silver) => [
  count > 1 ? `Foto 1 is het hele stuk; ${EXPERT_KINDS[kind].details}.` : 'Er is één foto.',
  kind === 'zilver' ? silverLine(silver) : '',
  'Beoordeel dit stuk.',
].filter(Boolean).join(' ');

// Analyse van de foto's. images[0] = het hele stuk. Geen herhaling bij een time-out: de cron pakt het
// stuk dan opnieuw op (dubbel betalen voor een lange aanroep is duurder dan even wachten).
export function analyse(apiKey, kind, images, { model, effort = 'low', silver = null } = {}) {
  const k = EXPERT_KINDS[kind];
  const text = analyseText(kind, images.length, silver);
  return askJson(apiKey, {
    model, system: k.system, schema: EXPERT_SCHEMA, images, text, effort,
    maxTokens: 4000, timeout: 90_000, retries: 0, cacheSystem: true,
  });
}

// Smeltwaarde van echt zilver (euro), of null.
export function meltValue(a, silver) {
  if (a.material_verdict !== 'echt_zilver' || !(a.fineness > 0) || !(a.weight_g > 0) || !silver) return null;
  return Math.round(a.weight_g * a.fineness / 1000 * silver * 100) / 100;
}

// Prijscheck alleen als het stuk iets kan opbrengen; verzilverd of goedkoop is de moeite niet.
export const needsCheck = (kind, a) => a.status === 'ok' && a.material_verdict !== 'verzilverd'
  && a.value_high >= EXPERT_KINDS[kind].checkFrom;

export const PRICE_SYSTEM = kind => `Je bent taxateur voor een opkoper in Nederland. Je krijgt de beschrijving van één ${EXPERT_KINDS[kind].soort} stuk uit een kringloopwinkel, met een eerste schatting op basis van foto's. Zoek op internet naar vergelijkbare stukken en bepaal wat dit exemplaar realistisch opbrengt bij particuliere doorverkoop in Nederland.

- Zoek hooguit 3 keer. Begin met de zoekterm uit de beschrijving. Zoek in elk geval één keer naar verkochte of geveilde stukken (bijv. zoekterm + "Catawiki") en één keer naar Nederlands aanbod (zoekterm + "Marktplaats"): zo is de uitkomst niet afhankelijk van welke winkels toevallig bovenaan staan.
- Weeg de bronnen: verkochte stukken en afgeslagen veilingkavels (Catawiki, veilinghuizen, eBay "verkocht") het zwaarst. Vraagprijzen op Marktplaats, 2dehands en eBay liggen meestal 20-40% boven wat het oplevert. Winkelprijzen van vintagewebshops, Etsy, Pamono en 1stDibs zijn niet representatief.
- Let op maat, decor, staat en of het echt dezelfde maker en hetzelfde model is.${kind === 'zilver' ? '\n- Bij echt zilver is de smeltwaarde (gewicht × gehalte/1000 × zilverprijs) de ondergrens: opkopers betalen 80-95% daarvan. Verzilverd heeft geen smeltwaarde.' : ''}
- Vind je niets bruikbaars, houd dan de eerste schatting aan en zeg dat.
- value_low en value_high in hele euro's. basis: hooguit 3 zinnen, in het Nederlands, met de belangrijkste gevonden prijzen.
- sources: hooguit 4, alleen pagina's die je echt gevonden hebt; kind = "verkocht", "veiling", "vraagprijs" of "overig".`;

export const PRICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['value_low', 'value_high', 'basis', 'sources'],
  properties: {
    value_low: { type: 'number' },
    value_high: { type: 'number' },
    basis: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url', 'price', 'kind'],
        properties: {
          title: { type: 'string' }, url: { type: 'string' }, price: { type: 'string' },
          kind: { type: 'string', enum: ['verkocht', 'veiling', 'vraagprijs', 'overig'] },
        },
      },
    },
  },
};

export function priceText(kind, a, silver) {
  const facts = {
    voorwerp: a.object, maker: a.maker, model_decor: a.line, herkomst: a.origin, periode: a.period, merken: a.marks,
    materiaal: a.material, staat: a.condition, eerste_schatting: `€${a.value_low}-${a.value_high}`, zoekterm: a.search_query,
    ...(kind === 'zilver' ? { gehalte: a.fineness || 'onbekend', geschat_gewicht_g: a.weight_g || 'onbekend' } : {}),
  };
  return `Stuk (uit de beoordeling van de foto's):\n${JSON.stringify(facts, null, 1)}\n${kind === 'zilver' ? silverLine(silver) + '\n' : ''}Zoek vergelijkbare stukken en geef de realistische doorverkoopwaarde.`;
}

export function priceCheck(apiKey, kind, a, { model, silver = null } = {}) {
  return askJson(apiKey, {
    model, system: PRICE_SYSTEM(kind), schema: PRICE_SCHEMA, text: priceText(kind, a, silver), effort: 'low',
    maxTokens: 8000, timeout: 100_000, retries: 0,
    tools: [{
      type: 'web_search_20260318', name: 'web_search', max_uses: 3, response_inclusion: 'excluded',
      user_location: { type: 'approximate', country: 'NL', timezone: 'Europe/Amsterdam' },
    }],
  });
}
